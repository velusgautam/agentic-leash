import { homedir } from "node:os";
import { join } from "node:path";
import { POPUP_TIMEOUT_S } from "./pending";

export { POPUP_TIMEOUT_S };

export const APP_NAME = "Agentic Leash";
export const HISTORY_DIR = "/Library/Application Support/AgenticLeash";
export const IS_MAC = process.platform === "darwin";
export const HOOK_TIMEOUT_S = 150;
export const DEFAULT_TTL_S = 3600;
export const DECISION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const CLAUDE_MATCHER = "Read|Edit|Write|MultiEdit|NotebookEdit|Glob|Grep|Bash|WebFetch|WebSearch|mcp__.*";

export const TTL_PRESETS = [
  { key: "1", label: "15 min", seconds: 15 * 60 },
  { key: "2", label: "1 hour", seconds: 60 * 60 },
  { key: "3", label: "8 hours", seconds: 8 * 60 * 60 },
  { key: "4", label: "Forever", seconds: null },
] as const;

export const TCC_CLIENTS = [
  { agent: "cursor" as const, bundleId: "com.todesktop.230313mzl4w4u92" },
  { agent: "t3-code" as const, bundleId: "com.t3tools.t3code" },
  { agent: "claude-code" as const, bundleId: "com.anthropic.claudefordesktop" },
  // The claude CLI has no bundle; macOS attributes its prompts to the launching terminal.
  { agent: "claude-code" as const, bundleId: "com.apple.Terminal" },
  { agent: "claude-code" as const, bundleId: "com.googlecode.iterm2" },
  { agent: "claude-code" as const, bundleId: "com.mitchellh.ghostty" },
  { agent: "claude-code" as const, bundleId: "dev.warp.Warp-Stable" },
];

export const TCC_LABELS: Record<string, string> = {
  "com.apple.Terminal": "via Terminal",
  "com.googlecode.iterm2": "via iTerm",
  "com.mitchellh.ghostty": "via Ghostty",
  "dev.warp.Warp-Stable": "via Warp",
};

export function isClaudeBinary(client: string): boolean {
  return client.startsWith("/") && (client.split("/").pop() === "claude" || client.includes("/claude-code"));
}

export function homeDir(): string {
  return process.env.AGENTIC_LEASH_HOME || homedir();
}

export function leashDir(home = homeDir()): string {
  return join(home, ".agentic-leash");
}

export function grantsDbPath(home = homeDir()): string {
  return join(leashDir(home), "grants.db");
}

export function socketPath(home = homeDir()): string {
  return join(leashDir(home), "agentic-leash.sock");
}

export function protectedRoots(home = homeDir()): string[] {
  return [leashDir(home), HISTORY_DIR];
}

export const DEFAULT_SKIP_READS = ["node_modules", ".git/objects", "Library/Caches"];
