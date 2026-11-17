import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { historyText, insertEvents, openHistoryDb, optimizeHistory, pruneHistory, queryHistory, replaceHistory, splitHistory, summarizeHistory } from "../../src/helper/historyDb";
import { eventBucket, isLoopbackNetTarget, isNoise } from "../../src/shared/noise";
import { parseRetentionDays } from "../../src/shared/retention";

const empty = { from: null, to: null, agents: [], path: "", kind: "all", sensitive: false, offset: 0, limit: 50 };

function db() {
  return openHistoryDb(join(mkdtempSync(join(tmpdir(), "al-noise-")), "history.db"));
}

const row = { ts: 1, agent: "codex" as const, pid: 1, exe: "codex", kind: "read" as const, sensitive: false, source: "eslogger" as const };

describe("isNoise", () => {
  it("hides devices, temp files and agent machinery", () => {
    expect(isNoise("/dev/null")).toBe(true);
    expect(isNoise("/private/tmp/claude-42.tmp")).toBe(true);
    expect(isNoise("/Users/me/.claude/plugins/synced/pkg/.last-complete-round")).toBe(true);
    expect(isNoise("/Users/me/.claude/projects/abc/session.jsonl")).toBe(true);
    expect(isNoise("/Users/me/project/node_modules/left-pad/index.js")).toBe(true);
  });

  it("keeps personal files, including a .env sitting in a temp directory", () => {
    expect(isNoise("/Users/me/project/src/index.ts")).toBe(false);
    expect(isNoise("/Users/me/.ssh/id_ed25519")).toBe(false);
    expect(isNoise("/tmp/app/.env")).toBe(false);
    expect(isNoise("/Users/me/.claude.json")).toBe(false);
  });
});

describe("eventBucket", () => {
  it("keeps project files, network, and personal paths on main", () => {
    expect(eventBucket({ kind: "read", path: "/Users/me/project/src/index.ts" })).toBe("main");
    expect(eventBucket({ kind: "net", path: "10.0.0.1:443" })).toBe("main");
    expect(eventBucket({ kind: "read", path: "/tmp/app/.env" })).toBe("main");
    expect(eventBucket({ kind: "rename", path: "/tmp/x", destPath: "/Users/me/.ssh/id_ed25519" })).toBe("main");
  });

  it("keeps scratch writes and /tmp reads for the noise table", () => {
    expect(eventBucket({ kind: "write", path: "/tmp/payload" })).toBe("noise");
    expect(eventBucket({ kind: "read", path: "/private/tmp/stage" })).toBe("noise");
    expect(eventBucket({ kind: "write", path: "/Users/me/project/node_modules/left-pad/index.js" })).toBe("noise");
  });

  it("drops every exec while retaining network events", () => {
    expect(eventBucket({ kind: "exec", path: "/tmp/payload" })).toBe("drop");
    expect(eventBucket({ kind: "exec", path: "/usr/bin/git" })).toBe("drop");
    expect(eventBucket({ kind: "exec", path: "/Users/me/.ssh/tool" })).toBe("drop");
    expect(eventBucket({ kind: "net", path: "10.0.0.1:443" })).toBe("main");
  });

  it("drops junk and other noise reads", () => {
    expect(eventBucket({ kind: "write", path: "/dev/null" })).toBe("drop");
    expect(eventBucket({ kind: "write", path: "/Users/me/project/.DS_Store" })).toBe("drop");
    expect(eventBucket({ kind: "read", path: "/Users/me/.claude/projects/abc/session.jsonl" })).toBe("drop");
    expect(eventBucket({ kind: "read", path: "/tmp/claude-42.tmp" })).toBe("drop");
  });

  it("drops local loopback network events while keeping external connections", () => {
    for (const target of [
      "127.0.0.1",
      "127.0.0.1:5173",
      "[::1]",
      "[::1]:5173",
      "::1",
      "localhost",
      "localhost:5173",
      "http://localhost:5173/@vite/client",
      "ws://127.0.0.1:24678",
    ]) {
      expect(isLoopbackNetTarget(target), target).toBe(true);
      expect(eventBucket({ kind: "net", path: target }), target).toBe("drop");
      expect(eventBucket({ kind: "net", path: target, source: "hook" }), target).toBe("drop");
    }
    for (const target of ["10.0.0.1:443", "api.anthropic.com:443", "https://localhost.example.com/api", "127.0.0.10:443"]) {
      expect(isLoopbackNetTarget(target), target).toBe(false);
      expect(eventBucket({ kind: "net", path: target }), target).toBe("main");
    }
  });
});

describe("history tables", () => {
  it("stores main and noise separately and can read them together", () => {
    const history = db();
    insertEvents(history, [
      { ...row, path: "/dev/null" },
      { ...row, ts: 2, path: "/Users/me/project/src/index.ts" },
      { ...row, ts: 3, path: "/tmp/app/.env", sensitive: true },
      { ...row, ts: 4, kind: "read", path: "/Users/me/.claude/projects/abc/session.jsonl" },
      { ...row, ts: 5, kind: "write", path: "/tmp/payload", beforeBlob: "a", afterBlob: "b" },
      { ...row, ts: 6, kind: "net", path: "10.0.0.1:443", source: "net" },
    ]);
    expect(queryHistory(history, empty).rows.map((item) => item.path).sort()).toEqual(["/Users/me/project/src/index.ts", "/tmp/app/.env", "10.0.0.1:443"]);
    const both = queryHistory(history, { ...empty, includeNoise: true });
    expect(both.rows.map((item) => item.path).sort()).toEqual(["/Users/me/project/src/index.ts", "/tmp/app/.env", "/tmp/payload", "10.0.0.1:443"]);
    expect(both.total).toBe(4);
    const noise = both.rows.find((item) => item.path === "/tmp/payload");
    expect(historyText(history, noise!.id)).toEqual({ before: null, after: null });
    expect(new Set(both.rows.map((item) => item.id)).size).toBe(4);
    history.close();
  });

  it("moves existing noise rows once and deletes junk", () => {
    const history = db();
    const insert = history.prepare(
      `INSERT INTO events (ts, agent, pid, exe, kind, path, dest_path, sha256, before_blob, after_blob, sensitive, source, minute_key)
       VALUES (?, 'codex', 1, 'codex', ?, ?, NULL, NULL, NULL, NULL, 0, 'eslogger', NULL)`,
    );
    insert.run(1, "read", "/dev/null");
    insert.run(2, "read", "/Users/me/project/src/index.ts");
    insert.run(3, "read", "/Users/me/.claude/projects/abc/session.jsonl");
    insert.run(4, "write", "/tmp/payload");
    insert.run(5, "read", "/tmp/app/.env");
    splitHistory(history);
    splitHistory(history);
    expect(queryHistory(history, empty).rows.map((item) => item.path).sort()).toEqual(["/Users/me/project/src/index.ts", "/tmp/app/.env"]);
    expect(queryHistory(history, { ...empty, includeNoise: true }).rows.map((item) => item.path).sort()).toEqual(["/Users/me/project/src/index.ts", "/tmp/app/.env", "/tmp/payload"]);
    history.close();
  });

  it("prunes each table with its own day count", () => {
    const history = db();
    const now = 100 * 24 * 60 * 60 * 1000;
    const day = 24 * 60 * 60 * 1000;
    insertEvents(history, [
      { ...row, ts: now - 100 * day, path: "/Users/me/project/old.ts" },
      { ...row, ts: now - 10 * day, path: "/Users/me/project/new.ts" },
      { ...row, ts: now - 40 * day, kind: "write", path: "/tmp/old-payload" },
      { ...row, ts: now - 10 * day, kind: "write", path: "/tmp/new-payload" },
    ]);
    pruneHistory(history, now, 90, 30);
    expect(queryHistory(history, { ...empty, includeNoise: true }).rows.map((item) => item.path).sort()).toEqual(["/Users/me/project/new.ts", "/tmp/new-payload"]);
    history.close();
  });

  it("opens the database in WAL mode with a ts index", () => {
    const history = db();
    expect(history.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    const indexes = history.prepare("PRAGMA index_list(events)").all() as { name: string }[];
    expect(indexes.some((index) => index.name === "events_ts")).toBe(true);
    history.close();
  });

  it("rebuilds history without orphan blobs or exec rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "al-optimize-"));
    const path = join(dir, "history.db");
    const history = openHistoryDb(path);
    insertEvents(history, [
      { ...row, ts: 2, kind: "write", path: "/Users/me/project/a.ts", beforeBlob: "a", afterBlob: "b" },
      { ...row, ts: 3, kind: "write", path: "/tmp/payload" },
    ]);
    const insertExec = history.prepare(
      `INSERT INTO events (id, ts, agent, pid, exe, kind, path, sensitive, source)
       VALUES (?, ?, 'codex', 1, 'codex', 'exec', ?, 0, 'eslogger')`,
    );
    insertExec.run(20, 4, "/usr/bin/git");
    history.prepare("INSERT INTO noise (id, ts, agent, pid, exe, kind, path, sensitive, source) VALUES (?, ?, 'codex', 1, 'codex', 'exec', ?, 0, 'eslogger')").run(21, 5, "/tmp/tool");
    history.prepare("INSERT INTO blobs (hash, size, data) VALUES ('old', 9, zeroblob(100000))").run();
    history.prepare("INSERT INTO meta (key, value) VALUES ('custom', 'kept')").run();
    history.close();

    const result = optimizeHistory(path);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
    const compact = openHistoryDb(path, true);
    const rows = queryHistory(compact, { ...empty, includeNoise: true }).rows;
    expect(rows.map((item) => item.path).sort()).toEqual(["/Users/me/project/a.ts", "/tmp/payload"]);
    expect(rows.map((item) => item.id).sort()).toEqual([1, 2]);
    expect(historyText(compact, rows.find((item) => item.path.endsWith("a.ts"))!.id)).toEqual({ before: "a", after: "b" });
    expect(compact.prepare("SELECT value FROM meta WHERE key = 'custom'").get()).toEqual({ value: "kept" });
    expect(compact.prepare("SELECT count(*) AS n FROM blobs WHERE hash = 'old'").get()).toEqual({ n: 0 });
    expect(compact.prepare("SELECT count(*) AS n FROM events WHERE kind = 'exec'").get()).toEqual({ n: 0 });
    expect((compact.prepare("PRAGMA index_list(events)").all() as { name: string }[]).some((index) => index.name === "events_ts")).toBe(true);
    expect(result.afterBytes).toBeLessThan(result.beforeBytes);
    compact.close();
    expect(optimizeHistory(path).afterBytes).toBeGreaterThan(0);
  });

  it("restores the original database when replacement verification fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "al-swap-"));
    const original = join(dir, "history.db");
    const replacement = join(dir, "history.next.db");
    for (const [path, value] of [[original, "original"], [replacement, "replacement"]] as const) {
      const database = new DatabaseSync(path);
      database.exec("CREATE TABLE marker (value TEXT)");
      database.prepare("INSERT INTO marker VALUES (?)").run(value);
      database.close();
    }

    expect(() => replaceHistory(original, replacement, () => {
      throw new Error("integrity failed");
    })).toThrow("integrity failed");
    const restored = new DatabaseSync(original, { readOnly: true });
    expect(restored.prepare("SELECT value FROM marker").get()).toEqual({ value: "original" });
    restored.close();
    expect(existsSync(replacement)).toBe(false);
  });

  it("refuses to rebuild while another WAL reader is active", () => {
    const dir = mkdtempSync(join(tmpdir(), "al-busy-"));
    const path = join(dir, "history.db");
    const history = openHistoryDb(path);
    insertEvents(history, [{ ...row, path: "/Users/me/project/a.ts" }]);
    history.close();
    const reader = new DatabaseSync(path);
    reader.exec("BEGIN");
    reader.prepare("SELECT * FROM events").all();
    const writer = openHistoryDb(path);
    insertEvents(writer, [{ ...row, ts: 2, path: "/Users/me/project/b.ts" }]);
    writer.close();
    const started = Date.now();
    try {
      expect(() => optimizeHistory(path)).toThrow("active history connection");
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      reader.exec("ROLLBACK");
      reader.close();
    }
  }, 1_500);
});

describe("parseRetentionDays", () => {
  it("accepts whole days from 5 to 365", () => {
    expect(parseRetentionDays("5")).toBe(5);
    expect(parseRetentionDays("365")).toBe(365);
    expect(parseRetentionDays("90")).toBe(90);
  });

  it("refuses blank and out of range values", () => {
    expect(parseRetentionDays("")).toBeNull();
    expect(parseRetentionDays("4")).toBeNull();
    expect(parseRetentionDays("366")).toBeNull();
    expect(parseRetentionDays("30.5")).toBeNull();
  });
});

describe("summarizeHistory", () => {
  it("groups events by agent and kind since the cutoff", () => {
    const history = db();
    const ev = (over: { path: string } & Record<string, unknown>) => ({ ...row, ...over }) as never;
    insertEvents(history, [
      ev({ ts: 5, path: "/p/old" }),
      ev({ ts: 600_000, path: "/p/a" }),
      ev({ ts: 11, path: "/p/b", kind: "write" }),
      ev({ ts: 12, path: "/p/c", kind: "delete" }),
      ev({ ts: 14, path: "1.1.1.1:443", kind: "net" }),
      ev({ ts: 1_200_000, path: "/p/.ssh/k", sensitive: true }),
      ev({ ts: 16, path: "/p/e", agent: "cursor", kind: "write" }),
    ]);
    const summary = summarizeHistory(history, 10);
    expect(summary).toMatchObject({ from: 10, total: 6, sensitive: 1 });
    expect(summary.agents.find((a) => a.agent === "codex")).toEqual({ agent: "codex", reads: 2, writes: 2, execs: 0, net: 1, other: 0 });
    expect(summary.agents.find((a) => a.agent === "cursor")).toMatchObject({ writes: 1, reads: 0 });
  });
});
