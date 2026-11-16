import { matchesIgnored } from "./ignored";
import { KEYCHAIN_SAFE_BUFFER, secretKind } from "./sensitive";

// Agent machinery and OS scratch. A sensitive path stays visible even inside one of these.
const DIRS = [
  "/.git",
  "/.git/objects",
  "/node_modules",
  "/.pnpm-store",
  "/.build",
  "/dist",
  "/out",
  "/build",
  "/DerivedData",
  "/.cache",
  "/Library/Caches",
  "/Library/Logs",
  "/private/var/folders",
  "/var/folders",
  "/.claude/projects",
  "/.claude/plugins",
  "/.claude/debug",
  "/.claude/cache",
  "/.claude/statsig",
  "/.claude/telemetry",
  "/.claude/shell-snapshots",
  "/.claude/todos",
  "/.claude/session-env",
  "/.claude/ide",
  "/.claude/skills/synced",
  "/.cursor/projects",
  "/.cursor/ai-tracking",
  "/Cursor/logs",
  "/Cursor/Cache",
  "/Cursor/CachedData",
  "/.npm/_logs",
  "/.npm/_cacache",
  "/agent-transcripts",
  "/.codex/sessions",
  "/.gemini/tmp",
  "/.gemini/antigravity/brain",
  "/.gemini/antigravity-cli/brain",
  "/.gemini/antigravity-cli/cache",
  "/.gemini/antigravity-cli/log",
  "/.gemini/antigravity-cli/crashes",
  "/.gemini/antigravity-ide/brain",
  "/.gemini/sandbox",
];

const PREFIXES = ["/dev/", "/tmp/", "/private/tmp/", "/private/var/db/", "/System/", "/usr/", "/opt/homebrew/", "/Library/", "/Applications/"];

const NAMES = [".DS_Store", ".last-complete-round", ".localized", ".CFUserTextEncoding"];

const SUFFIXES = [".tmp", ".temp", ".swp", ".swo", "-wal", "-shm", "-journal"];

const JUNK_PREFIXES = ["/dev/"];
const KEYCHAIN_LOCK_RE = /(?:^|\/)Library\/Keychains\/\.fl[^/]*$/;
const KEYCHAIN_SB_RE = /(?:^|\/)Library\/Keychains\/login\.keychain-db\.sb-/;
const KEYCHAIN_REFRESH_RE = /(?:^|\/)Library\/Keychains\/(?:login\.keychain-db|\.fl[^/]*)$/;

export function isKeychainSafeBuffer(path: string): boolean {
  return KEYCHAIN_SAFE_BUFFER.test(path) || KEYCHAIN_SB_RE.test(path);
}

export function isKeychainLockFile(path: string): boolean {
  return KEYCHAIN_LOCK_RE.test(path);
}

export function isKeychainTokenRefresh(exe: string | undefined, path: string): boolean {
  return exe === "/usr/bin/security" && KEYCHAIN_REFRESH_RE.test(path);
}

export function isSqliteSideFile(path: string): boolean {
  const lower = base(path).toLowerCase();
  return lower.endsWith("-wal") || lower.endsWith("-shm") || lower.endsWith("-journal");
}

export function isRecursiveSummaryPath(path: string): boolean {
  return /\(\d+ files read\)$/.test(path);
}

function base(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

// The root helper has no single home, so take it from the path itself.
function homeOf(path: string): string {
  return /^\/(?:Users|home)\/[^/]+/.exec(path)?.[0] ?? "/nonexistent-home";
}

function personal(path: string): boolean {
  return secretKind(path, homeOf(path)) !== null;
}

function scratch(path: string): boolean {
  if (PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  if (DIRS.some((dir) => path.includes(`${dir}/`) || path.endsWith(dir))) return true;
  const name = base(path);
  if (NAMES.includes(name) || name.endsWith("~")) return true;
  const lower = name.toLowerCase();
  return SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

export function isNoise(path: string): boolean {
  return !personal(path) && (scratch(path) || isKeychainSafeBuffer(path));
}

export function isJunk(path: string): boolean {
  if (JUNK_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  if (isKeychainSafeBuffer(path) || isKeychainLockFile(path)) return true;
  const name = base(path);
  if (NAMES.includes(name) || name.endsWith("~")) return true;
  const lower = name.toLowerCase();
  return SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function tmpPath(path: string): boolean {
  return path === "/tmp" || path === "/private/tmp" || path.startsWith("/tmp/") || path.startsWith("/private/tmp/");
}

export interface BucketOptions {
  verboseCapture?: boolean;
}

export function eventBucket(
  event: { kind: string; path: string; destPath?: string | null; source?: string; sensitive?: boolean; exe?: string },
  ignored: readonly string[] = [],
  options?: BucketOptions,
): "main" | "noise" | "drop" {
  if (ignored.some((prefix) => matchesIgnored(event.path, prefix) || (event.destPath ? matchesIgnored(event.destPath, prefix) : false))) return "drop";
  if (isKeychainSafeBuffer(event.path)) return "drop";
  if (event.source === "hook") return "main";
  if (event.kind === "net") return "main";
  if (event.kind === "exec") return "drop";
  if (event.source !== "hook" && isKeychainTokenRefresh(event.exe, event.path)) return "main";
  if (isKeychainLockFile(event.path)) return "drop";
  if (isSqliteSideFile(event.path) || base(event.path) === ".CFUserTextEncoding") return "drop";
  if (personal(event.path) || (event.destPath ? personal(event.destPath) : false)) return "main";
  if (isJunk(event.path)) return "drop";
  if (event.kind === "read" && isRecursiveSummaryPath(event.path)) return "main";
  if (options?.verboseCapture === false && event.kind === "read" && event.source === "eslogger" && !event.sensitive) return "drop";
  if (!isNoise(event.path)) return "main";
  if (event.kind === "read") return tmpPath(event.path) ? "noise" : "drop";
  return "noise";
}
