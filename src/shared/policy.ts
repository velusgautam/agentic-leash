import { isEgressCommand, isGitDestructiveLocalCommand, isReadOnlyCommand } from "./commands";
import { parentFolders } from "./parents";
import { hasUnresolved, normalise } from "./paths";
import { personalKind, secretKind, startupKind } from "./sensitive";
import { PRESET_ORDER } from "./presets";
import type { Access, HookRequest, PresetId, RequestPolicy } from "./types";

export { APPROVAL_PRESETS, isPresetId, presetById, presetFromSeconds, presetLabel, SESSION_IDLE_S, SESSION_MAX_S, todayExpiry } from "./presets";

export const AFTER_SECRET_MS = 15 * 60 * 1000;


/** A secret path, or a startup file being written. No parent-folder grant reaches these. */
export function guardedKind(path: string, access: Access, home: string): string | null {
  const file = normalise(path, home, home);
  return secretKind(file, home) ?? (access === "write" ? startupKind(file, home) : null);
}

const WEB_TOOLS = new Set(["WebFetch", "WebSearch", "web_fetch", "google_web_search"]);

export function isEgressRequest(req: HookRequest): boolean {
  if (req.url || WEB_TOOLS.has(req.tool) || req.tool.startsWith("mcp") || req.event === "beforeMCPExecution") return true;
  return Boolean(req.command && isEgressCommand(req.command));
}

const DESTRUCTIVE = /(^|[\s;&|])(rm\s+-[a-zA-Z]*[rf]|sudo\s|chmod\s+-R|chown\s+-R|git\s+push\s+.*--force|git\s+reset\s+--hard|git\s+clean\s+-[a-zA-Z]*f|mkfs|dd\s+if=)/;

function summaryOf(req: HookRequest): string {
  if (req.command) return isReadOnlyCommand(req.command) ? "run a read-only command" : "run a command";
  if (req.url) return "fetch a web page";
  if (WEB_TOOLS.has(req.tool)) return "search the web";
  if (req.tool.startsWith("mcp") || req.event === "beforeMCPExecution") return "use an MCP tool";
  const what = req.paths.length > 1 ? `${req.paths.length} files` : "a file";
  return req.access === "write" ? `change ${what}` : `read ${what}`;
}

/**
 * How long a request may be allowed, which choice is picked first, and how risky it looks.
 * `repoRoot` finds the git repo holding a path, or null.
 */
export function requestPolicy(req: HookRequest, home: string, repoRoot: (path: string) => string | null): RequestPolicy {
  const summary = summaryOf(req);
  const reasons: string[] = [];
  const destructive = Boolean(req.command && DESTRUCTIVE.test(req.command));
  if (destructive) reasons.push("Deletes, force-pushes, or changes permissions");
  const base = { summary, scope: null, repo: null, exact: false };

  const secret = req.paths.map((path) => secretKind(normalise(path, home, home), home)).find(Boolean) ?? null;
  if (secret) {
    reasons.unshift(`Touches ${secret.toLowerCase()}`);
    return { ...base, kind: "secret", label: secret, presets: ["once"], preset: "once", exact: true, risk: "high", reasons };
  }
  if (req.afterSecret && isEgressRequest(req)) {
    reasons.unshift("This session read a secret in the last 15 minutes");
    return { ...base, kind: "egress", label: null, presets: ["once"], preset: "once", risk: "high", reasons };
  }
  const startup = req.access === "write" ? req.paths.map((path) => startupKind(normalise(path, home, home), home)).find(Boolean) ?? null : null;
  if (startup) {
    reasons.unshift(`Changes a ${startup.toLowerCase()} file that runs code later`);
    return { ...base, kind: "startup", label: startup, presets: ["once"], preset: "once", exact: true, risk: "high", reasons };
  }

  if (hasUnresolved(req.paths)) {
    reasons.unshift("Uses a variable the folder can't be worked out from");
    return { ...base, kind: "other", label: null, presets: ["once"], preset: "once", exact: true, risk: destructive ? "high" : "medium", reasons };
  }

  if (req.command && isGitDestructiveLocalCommand(req.command)) {
    reasons.unshift("Destructive git operation that permanently discards uncommitted work or untracked files");
    return { ...base, kind: "other", label: "Git destructive", presets: ["once"], preset: "once", exact: true, risk: "high", reasons };
  }

  const roots = req.paths.map(repoRoot);
  const repo = roots.length && roots.every((root) => root && root === roots[0]) ? roots[0]! : null;
  const personal = repo ? null : req.paths.map((path) => personalKind(normalise(path, home, home), home)).find(Boolean) ?? null;
  const egress = isEgressRequest(req);
  if (egress && !req.paths.length) reasons.push(req.url ? `Sends a request to ${hostOf(req.url)}` : "Can reach the network");
  else if (egress) reasons.push("Can send data off this machine");
  const risk = destructive ? "high" : req.access === "write" || egress || personal ? "medium" : "low";

  if (personal) {
    reasons.unshift(`Inside your ${personal} folder`);
    return { ...base, kind: "personal", label: personal, presets: ["once", "15m"], preset: "once", risk, reasons };
  }
  const scope = repo && parentFolders(req.paths).includes(repo) ? repo : null;
  if (repo) reasons.unshift(`Inside the ${repo.split("/").pop()} repo`);
  // In a repo the long choice is "Always in repo"; elsewhere it is "Today".
  const presets: PresetId[] = repo ? ["once", "session", "repo"] : ["once", "session", "today"];
  return { ...base, kind: repo ? "project" : "other", label: repo, presets, preset: "session", scope, repo, risk, reasons };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Keeps an approval inside what the policy allows, picking the nearest shorter choice. */
export function clampPreset(policy: RequestPolicy, wanted: PresetId): PresetId {
  if (policy.presets.includes(wanted)) return wanted;
  const order = PRESET_ORDER.indexOf(wanted);
  const shorter = policy.presets.filter((id) => PRESET_ORDER.indexOf(id) <= order);
  return shorter.at(-1) ?? policy.preset;
}
