import { autoAllowCovers } from "../shared/autoAllow";
import {
  analyzeCommand,
  DEFAULT_TRUSTED_HOSTS,
  isGitDestructiveLocalCommand,
  isHostTrusted,
  type CommandAnalysis,
} from "../shared/commands";
import type { ContentFinding } from "../shared/contentScan";
import { DEFAULT_CONTENT_GUARD_SETTINGS, sessionAllowsCoverPath } from "../shared/db";
import { expandHome, hasUnresolved, isSensitive, isUnder } from "../shared/paths";
import { guardedKind, isEgressRequest } from "../shared/policy";
import { matchSecureArea, type SecureAreaMatch } from "../shared/secureAreas";
import type {
  ContentGuardLane,
  ContentGuardSettings,
  DecideOptions,
  Grant,
  HookRequest,
  PendingRequest,
  Verdict,
} from "../shared/types";

export interface ExtendedDecideOptions extends DecideOptions {
  trustedHosts?: string[];
  contentGuards?: ContentGuardSettings;
  contentFindings?: ContentFinding[];
}

export function isDestructiveCommand(command: string): boolean {
  if (!command) return false;
  return analyzeCommand(command).isDestructive;
}

function laneForCategory(category: ContentFinding["category"], guards: ContentGuardSettings): ContentGuardLane {
  if (category === "secret") return guards.secrets;
  if (category === "pci") return guards.pci;
  if (category === "pii") return guards.pii;
  return guards.phi;
}

function parseHostname(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname || null;
  } catch {
    return null;
  }
}

function isEgressDestinationTrusted(
  req: HookRequest,
  analysis: CommandAnalysis | null,
  trustedHosts: readonly string[],
): boolean {
  const hasUrl = Boolean(req.url && req.url.trim().length > 0);
  const hasCmd = Boolean(req.command && req.command.trim().length > 0);
  if (!hasUrl && !hasCmd) {
    // Unknown destination (e.g., mcp* / beforeMCPExecution / WebSearch without URL)
    return false;
  }
  if (hasUrl) {
    const host = parseHostname(req.url!.trim());
    if (!host || !isHostTrusted(host, trustedHosts)) {
      return false;
    }
  }
  if (hasCmd) {
    if (!analysis || !analysis.hasTrustedEgressOnly || analysis.hasUnknownEgress) {
      return false;
    }
  }
  return true;
}

function findingsByLane(
  findings: readonly ContentFinding[],
  guards: ContentGuardSettings,
  lane: ContentGuardLane,
): ContentFinding | undefined {
  return findings.find((finding) => laneForCategory(finding.category, guards) === lane);
}

export function decide(req: HookRequest, grants: Grant[], opts: ExtendedDecideOptions): Verdict {
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
  const trustedHosts = opts.trustedHosts ?? [...DEFAULT_TRUSTED_HOSTS];
  const contentGuards: ContentGuardSettings = opts.contentGuards ?? { ...DEFAULT_CONTENT_GUARD_SETTINGS };
  const contentFindings = opts.contentFindings ?? [];
  const analysis = command ? analyzeCommand(command, trustedHosts) : null;

  const allowedByCommandRule = Boolean(
    command && rules.some((rule) => rule.kind === "command" && sameAgent(rule.agent) && rule.value.trim() === command),
  );
  const allowedByCommandGrant = Boolean(
    command && live.some((grant) => grant.command != null && grant.command.trim() === command),
  );
  const commandExplicitlyAllowed = allowedByCommandRule || allowedByCommandGrant;

  const sessionAllows = opts.sessionAllows ?? [];
  const exactTargetsCovered = (): boolean => {
    if (command && commandExplicitlyAllowed) return true;
    if (req.paths.length === 0) return false;
    return req.paths.every((path) => {
      const target = home ? expandHome(path, home) : path;
      const coveredBySession = sessionAllows.some((allow) => {
        if (allow.agent !== "*" && allow.agent !== req.agent) return false;
        if (allow.expiresAt !== null && allow.expiresAt <= opts.now) return false;
        if (allow.sessionId && allow.sessionId !== req.sessionId) return false;
        if (allow.access !== "write" && req.access === "write") return false;
        const allowPath = home ? expandHome(allow.path, home) : allow.path;
        return allowPath === target;
      });
      if (coveredBySession) return true;
      return live.some((grant) => {
        if (grant.command != null) return false;
        if (grant.access !== "write" && req.access !== "read") return false;
        const grantPath = home ? expandHome(grant.path, home) : grant.path;
        return grantPath === target;
      });
    });
  };

  // v0.9+ Secure Areas engine: God Mode is permanently on outside Secure Areas.
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

    const blockedFinding = findingsByLane(contentFindings, contentGuards, "block");
    if (blockedFinding) {
      return {
        kind: "deny",
        reason: `Blocked by Content Guardrail: ${blockedFinding.label} (${blockedFinding.preview})`,
      };
    }

    const uncoveredAsk = matches.filter((item) => {
      if (item.match.rule !== "ask") return false;
      const isGuardedArea =
        item.match.area.group === "secrets" ||
        item.match.area.group === "project_secrets" ||
        (item.match.area.group === "startup" && req.access === "write");
      const target = home ? expandHome(item.path, home) : item.path;
      const applicableAllows = isGuardedArea
        ? sessionAllows.filter((allow) => {
            const allowPath = home ? expandHome(allow.path, home) : allow.path;
            return allowPath === target || guardedKind(allowPath, req.access, home) !== null;
          })
        : sessionAllows;
      if (
        sessionAllowsCoverPath(applicableAllows, {
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
      const coveredByGrant = live.some((grant) => {
        if (grant.command != null) return false;
        if (grant.access !== "write" && req.access !== "read") return false;
        const grantPath = home ? expandHome(grant.path, home) : grant.path;
        if (!isUnder(target, grantPath)) return false;
        if (isGuardedArea) {
          return grantPath === target || guardedKind(grantPath, req.access, home) !== null;
        }
        return true;
      });
      return !coveredByGrant;
    });

    if (uncoveredAsk.length > 0) {
      const preferred = uncoveredAsk.find((item) => item.match.area.group === "secrets") ?? uncoveredAsk[0]!;
      return { kind: "prompt", matchedSecureArea: preferred.match.area };
    }

    if (contentGuards.pipeToShell && analysis?.isPipeToShell && !commandExplicitlyAllowed) {
      return { kind: "prompt" };
    }

    const guardDestructive = opts.guardDestructiveCommands ?? true;
    if (guardDestructive && analysis?.isDestructive && !commandExplicitlyAllowed) {
      return { kind: "prompt" };
    }

    const askFinding = findingsByLane(contentFindings, contentGuards, "ask");
    if (askFinding && !exactTargetsCovered()) {
      return { kind: "prompt" };
    }

    const guardEgress = opts.guardEgressAfterSecret ?? true;
    if (guardEgress && (opts.afterSecret || req.afterSecret) && isEgressRequest(req)) {
      const trusted = isEgressDestinationTrusted(req, analysis, trustedHosts);
      if (!trusted || contentFindings.length > 0) {
        return { kind: "prompt" };
      }
    }

    const warnArea = matches.find((item) => item.match.rule === "warn");
    if (warnArea) {
      return {
        kind: "warn",
        reason: `Warning from Secure Area: ${warnArea.match.area.label}`,
        area: warnArea.match.area,
      };
    }

    const warnFinding = findingsByLane(contentFindings, contentGuards, "warn");
    if (warnFinding) {
      return {
        kind: "warn",
        reason: `Content Guardrail warning: ${warnFinding.label} (${warnFinding.preview})`,
      };
    }

    const monitorArea = matches.find((item) => item.match.rule === "monitor");
    if (monitorArea) {
      return {
        kind: "monitor",
        reason: `Monitored by Secure Area: ${monitorArea.match.area.label}`,
        area: monitorArea.match.area,
      };
    }

    const monitorFinding = findingsByLane(contentFindings, contentGuards, "monitor");
    if (monitorFinding) {
      return {
        kind: "monitor",
        reason: `Content Guardrail monitored: ${monitorFinding.label} (${monitorFinding.preview})`,
      };
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

  const blockedFinding = findingsByLane(contentFindings, contentGuards, "block");
  if (blockedFinding) {
    return {
      kind: "deny",
      reason: `Blocked by Content Guardrail: ${blockedFinding.label} (${blockedFinding.preview})`,
    };
  }

  // A session that just read a secret asks before anything that can send it away to an untrusted host or with findings.
  if ((opts.afterSecret || req.afterSecret) && isEgressRequest(req)) {
    const trusted = isEgressDestinationTrusted(req, analysis, trustedHosts);
    if (!trusted || contentFindings.length > 0) {
      return { kind: "prompt" };
    }
  }

  if (contentGuards.pipeToShell && analysis?.isPipeToShell && !commandExplicitlyAllowed) {
    return { kind: "prompt" };
  }

  const askFinding = findingsByLane(contentFindings, contentGuards, "ask");
  if (askFinding && !exactTargetsCovered()) {
    return { kind: "prompt" };
  }

  const autoAccept = Boolean(opts.autoAcceptModeUntil && opts.now < opts.autoAcceptModeUntil && sameAgent(opts.autoAcceptModeAgent ?? "*"));
  const isDestructive = Boolean(analysis?.isDestructive);
  const hasGuardedPath = req.paths.some((path) => guardedKind(path, req.access, home) !== null || isSensitive(path, home));
  const hasUnresolvedVars = hasUnresolved(req.paths) || (Boolean(command) && command.includes("$"));
  if (autoAccept && !isDestructive && !hasUnresolvedVars && !hasGuardedPath) {
    const warnFinding = findingsByLane(contentFindings, contentGuards, "warn");
    if (warnFinding) return { kind: "warn", reason: `Content Guardrail warning: ${warnFinding.label} (${warnFinding.preview})` };
    const monitorFinding = findingsByLane(contentFindings, contentGuards, "monitor");
    if (monitorFinding) return { kind: "monitor", reason: `Content Guardrail monitored: ${monitorFinding.label} (${monitorFinding.preview})` };
    return { kind: "pass", autoAcceptMode: true };
  }
  if (command) {
    const hit = live.find((grant) => grant.command != null && grant.command.trim() === command);
    if (hit) return { kind: "pass", grantIds: [hit.id] };
    if (rules.some((rule) => rule.kind === "command" && sameAgent(rule.agent) && rule.value.trim() === command)) return { kind: "pass" };
    if (isGitDestructiveLocalCommand(command) || (autoAccept && (isDestructive || hasUnresolvedVars))) return { kind: "prompt" };
  }
  if (req.paths.length === 0) {
    const warnFinding = findingsByLane(contentFindings, contentGuards, "warn");
    if (warnFinding) return { kind: "warn", reason: `Content Guardrail warning: ${warnFinding.label} (${warnFinding.preview})` };
    const monitorFinding = findingsByLane(contentFindings, contentGuards, "monitor");
    if (monitorFinding) return { kind: "monitor", reason: `Content Guardrail monitored: ${monitorFinding.label} (${monitorFinding.preview})` };
    return { kind: "pass" };
  }
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
  if (!covered) return { kind: "prompt" };
  const warnFinding = findingsByLane(contentFindings, contentGuards, "warn");
  if (warnFinding) return { kind: "warn", reason: `Content Guardrail warning: ${warnFinding.label} (${warnFinding.preview})` };
  const monitorFinding = findingsByLane(contentFindings, contentGuards, "monitor");
  if (monitorFinding) return { kind: "monitor", reason: `Content Guardrail monitored: ${monitorFinding.label} (${monitorFinding.preview})` };
  return { kind: "pass", grantIds: [...used] };
}

export function coveredPending(pending: PendingRequest[], grants: Grant[], opts: ExtendedDecideOptions): string[] {
  return pending
    .filter((item) => {
      const kind = decide(item.request, grants, opts).kind;
      return kind === "pass" || kind === "warn" || kind === "monitor";
    })
    .map((item) => item.id);
}
