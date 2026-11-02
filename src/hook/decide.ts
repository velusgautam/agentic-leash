import { autoAllowCovers } from "../shared/autoAllow";
import { isGitDestructiveLocalCommand } from "../shared/commands";
import { hasUnresolved, isSensitive, isUnder } from "../shared/paths";
import { guardedKind, isEgressRequest } from "../shared/policy";
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
  if (opts.godModeUntil && opts.now < opts.godModeUntil && sameAgent(opts.godModeAgent ?? "*")) {
    return { kind: "pass", godMode: true };
  }
  const command = req.command?.trim() ?? "";
  // "Never" beats every grant and rule.
  const blocked = (opts.blocks ?? []).some((block) => sameAgent(block.agent) && (block.kind === "command" ? command === block.value : req.paths.some((path) => isUnder(path, block.value))));
  if (blocked) return { kind: "deny", reason: "You chose Never for this in Agentic Leash" };
  // A session that just read a secret asks before anything that can send it away.
  if ((opts.afterSecret || req.afterSecret) && isEgressRequest(req)) return { kind: "prompt" };
  const home = opts.home ?? "";
  const rules = opts.rules ?? [];
  const live = grants.filter(
    (grant) => sameAgent(grant.agent) && (grant.expiresAt === null || grant.expiresAt > opts.now) && (!grant.sessionId || grant.sessionId === req.sessionId),
  );
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
