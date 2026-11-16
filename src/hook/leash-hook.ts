import { mkdirSync, readFileSync } from "node:fs";
import { askApp } from "./ask";
import { expireLeashGrants, pruneOldDecisions } from "./sweep";
import { handlePayload } from "./handle";
import { HISTORY_DIR, POPUP_TIMEOUT_S } from "../shared/constants";
import { grantsDbPath, homeDir, socketPath } from "../shared/constants";
import { checkpointGrantsDb, openGrantsDb, recordHealthWarning, setSetting } from "../shared/db";
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
  const home = homeDir();
  try {
    const db = openGrantsDb(grantsDbPath(home));
    try {
      expireLeashGrants(db, Date.now());
      applyDueClaudeTrust(db, join(home, ".claude.json"), Date.now());
      pruneOldDecisions(db, Date.now());
      setSetting(db, "last_sweep", new Date().toISOString());
      const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
      const mode = loadClaude(claudeDir, join(home, ".claude.json")).enforcement === "rules";
      publishClaudeRules(db, join(claudeDir, "settings.json"), home, mode);
      try {
        checkpointGrantsDb(db);
      } catch {
        /* ignore checkpoint error */
      }
    } finally {
      db.close();
    }
  } catch (error) {
    recordHealthWarning(null, { ts: Date.now(), message: `Sweep failed: ${error instanceof Error ? error.message : String(error)}` }, home);
  }
  process.exit(0);
}

if (invoked) void (async () => {
  const raw = readFileSync(0, "utf8");
  const home = homeDir();
  const db = openGrantsDb(grantsDbPath(home));
  const result = await handlePayload({
    entry,
    raw: raw.trim() ? JSON.parse(raw) : {},
    db,
    now: Date.now(),
    home,
    historyPath: resolveHookHistoryPath(home),
    ask: (request) => askApp(socketPath(), request, POPUP_TIMEOUT_S * 1000),
  });
  try {
    checkpointGrantsDb(db);
  } catch {
    /* ignore checkpoint error */
  }
  db.close();
  if (result.stdout) process.stdout.write(result.stdout);
  process.exit(result.exitCode);
})();
