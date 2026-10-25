import { mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { recordHelperMeta, shouldReloadHelper } from "../../src/helper/leash-helper";
import { openHistoryDb } from "../../src/helper/historyDb";
import { isHelperRestartNeeded, parseLaunchdPid, readHelperMeta } from "../../src/main/helperInstall";
import { setSetting } from "../../src/shared/db";

describe("helper self-reload detection", () => {
  it("detects when script file mtime or inode changes on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "al-helper-reload-"));
    const script = join(dir, "leash-helper.js");
    writeFileSync(script, "console.log('v1');");
    const st1 = statSync(script);
    const initial = { ino: Number(st1.ino), mtimeMs: st1.mtimeMs };

    // Unchanged
    expect(shouldReloadHelper(script, initial, null, Date.now())).toEqual({ reload: false });

    // Modified mtime with size > 0
    const newTime = new Date(Date.now() + 5000);
    utimesSync(script, newTime, newTime);
    expect(shouldReloadHelper(script, initial, null, Date.now())).toEqual({
      reload: true,
      reason: "updated",
    });

    // Inode change (simulated via different inode number)
    expect(shouldReloadHelper(script, { ino: initial.ino + 1, mtimeMs: statSync(script).mtimeMs }, null, Date.now())).toEqual({
      reload: true,
      reason: "updated",
    });

    // Empty file (size 0) during writing should not trigger reload
    const emptyScript = join(dir, "empty.js");
    writeFileSync(emptyScript, "");
    expect(shouldReloadHelper(emptyScript, initial, null, Date.now())).toEqual({ reload: false });
  });

  it("detects helper_restart_requested in grants db when newer than startedAt", () => {
    const dir = mkdtempSync(join(tmpdir(), "al-helper-grants-"));
    const dbPath = join(dir, "grants.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

    const startedAt = 100000;
    // No request yet
    expect(shouldReloadHelper("", null, db, startedAt)).toEqual({ reload: false });

    // Request from before startedAt
    setSetting(db, "helper_restart_requested", "50000");
    expect(shouldReloadHelper("", null, db, startedAt)).toEqual({ reload: false });

    // Request newer than startedAt
    setSetting(db, "helper_restart_requested", "100001");
    expect(shouldReloadHelper("", null, db, startedAt)).toEqual({
      reload: true,
      reason: "requested",
    });

    db.close();
  });
});

describe("helper startup metadata in history.db", () => {
  it("records helper_started_at, helper_pid, and helper_script_mtime in meta table", () => {
    const dir = mkdtempSync(join(tmpdir(), "al-helper-meta-"));
    const historyPath = join(dir, "history.db");
    const scriptPath = join(dir, "leash-helper.js");
    writeFileSync(scriptPath, "console.log('helper');");
    const scriptStat = statSync(scriptPath);

    const startedAt = 123456789;
    const testPid = 9999;
    const db = openHistoryDb(historyPath);
    recordHelperMeta(db, startedAt, testPid, scriptStat.mtimeMs);

    const rows = db.prepare("SELECT key, value FROM meta WHERE key LIKE 'helper_%'").all() as { key: string; value: string }[];
    db.close();

    const map = new Map(rows.map((r) => [r.key, r.value]));
    expect(map.has("helper_started_at")).toBe(true);
    expect(Number(map.get("helper_started_at"))).toBe(startedAt);

    expect(map.has("helper_pid")).toBe(true);
    expect(Number(map.get("helper_pid"))).toBe(testPid);

    expect(map.has("helper_script_mtime")).toBe(true);
    expect(Number(map.get("helper_script_mtime"))).toBeCloseTo(scriptStat.mtimeMs, -1);
  });
});

describe("helperInstall metadata & restart check", () => {
  it("parses launchctl print pid", () => {
    expect(parseLaunchdPid("")).toBeNull();
    expect(parseLaunchdPid("state = running\n\tpid = 43210\n\tlast exit code = 0")).toBe(43210);
    expect(parseLaunchdPid("pid=999")).toBe(999);
  });

  it("reads helper metadata from history.db", () => {
    const dir = mkdtempSync(join(tmpdir(), "al-read-meta-"));
    const historyPath = join(dir, "history.db");
    const db = openHistoryDb(historyPath);
    db.prepare("INSERT INTO meta (key, value) VALUES ('helper_started_at', '12345')").run();
    db.prepare("INSERT INTO meta (key, value) VALUES ('helper_pid', '6789')").run();
    db.prepare("INSERT INTO meta (key, value) VALUES ('helper_script_mtime', '55555')").run();
    db.close();

    const meta = readHelperMeta(historyPath);
    expect(meta).toEqual({
      startedAt: 12345,
      pid: 6789,
      scriptMtime: 55555,
    });

    expect(readHelperMeta(join(dir, "nonexistent.db"))).toEqual({
      startedAt: null,
      pid: null,
      scriptMtime: null,
    });
  });

  it("determines if helper restart is needed", () => {
    // Newer script on disk than helper_script_mtime recorded in db
    expect(
      isHelperRestartNeeded({
        scriptMtime: 2000,
        meta: { startedAt: 1500, pid: 100, scriptMtime: 1000 },
        runningPid: 100,
        pidStartedAt: 1500,
      }),
    ).toBe(true);

    // Matching script mtime -> no restart needed
    expect(
      isHelperRestartNeeded({
        scriptMtime: 2000,
        meta: { startedAt: 2500, pid: 100, scriptMtime: 2000 },
        runningPid: 100,
        pidStartedAt: 2500,
      }),
    ).toBe(false);

    // Running pid started before script mtime (e.g. meta had no scriptMtime)
    expect(
      isHelperRestartNeeded({
        scriptMtime: 3000,
        meta: { startedAt: 1000, pid: 100, scriptMtime: null },
        runningPid: 100,
        pidStartedAt: null,
      }),
    ).toBe(true);

    // Running pid started after script mtime (e.g. via pidStartedAt fallback)
    expect(
      isHelperRestartNeeded({
        scriptMtime: 3000,
        meta: { startedAt: null, pid: null, scriptMtime: null },
        runningPid: 100,
        pidStartedAt: 3500,
      }),
    ).toBe(false);
  });
});
