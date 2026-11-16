import { autoAllowCovers } from "../shared/autoAllow";
import { isGitDestructiveLocalCommand } from "../shared/commands";
import { sessionAllowsCoverPath } from "../shared/db";
import { expandHome, hasUnresolved, isSensitive, isUnder } from "../shared/paths";
import { guardedKind, isEgressRequest } from "../shared/policy";
import { matchSecureArea, type SecureAreaMatch } from "../shared/secureAreas";
import type { DecideOptions, Grant, HookRequest, PendingRequest, Verdict } from "../shared/types";

export function isDestructiveCommand(command: string): boolean {
  if (!command) return false;
  if (isGitDestructiveLocalCommand(command)) return true;
  const segments = command.split(/[;&|\n]+/);
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    let cmdIdx = 0;
    while (cmdIdx < words.length && /^[a-zA-Z_][a-zA-Z0-9_]*=/.test(words[cmdIdx]!)) {
      cmdIdx++;
    }
    while (cmdIdx < words.length && ["command", "builtin", "nohup", "exec"].includes(words[cmdIdx]!)) {
      cmdIdx++;
    }
    if (cmdIdx >= words.length) continue;
    const rawExe = words[cmdIdx]!;
    const exe = rawExe.split("/").pop() || "";
    const args = words.slice(cmdIdx + 1);

    if (exe === "sudo") return true;
    if (exe === "mkfs" || exe.startsWith("mkfs.")) return true;
    if (exe === "dd" && args.some((a) => a.startsWith("if="))) return true;

    if (exe === "rm") {
      const hasR = args.some((a) => a === "-r" || a === "-R" || a === "--recursive" || (/^-[a-zA-Z]*[rR]/.test(a) && !a.startsWith("--")));
      const hasF = args.some((a) => a === "-f" || a === "--force" || (/^-[a-zA-Z]*f/.test(a) && !a.startsWith("--")));
      if (hasR || hasF) return true;
    }

    if (exe === "chmod" || exe === "chown") {
      if (args.some((a) => a === "-R" || a === "--recursive" || (/^-[a-zA-Z]*R/.test(a) && !a.startsWith("--")))) {
        return true;
      }
    }

    if (exe === "git") {
      const sub = args[0];
      const rest = args.slice(1);
      if (sub === "push" && rest.some((a) => a === "--force" || a === "-f" || a === "--force-with-lease")) return true;
      if (sub === "reset" && rest.some((a) => a === "--hard")) return true;
      if (sub === "clean" && rest.some((a) => a === "-f" || a === "--force" || (/^-[a-zA-Z]*f/.test(a) && !a.startsWith("--")))) return true;
    }
  }
  return false;
}

export function decide(req: HookRequest, grants: Grant[], opts: DecideOptions): Verdict {
  if (opts.lockdown) return { kind: "deny", reason: "Agentic Leash lockdown is on" };
  if (req.paths.some((path) => opts.protectedRoots.some((root) => isUnder(path, root)))) {
    return { kind: "deny", reason: "Agentic Leash protects its own files" };
  }
  const sameAgent = (agent: string) => agent === "*" || agent === req.agent;
  const command = req.command?.trim() ?? "";
  const home = opts.home ?? "";
  const rules = opts.rules ?? [];
  const live = grants.filter(
    (grant) => sameAgent(grant.agent) && (grant.expiresAt === null || grant.expiresAt > opts.now) && (!grant.sessionId || grant.sessionId === req.sessionId),
  );

  // v0.9 Secure Areas engine: God Mode is permanently on outside Secure Areas.
  if (opts.secureAreas !== undefined) {
    const matches = req.paths
      .map((path) => ({ path, match: matchSecureArea(path, req.access, home, opts.secureAreas!) }))
      .filter((item): item is { path: string; match: SecureAreaMatch } => item.match !== null);

    const blockedArea = matches.find((item) => item.match.rule === "block");
    if (blockedArea) {
      return {
        kind: "deny",
        reason: `Blocked by Secure Area: ${blockedArea.match.area.label}`,
        matchedSecureArea: blockedArea.match.area,
      };
    }

    const blockedByNever = (opts.blocks ?? []).some(
      (block) => sameAgent(block.agent) && (block.kind === "command" ? command === block.value : req.paths.some((path) => isUnder(path, block.value))),
    );
    if (blockedByNever) return { kind: "deny", reason: "You chose Never for this in Agentic Leash" };

    const sessionAllows = opts.sessionAllows ?? [];
    const uncoveredAsk = matches.filter((item) => {
      if (item.match.rule !== "ask") return false;
      if (
        sessionAllowsCoverPath(sessionAllows, {
          path: item.path,
          agent: req.agent,
          sessionId: req.sessionId,
          access: req.access,
          now: opts.now,
          home,
        })
      ) {
        return false;
      }
      const target = home ? expandHome(item.path, home) : item.path;
      const coveredByGrant = live.some(
        (grant) =>
          grant.command == null &&
          (grant.access === "write" || req.access === "read") &&
          isUnder(target, home ? expandHome(grant.path, home) : grant.path),
      );
      return !coveredByGrant;
    });

    if (uncoveredAsk.length > 0) {
      const preferred = uncoveredAsk.find((item) => item.match.area.group === "secrets") ?? uncoveredAsk[0]!;
      return { kind: "prompt", matchedSecureArea: preferred.match.area };
    }

    const guardDestructive = opts.guardDestructiveCommands ?? true;
    if (guardDestructive && command && isDestructiveCommand(command)) {
      const allowedByRule = rules.some((rule) => rule.kind === "command" && sameAgent(rule.agent) && rule.value.trim() === command);
      const allowedByGrant = live.some((grant) => grant.command != null && grant.command.trim() === command);
      if (!allowedByRule && !allowedByGrant) {
        return { kind: "prompt" };
      }
    }

    const guardEgress = opts.guardEgressAfterSecret ?? true;
    if (guardEgress && (opts.afterSecret || req.afterSecret) && isEgressRequest(req)) {
      return { kind: "prompt" };
    }

    return { kind: "pass", godMode: true };
  }

  // Legacy pre-v0.9 fallback when opts.secureAreas is omitted.
  if (opts.godModeUntil && opts.now < opts.godModeUntil && sameAgent(opts.godModeAgent ?? "*")) {
    return { kind: "pass", godMode: true };
  }
  // "Never" beats every grant and rule.
  const blocked = (opts.blocks ?? []).some((block) => sameAgent(block.agent) && (block.kind === "command" ? command === block.value : req.paths.some((path) => isUnder(path, block.value))));
  if (blocked) return { kind: "deny", reason: "You chose Never for this in Agentic Leash" };
  // A session that just read a secret asks before anything that can send it away.
  if ((opts.afterSecret || req.afterSecret) && isEgressRequest(req)) return { kind: "prompt" };
  const autoAccept = Boolean(opts.autoAcceptModeUntil && opts.now < opts.autoAcceptModeUntil && sameAgent(opts.autoAcceptModeAgent ?? "*"));
  const isDestructive = Boolean(command && isDestructiveCommand(command));
  const hasGuardedPath = req.paths.some((path) => guardedKind(path, req.access, home) !== null || isSensitive(path, home));
  const hasUnresolvedVars = hasUnresolved(req.paths) || (Boolean(command) && command.includes("$"));
  if (autoAccept && !isDestructive && !hasUnresolvedVars && !hasGuardedPath) {
    return { kind: "pass", autoAcceptMode: true };
  }
  if (command) {
    const hit = live.find((grant) => grant.command != null && grant.command.trim() === command);
    if (hit) return { kind: "pass", grantIds: [hit.id] };
    if (rules.some((rule) => rule.kind === "command" && sameAgent(rule.agent) && rule.value.trim() === command)) return { kind: "pass" };
    if (isGitDestructiveLocalCommand(command) || (autoAccept && (isDestructive || hasUnresolvedVars))) return { kind: "prompt" };
  }
  if (req.paths.length === 0) return { kind: "pass" };
  // A literal `$d` grant must never stand in for whatever `$d` expands to.
  if (hasUnresolvedVars) return { kind: "prompt" };
  const used = new Set<number>();
  const covered = req.paths.every((path) => {
    // Secrets and startup files need a grant on themselves or a secret folder, not on a parent.
    const guarded = guardedKind(path, req.access, home) !== null || isSensitive(path, home);
    const reaches = (root: string) => isUnder(path, root) && (!guarded || guardedKind(root, req.access, home) !== null || isSensitive(root, home));
    const grant = live.find((item) => item.command == null && reaches(item.path) && (item.access === "write" || req.access === "read"));
    if (grant) {
      used.add(grant.id);
      return true;
    }
    if (rules.some((rule) => rule.kind === "folder" && sameAgent(rule.agent) && reaches(rule.value))) return true;
    return !guarded && autoAllowCovers(req.agent, path, req.access, opts.autoAllowOff ?? []);
  });
  return covered ? { kind: "pass", grantIds: [...used] } : { kind: "prompt" };
}

export function coveredPending(pending: PendingRequest[], grants: Grant[], opts: DecideOptions): string[] {
  return pending.filter((item) => decide(item.request, grants, opts).kind === "pass").map((item) => item.id);
}
