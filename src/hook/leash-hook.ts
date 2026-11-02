import { mkdirSync, readFileSync } from "node:fs";
import { askApp } from "./ask";
import { expireLeashGrants, pruneOldDecisions } from "./sweep";
import { handlePayload } from "./handle";
import { HISTORY_DIR, POPUP_TIMEOUT_S } from "../shared/constants";
import { grantsDbPath, homeDir, socketPath } from "../shared/constants";
import { openGrantsDb, setSetting } from "../shared/db";
import { applyDueClaudeTrust } from "../main/claudeTrust";
import { publishClaudeRules } from "../main/rulesMode";
import { loadClaude } from "../main/agents/claude";
import { join } from "node:path";

export function resolveHookHistoryPath(home = homeDir()): string {
  if (process.env.AGENTIC_LEASH_HISTORY_DB) return process.env.AGENTIC_LEASH_HISTORY_DB;
  if (process.env.AGENTIC_LEASH_HISTORY_DIR) return join(process.env.AGENTIC_LEASH_HISTORY_DIR, "history.db");
  if (process.getuid && process.getuid() !== 0) {
    const dir = join(home, ".agentic-leash");
    mkdirSync(dir, { recursive: true });
    return join(dir, "history.db");
  }
  return join(HISTORY_DIR, "history.db");
}

const invoked = process.argv[1]?.includes("leash-hook");
const named = process.argv[2];
const entry = named === "cursor" || named === "codex" || named === "gemini" || named === "antigravity" || named === "hermes" ? named : "claude";

if (invoked && process.argv.includes("--sweep")) {
  const db = openGrantsDb(grantsDbPath());
  expireLeashGrants(db, Date.now());
  applyDueClaudeTrust(db, join(homeDir(), ".claude.json"), Date.now());
  pruneOldDecisions(db, Date.now());
  setSetting(db, "last_sweep", new Date().toISOString());
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homeDir(), ".claude");
  const mode = loadClaude(claudeDir, join(homeDir(), ".claude.json")).enforcement === "rules";
  publishClaudeRules(db, join(claudeDir, "settings.json"), homeDir(), mode);
  db.close();
  process.exit(0);
}

if (invoked) void (async () => {
  const raw = readFileSync(0, "utf8");
  const db = openGrantsDb(grantsDbPath());
  const home = homeDir();
  const result = await handlePayload({
    entry,
    raw: raw.trim() ? JSON.parse(raw) : {},
    db,
    now: Date.now(),
    home,
    historyPath: resolveHookHistoryPath(home),
    ask: (request) => askApp(socketPath(), request, POPUP_TIMEOUT_S * 1000),
  });
  db.close();
  if (result.stdout) process.stdout.write(result.stdout);
  process.exit(result.exitCode);
})();
