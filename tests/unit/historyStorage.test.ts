import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { checkpointHistory, convertAutoVacuum, convertAutoVacuumIfSafe, historyCounts, historyStorageBytes, historyText, historyUsage, insertEvents, openHistoryDb, optimizeHistory, pruneBySize, pruneHistory, purgeHistory, queryHistory, readHistoryStats, resetHistory, writeHistoryStats } from "../../src/helper/historyDb";
import { purgeCommand } from "../../src/helper/leash-helper";
import { capBytes, formatBytes, parseCapGb, rearmDismissed, storageWarning, type HistoryStats } from "../../src/shared/storage";

const empty = { from: null, to: null, agents: [], path: "", kind: "all", sensitive: false, offset: 0, limit: 50, includeNoise: true };
const row = { ts: 1, agent: "codex" as const, pid: 1, exe: "codex", kind: "write" as const, sensitive: false, source: "eslogger" as const };
const day = 24 * 60 * 60 * 1000;

function historyPath() {
  return join(mkdtempSync(join(tmpdir(), "al-storage-")), "history.db");
}

function count(db: DatabaseSync, sql: string): number {
  return Number((db.prepare(sql).get() as { n: number }).n);
}

describe("history snapshots", () => {
  it("stores identical snapshots once, compressed, and reads them back", () => {
    const history = openHistoryDb(historyPath());
    const text = "export const a = 1;\n".repeat(200);
    insertEvents(history, [
      { ...row, path: "/Users/me/project/a.ts", beforeBlob: "old", afterBlob: text },
      { ...row, ts: 2, path: "/Users/me/project/b.ts", beforeBlob: "old", afterBlob: text },
    ]);
    expect(count(history, "SELECT count(*) AS n FROM blobs")).toBe(2);
    const blob = history.prepare("SELECT size, length(data) AS stored FROM blobs WHERE size = ?").get(text.length) as { size: number; stored: number };
    expect(blob.stored).toBeLessThan(blob.size);
    expect(count(history, "SELECT count(*) AS n FROM events WHERE before_blob IS NOT NULL OR after_blob IS NOT NULL")).toBe(0);
    const stored = history.prepare("SELECT sha256, after_hash FROM events WHERE id = 1").get() as { sha256: string; after_hash: string };
    expect(stored.sha256).toBe(stored.after_hash);
    expect(historyText(history, 1)).toEqual({ before: "old", after: text });
    expect(historyText(history, 2)).toEqual({ before: "old", after: text });
    history.close();
  });

  it("writes no snapshots for rows in the noise table", () => {
    const history = openHistoryDb(historyPath());
    insertEvents(history, [{ ...row, path: "/tmp/payload", beforeBlob: "a", afterBlob: "b" }]);
    const id = queryHistory(history, empty).rows[0]!.id;
    expect(historyText(history, id)).toEqual({ before: null, after: null });
    expect(count(history, "SELECT count(*) AS n FROM blobs")).toBe(0);
    history.close();
  });

  it("opens a legacy database and still reads its text columns", () => {
    const path = historyPath();
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, agent TEXT NOT NULL, pid INTEGER NOT NULL, exe TEXT NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL, dest_path TEXT, sha256 TEXT, before_blob TEXT, after_blob TEXT, sensitive INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL, minute_key TEXT)`);
    legacy.exec("CREATE TABLE blobs (sha256 TEXT PRIMARY KEY, content BLOB NOT NULL)");
    legacy.exec("INSERT INTO events (id, ts, agent, pid, exe, kind, path, before_blob, after_blob, source) VALUES (7, 1, 'codex', 1, 'codex', 'write', '/Users/me/project/a.ts', 'legacy before', 'legacy after', 'eslogger')");
    legacy.close();
    const readOnly = openHistoryDb(path, true);
    expect(historyText(readOnly, 7)).toEqual({ before: "legacy before", after: "legacy after" });
    readOnly.close();
    const history = openHistoryDb(path);
    expect(historyText(history, 7)).toEqual({ before: "legacy before", after: "legacy after" });
    insertEvents(history, [{ ...row, ts: 2, path: "/Users/me/project/b.ts", beforeBlob: "x", afterBlob: "y" }]);
    expect(historyText(history, 8)).toEqual({ before: "x", after: "y" });
    history.close();
  });

  it("keeps referenced blobs through an optimize rebuild and drops orphans", () => {
    const path = historyPath();
    const history = openHistoryDb(path);
    insertEvents(history, [{ ...row, path: "/Users/me/project/a.ts", beforeBlob: "a", afterBlob: "b" }]);
    history.prepare("INSERT INTO blobs (hash, size, data) VALUES ('orphan', 0, zeroblob(10))").run();
    history.close();
    optimizeHistory(path);
    const compact = openHistoryDb(path, true);
    expect(historyText(compact, 1)).toEqual({ before: "a", after: "b" });
    expect(count(compact, "SELECT count(*) AS n FROM blobs")).toBe(2);
    compact.close();
  });

  it("removes a blob once pruning deletes the only row that uses it", () => {
    const history = openHistoryDb(historyPath());
    const now = 100 * day;
    insertEvents(history, [
      { ...row, ts: now - 100 * day, path: "/Users/me/project/old.ts", beforeBlob: "gone", afterBlob: "shared" },
      { ...row, ts: now - day, path: "/Users/me/project/new.ts", beforeBlob: "shared", afterBlob: "kept" },
    ]);
    expect(count(history, "SELECT count(*) AS n FROM blobs")).toBe(3);
    pruneHistory(history, now, 90, 30);
    expect(count(history, "SELECT count(*) AS n FROM blobs")).toBe(2);
    expect(historyText(history, 2)).toEqual({ before: "shared", after: "kept" });
    history.close();
  });
});

describe("history WAL", () => {
  it("limits the journal and truncates the WAL on checkpoint", () => {
    const path = historyPath();
    const history = openHistoryDb(path);
    expect(history.prepare("PRAGMA journal_size_limit").get()).toEqual({ journal_size_limit: 67108864 });
    const big = Array.from({ length: 400 }, (_, index) => ({ ...row, ts: index, path: `/Users/me/project/${index}.ts`, afterBlob: `${index} ${"x".repeat(20_000)}` }));
    insertEvents(history, big);
    expect(existsSync(`${path}-wal`)).toBe(true);
    checkpointHistory(history);
    expect(statSync(`${path}-wal`).size).toBe(0);
    history.close();
  });
});

describe("history tuning", () => {
  it("syncs normally under WAL and keeps temp tables in memory", () => {
    const history = openHistoryDb(historyPath());
    expect(history.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 1 });
    expect(history.prepare("PRAGMA temp_store").get()).toEqual({ temp_store: 2 });
    history.close();
  });

  it("drops the unused path index from existing databases", () => {
    const path = historyPath();
    openHistoryDb(path).close();
    const legacy = new DatabaseSync(path);
    legacy.exec("CREATE INDEX events_path ON events (path, ts)");
    legacy.close();
    const history = openHistoryDb(path);
    const indexes = (history.prepare("PRAGMA index_list(events)").all() as { name: string }[]).map((index) => index.name);
    expect(indexes).not.toContain("events_path");
    expect(indexes).toContain("events_kind_id");
    history.close();
  });

  it("pages a kind filter by id without sorting", () => {
    const history = openHistoryDb(historyPath());
    for (const table of ["events", "noise"]) {
      const plan = (history.prepare(`EXPLAIN QUERY PLAN SELECT id FROM ${table} WHERE kind = 'read' ORDER BY id DESC LIMIT 100`).all() as { detail: string }[]).map((step) => step.detail).join("\n");
      expect(plan).toContain(`${table}_kind_id`);
      expect(plan).not.toContain("TEMP B-TREE");
    }
    history.close();
  });
});

const stats = (percent: number, hardCap = false): HistoryStats => ({ usedBytes: percent, fileBytes: percent, capBytes: 100, counts: [], prunedAt: null, prunedRows: 0, hardCap });

describe("history cap", () => {
  it("accepts whole gigabytes from 1 to 1024", () => {
    expect(parseCapGb("10")).toBe(10);
    expect(parseCapGb("1")).toBe(1);
    expect(parseCapGb("1024")).toBe(1024);
    for (const value of ["0", "1.5", "abc", "1025", ""]) expect(parseCapGb(value)).toBeNull();
  });

  it("falls back to 500 MB", () => {
    expect(capBytes("")).toBe(500 * 1024 ** 2);
    expect(capBytes("2")).toBe(2 * 1024 ** 3);
  });

  it("formats bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1.5 * 1024 ** 3)).toBe("1.5 GB");
  });
});

describe("storageWarning", () => {
  it("steps every 10 points from 50%", () => {
    expect(storageWarning(null, 0)).toBeNull();
    expect(storageWarning(stats(49), 0)).toBeNull();
    expect(storageWarning(stats(50), 0)).toEqual({ step: 50, percent: 50, closable: true });
    expect(storageWarning(stats(67), 0)).toEqual({ step: 60, percent: 67, closable: true });
  });

  it("hides dismissed steps until the next one", () => {
    expect(storageWarning(stats(67), 60)).toBeNull();
    expect(storageWarning(stats(72), 60)).toEqual({ step: 70, percent: 72, closable: true });
  });

  it("cannot dismiss the hard cap", () => {
    expect(storageWarning(stats(85, true), 0)).toEqual({ step: 100, percent: 85, closable: false });
    expect(storageWarning(stats(100), 100)).toEqual({ step: 100, percent: 100, closable: false });
  });
});

describe("rearmDismissed", () => {
  it("lowers the dismissed step once usage falls 10 points below it", () => {
    expect(rearmDismissed(stats(65), 80)).toBe(70);
    expect(rearmDismissed(stats(45), 50)).toBe(50);
    expect(rearmDismissed(stats(39), 50)).toBe(40);
    expect(rearmDismissed(null, 50)).toBe(50);
  });
});

type Table = "events" | "noise";

function seed(db: DatabaseSync, table: Table, kind: string, rows: number, ts: (index: number) => number, sensitive = false) {
  let id = count(db, "SELECT max(coalesce((SELECT max(id) FROM events), 0), coalesce((SELECT max(id) FROM noise), 0)) AS n");
  const insert = db.prepare(`INSERT INTO ${table} (id, ts, agent, pid, exe, kind, path, sensitive, source) VALUES (?, ?, 'codex', 1, 'codex', ?, ?, ?, 'eslogger')`);
  db.exec("BEGIN");
  for (let index = 0; index < rows; index += 1) insert.run((id += 1), ts(index), kind, `/Users/me/project/${table}/${kind}/${id}.ts`, sensitive ? 1 : 0);
  db.exec("COMMIT");
}

function rows(db: DatabaseSync, table: Table, where: string): number {
  return count(db, `SELECT count(*) AS n FROM ${table} WHERE ${where}`);
}

function capAt(db: DatabaseSync, fraction: number): number {
  checkpointHistory(db);
  return Math.ceil(historyUsage(db) / fraction);
}

describe("pruneBySize", () => {
  const now = 100 * day;
  const fresh = () => {
    const path = historyPath();
    return { path, db: openHistoryDb(path) };
  };

  it("creates incremental auto-vacuum databases with kind indexes", () => {
    const { db } = fresh();
    expect(db.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 });
    for (const name of ["events_kind", "noise_kind"]) expect(count(db, `SELECT count(*) AS n FROM sqlite_master WHERE type = 'index' AND name = '${name}'`)).toBe(1);
    db.close();
  });

  it("skips conversion for a large database or low free space, and restores temp_store", () => {
    const path = historyPath();
    const legacy = new DatabaseSync(path);
    legacy.exec("PRAGMA auto_vacuum = NONE");
    legacy.exec("CREATE TABLE seed (n INTEGER)");
    legacy.close();
    const db = openHistoryDb(path);
    const size = historyStorageBytes(path);
    expect(convertAutoVacuumIfSafe(db, path, size * 10, size - 1).status).toBe("too-large");
    expect(convertAutoVacuumIfSafe(db, path, size * 3 - 1).status).toBe("low-space");
    expect(db.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 0 });
    expect(convertAutoVacuumIfSafe(db, path, size * 3).status).toBe("converted");
    expect(db.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 });
    expect(db.prepare("PRAGMA temp_store").get()).toEqual({ temp_store: 2 });
    db.close();
  });

  it("converts a legacy database to incremental auto-vacuum once, so pruning shrinks the file", () => {
    const path = historyPath();
    const legacy = new DatabaseSync(path);
    legacy.exec("PRAGMA auto_vacuum = NONE");
    legacy.exec("CREATE TABLE seed (n INTEGER)");
    legacy.close();
    const db = openHistoryDb(path);
    expect(db.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 0 });
    seed(db, "noise", "read", 6000, (index) => now - 2 * day - index);
    expect(convertAutoVacuum(db)).toBe(true);
    expect(db.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 });
    expect(convertAutoVacuum(db)).toBe(false);
    expect(rows(db, "noise", "1 = 1")).toBe(6000);
    checkpointHistory(db);
    const before = statSync(path).size;
    pruneBySize(db, capAt(db, 0.6), now);
    expect(statSync(path).size).toBeLessThan(before / 2);
    db.close();
  });

  it("measures live pages", () => {
    const { db } = fresh();
    seed(db, "noise", "read", 2000, (index) => index);
    checkpointHistory(db);
    const full = historyUsage(db);
    db.exec("DELETE FROM noise");
    checkpointHistory(db);
    expect(historyUsage(db)).toBeLessThan(full / 3);
    db.close();
  });

  it("does not count WAL bytes while a reader blocks the checkpoint", () => {
    const { path, db } = fresh();
    seed(db, "noise", "read", 500, (index) => index);
    checkpointHistory(db);
    const reader = new DatabaseSync(path);
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) FROM noise").get();
    seed(db, "noise", "read", 2000, (index) => index);
    checkpointHistory(db);
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
    const blocked = historyUsage(db);
    reader.exec("COMMIT");
    reader.close();
    checkpointHistory(db);
    expect(statSync(`${path}-wal`).size).toBe(0);
    expect(historyUsage(db)).toBe(blocked);
    db.close();
  });

  it("deletes nothing under half the cap", () => {
    const { db } = fresh();
    seed(db, "noise", "read", 2000, (index) => now - 2 * day - index);
    expect(pruneBySize(db, capAt(db, 0.4), now)).toEqual({ deleted: 0, hardCap: false });
    expect(rows(db, "noise", "1 = 1")).toBe(2000);
    db.close();
  });

  it("deletes scratch reads older than a day first, in batches, and stops under 45%", () => {
    const { db } = fresh();
    seed(db, "noise", "read", 6000, (index) => now - 2 * day - index);
    seed(db, "noise", "read", 20, (index) => now - index * 1000);
    seed(db, "events", "read", 20, () => now - 30 * day);
    seed(db, "events", "write", 20, () => now - 30 * day);
    const cap = capAt(db, 0.6);
    expect(pruneBySize(db, cap, now)).toEqual({ deleted: 5000, hardCap: false });
    expect(rows(db, "noise", "1 = 1")).toBe(1020);
    expect(count(db, "SELECT min(ts) AS n FROM noise")).toBe(now - 2 * day - 999);
    expect(rows(db, "events", "1 = 1")).toBe(40);
    expect(historyUsage(db)).toBeLessThan(cap * 0.45);
    db.close();
  });

  it("deletes non-sensitive project reads older than a week before sensitive ones", () => {
    const { db } = fresh();
    seed(db, "events", "read", 4000, (index) => now - 8 * day - index);
    seed(db, "events", "read", 20, () => now - 8 * day, true);
    seed(db, "events", "read", 20, () => now - 6 * day);
    pruneBySize(db, capAt(db, 0.6), now);
    expect(rows(db, "events", "sensitive = 1")).toBe(20);
    expect(rows(db, "events", "sensitive = 0")).toBe(20);
    db.close();
  });

  it("deletes sensitive project reads older than a week before exec rows", () => {
    const { db } = fresh();
    seed(db, "events", "read", 4000, (index) => now - 8 * day - index, true);
    seed(db, "events", "read", 20, () => now - 6 * day, true);
    seed(db, "events", "exec", 10, () => now - 30 * day);
    seed(db, "noise", "exec", 10, () => now - 30 * day);
    pruneBySize(db, capAt(db, 0.6), now);
    expect(rows(db, "events", "kind = 'read'")).toBe(20);
    expect(rows(db, "events", "kind = 'exec'") + rows(db, "noise", "kind = 'exec'")).toBe(20);
    db.close();
  });

  it("deletes exec rows from both tables before any write", () => {
    const { db } = fresh();
    seed(db, "events", "exec", 3000, (index) => now - index);
    seed(db, "noise", "exec", 3000, (index) => now - index);
    seed(db, "noise", "write", 1000, () => now - 30 * day);
    seed(db, "events", "write", 1000, () => now - 30 * day);
    pruneBySize(db, capAt(db, 0.99), now);
    expect(rows(db, "events", "kind = 'exec'") + rows(db, "noise", "kind = 'exec'")).toBe(0);
    expect(rows(db, "events", "kind = 'write'") + rows(db, "noise", "kind = 'write'")).toBe(2000);
    db.close();
  });

  it("deletes scratch writes before project writes, oldest first", () => {
    const { db } = fresh();
    seed(db, "noise", "write", 8000, (index) => now - 8000 + index);
    seed(db, "events", "write", 20, () => now - 30 * day);
    expect(pruneBySize(db, capAt(db, 0.55), now)).toEqual({ deleted: 5000, hardCap: false });
    expect(count(db, "SELECT min(ts) AS n FROM noise")).toBe(now - 3000);
    expect(rows(db, "events", "1 = 1")).toBe(20);
    db.close();
  });

  it("keeps sensitive writes and floored reads through every step", () => {
    const { db } = fresh();
    seed(db, "events", "write", 4000, (index) => now - 60 * day + index, true);
    seed(db, "events", "write", 2000, (index) => now - 50 * day + index);
    seed(db, "noise", "write", 20, () => now - 50 * day);
    seed(db, "noise", "read", 20, () => now - 1000);
    seed(db, "events", "read", 20, () => now - 6 * day);
    seed(db, "events", "read", 20, () => now - 6 * day, true);
    expect(pruneBySize(db, capAt(db, 0.9), now)).toEqual({ deleted: 2020, hardCap: false });
    expect(rows(db, "events", "kind = 'write'")).toBe(4000);
    expect(rows(db, "events", "kind = 'write' AND sensitive = 0")).toBe(0);
    expect(rows(db, "noise", "1 = 1")).toBe(20);
    expect(rows(db, "events", "kind = 'read'")).toBe(40);
    db.close();
  });

  it("stops once orphaned snapshot space is reclaimed instead of deleting later steps", () => {
    const { db } = fresh();
    insertEvents(db, Array.from({ length: 50 }, (_, index) => ({ ...row, kind: "read" as const, ts: now - 10 * day + index, path: `/Users/me/project/big-${index}.ts`, afterBlob: randomBytes(10_000).toString("hex") })));
    seed(db, "events", "read", 1000, (index) => now - 10 * day + index, true);
    expect(pruneBySize(db, capAt(db, 0.6), now)).toEqual({ deleted: 50, hardCap: false });
    expect(rows(db, "events", "sensitive = 1")).toBe(1000);
    expect(count(db, "SELECT count(*) AS n FROM blobs")).toBe(0);
    db.close();
  });

  it("stops at the target once the deleted rows' snapshots are freed", () => {
    const { db } = fresh();
    insertEvents(
      db,
      Array.from({ length: 200 }, (_, index) => ({ ...row, kind: "read" as const, ts: now - 20 * day + index, path: `/Users/me/project/big-${index}.ts`, afterBlob: randomBytes(40_000).toString("hex") })),
      [],
      { verboseCapture: true },
    );
    seed(db, "events", "read", 14_800, (index) => now - 10 * day + index);
    const cap = capAt(db, 0.6);
    expect(pruneBySize(db, cap, now)).toEqual({ deleted: 5000, hardCap: false });
    expect(rows(db, "events", "1 = 1")).toBe(10_000);
    expect(count(db, "SELECT count(*) AS n FROM blobs")).toBe(0);
    expect(historyUsage(db)).toBeLessThan(cap * 0.45);
    db.close();
  });

  it("drops the floors over the cap, deleting strictly oldest first across both tables", () => {
    const { db } = fresh();
    seed(db, "noise", "read", 6000, (index) => now - (2 * index + 1) * 1000);
    seed(db, "events", "write", 6000, (index) => now - 2 * index * 1000, true);
    const cap = capAt(db, 1.05);
    expect(pruneBySize(db, cap, now)).toEqual({ deleted: 5000, hardCap: true });
    expect(historyUsage(db)).toBeLessThan(cap * 0.9);
    expect(rows(db, "noise", "1 = 1")).toBeLessThan(6000);
    expect(rows(db, "events", "1 = 1")).toBeLessThan(6000);
    expect(count(db, "SELECT min(ts) AS n FROM (SELECT ts FROM events UNION ALL SELECT ts FROM noise)")).toBe(now - 6999 * 1000);
    expect(pruneBySize(db, cap, now)).toEqual({ deleted: 0, hardCap: false });
    db.close();
  });

  it("measures WAL pages without checkpointing per batch, then checkpoints once at the end", () => {
    const { path, db } = fresh();
    seed(db, "noise", "read", 6000, (index) => now - 2 * day - index);
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
    const used = historyUsage(db);
    expect(pruneBySize(db, Math.ceil(used / 0.4), now)).toEqual({ deleted: 0, hardCap: false });
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
    expect(pruneBySize(db, Math.ceil(used / 0.6), now).deleted).toBe(5000);
    expect(statSync(`${path}-wal`).size).toBe(0);
    db.close();
  });

  it("shrinks the file after deleting", () => {
    const { path, db } = fresh();
    seed(db, "noise", "read", 6000, (index) => now - 2 * day - index);
    const cap = capAt(db, 0.6);
    const before = statSync(path).size;
    pruneBySize(db, cap, now);
    expect(statSync(path).size).toBeLessThan(before / 2);
    db.close();
  });
});

describe("history stats", () => {
  it("round-trips stats through meta and counts rows by kind", () => {
    const db = openHistoryDb(historyPath());
    expect(readHistoryStats(db)).toBeNull();
    seed(db, "events", "read", 3, () => 1, true);
    seed(db, "events", "write", 2, () => 1);
    seed(db, "noise", "read", 1, () => 1);
    const counts = historyCounts(db);
    expect(counts).toEqual(
      expect.arrayContaining([
        { table: "events", kind: "read", sensitive: true, rows: 3 },
        { table: "events", kind: "write", sensitive: false, rows: 2 },
        { table: "noise", kind: "read", sensitive: false, rows: 1 },
      ]),
    );
    expect(counts).toHaveLength(3);
    const value: HistoryStats = { usedBytes: 1, fileBytes: 2, capBytes: 3, counts, prunedAt: 4, prunedRows: 5, hardCap: true };
    writeHistoryStats(db, value);
    expect(readHistoryStats(db)).toEqual(value);
    db.close();
  });
});

describe("purgeHistory", () => {
  const now = 100 * day;
  const seeded = () => {
    const db = openHistoryDb(historyPath());
    insertEvents(db, [{ ...row, ts: now - 40 * day, path: "/Users/me/project/a.ts", beforeBlob: "a", afterBlob: "b" }]);
    seed(db, "events", "read", 3, () => now - 40 * day);
    seed(db, "events", "read", 2, () => now - day, true);
    seed(db, "events", "exec", 2, () => now - day);
    seed(db, "events", "write", 1, () => now - day, true);
    seed(db, "noise", "read", 4, () => now - day);
    seed(db, "noise", "write", 5, () => now - 40 * day);
    return db;
  };

  it("deletes every non-sensitive read", () => {
    const db = seeded();
    expect(purgeHistory(db, "reads", now)).toBe(7);
    expect(rows(db, "events", "kind = 'read'")).toBe(2);
    expect(rows(db, "noise", "kind = 'read'")).toBe(0);
    db.close();
  });

  it("deletes every scratch row and exec row", () => {
    const db = seeded();
    expect(purgeHistory(db, "noise", now)).toBe(11);
    expect(rows(db, "noise", "1 = 1")).toBe(0);
    expect(rows(db, "events", "kind = 'exec'")).toBe(0);
    expect(rows(db, "events", "1 = 1")).toBe(7);
    db.close();
  });

  it("deletes rows older than the given days, sensitive or not, with their snapshots", () => {
    const db = seeded();
    expect(purgeHistory(db, "older", now, 30)).toBe(9);
    expect(rows(db, "events", "1 = 1")).toBe(5);
    expect(rows(db, "noise", "1 = 1")).toBe(4);
    expect(count(db, "SELECT count(*) AS n FROM blobs")).toBe(0);
    expect(() => purgeHistory(db, "older", now)).toThrow();
    db.close();
  });
});

describe("resetHistory", () => {
  it("replaces history with an empty incremental database and keeps the file mode", () => {
    const path = historyPath();
    const legacy = new DatabaseSync(path);
    legacy.exec("PRAGMA journal_mode = WAL");
    legacy.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, agent TEXT NOT NULL, pid INTEGER NOT NULL, exe TEXT NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL, dest_path TEXT, sha256 TEXT, before_blob TEXT, after_blob TEXT, sensitive INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL, minute_key TEXT)");
    legacy.exec("INSERT INTO events (id, ts, agent, pid, exe, kind, path, source) VALUES (1, 1, 'codex', 1, 'codex', 'write', '/Users/me/project/a.ts', 'eslogger')");
    legacy.close();
    chmodSync(path, 0o640);
    const dir = dirname(path);
    for (const file of [`${path}.optimize-1-2`, `${path}.backup-1-2`, `${path}.optimize-1-2-wal`, join(dir, "other.db")]) writeFileSync(file, "x");
    const result = resetHistory(path);
    expect(result.beforeBytes).toBeGreaterThan(0);
    expect(result.afterBytes).toBeGreaterThan(0);
    expect(readdirSync(dir).sort()).toEqual(["history.db", "other.db"]);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    const db = openHistoryDb(path, true);
    expect(db.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 });
    expect(count(db, "SELECT count(*) AS n FROM events")).toBe(0);
    expect(count(db, "SELECT count(*) AS n FROM noise")).toBe(0);
    db.close();
  });
});

describe("helper purge command", () => {
  it("purges rows, rebuilds, and reports the deleted count", () => {
    const path = historyPath();
    const db = openHistoryDb(path);
    seed(db, "events", "read", 3, () => Date.now());
    seed(db, "events", "write", 2, () => Date.now());
    db.close();
    const result = purgeCommand("reads", path);
    expect(result).toEqual({ beforeBytes: expect.any(Number), afterBytes: expect.any(Number), deleted: 3 });
    expect(existsSync(`${path}-wal`)).toBe(false);
    const after = openHistoryDb(path, true);
    expect(rows(after, "events", "1 = 1")).toBe(2);
    after.close();
  });

  it("needs days for older and resets everything for all", () => {
    const path = historyPath();
    const db = openHistoryDb(path);
    seed(db, "events", "write", 2, () => Date.now() - 40 * day);
    seed(db, "events", "write", 1, () => Date.now());
    db.close();
    expect(() => purgeCommand("older", path)).toThrow();
    expect(() => purgeCommand("bogus", path)).toThrow();
    expect(purgeCommand("older", path, "30").deleted).toBe(2);
    expect(purgeCommand("all", path).deleted).toBeNull();
    const after = openHistoryDb(path, true);
    expect(rows(after, "events", "1 = 1")).toBe(0);
    after.close();
  });
});
