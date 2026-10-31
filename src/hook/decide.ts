import { autoAllowCovers } from "../shared/autoAllow";
import { isGitDestructiveLocalCommand } from "../shared/commands";
import { hasUnresolved, isSensitive, isUnder } from "../shared/paths";
import { guardedKind, isEgressRequest } from "../shared/policy";
import type { DecideOptions, Grant, HookRequest, PendingRequest, Verdict } from "../shared/types";

const DESTRUCTIVE_CMD = /(^|[\s;&|])(rm\s+-[a-zA-Z]*[rf]|sudo\s|chmod\s+-R|chown\s+-R|git\s+push\s+.*--force|git\s+reset\s+--hard|git\s+clean\s+-[a-zA-Z]*f|mkfs|dd\s+if=)/;

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
  const isDestructive = Boolean(command && (isGitDestructiveLocalCommand(command) || DESTRUCTIVE_CMD.test(command)));
  const hasGuardedPath = req.paths.some((path) => guardedKind(path, req.access, home) !== null || isSensitive(path, home));
  if (autoAccept && !isDestructive && !hasUnresolved(req.paths) && !hasGuardedPath) {
    return { kind: "pass", autoAcceptMode: true };
  }
  if (command) {
    const hit = live.find((grant) => grant.command != null && grant.command.trim() === command);
    if (hit) return { kind: "pass", grantIds: [hit.id] };
    if (rules.some((rule) => rule.kind === "command" && sameAgent(rule.agent) && rule.value.trim() === command)) return { kind: "pass" };
    if (isGitDestructiveLocalCommand(command) || (autoAccept && isDestructive)) return { kind: "prompt" };
  }
  if (req.paths.length === 0) return { kind: "pass" };
  // A literal `$d` grant must never stand in for whatever `$d` expands to.
  if (hasUnresolved(req.paths)) return { kind: "prompt" };
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
