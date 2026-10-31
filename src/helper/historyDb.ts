import { chmodSync, chownSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statfsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { ignoredMatchSql } from "../shared/ignored";
import { eventBucket } from "../shared/noise";
import { MAIN_RETENTION_DAYS, NOISE_RETENTION_DAYS } from "../shared/retention";
import { HARD_CAP_STOP, PROJECT_READ_FLOOR_DAYS, PRUNE_START, PRUNE_STOP, SCRATCH_READ_FLOOR_DAYS, type HistoryStats, type PurgeMode } from "../shared/storage";
import type { HistoryEvent, HistoryRow, HistorySummary } from "../shared/types";
import { sha256 } from "./classify";

const DAY_MS = 24 * 60 * 60 * 1000;
const EVENT_COLS = "id, ts, agent, pid, exe, kind, path, dest_path, sha256, before_blob, after_blob, sensitive, source, minute_key, before_hash, after_hash";
const LEGACY_COLS = EVENT_COLS.replace(", before_hash, after_hash", ", NULL, NULL");
const EVENT_TABLE = `
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  agent TEXT NOT NULL,
  pid INTEGER NOT NULL,
  exe TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  dest_path TEXT,
  sha256 TEXT,
  before_blob TEXT,
  after_blob TEXT,
  sensitive INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  minute_key TEXT,
  before_hash TEXT,
  after_hash TEXT
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (${EVENT_TABLE});
CREATE UNIQUE INDEX IF NOT EXISTS events_read_collapse ON events (minute_key) WHERE minute_key IS NOT NULL;
DROP INDEX IF EXISTS events_path;
CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
CREATE INDEX IF NOT EXISTS events_kind ON events (kind, sensitive, ts);
CREATE INDEX IF NOT EXISTS events_kind_id ON events (kind);
CREATE TABLE IF NOT EXISTS noise (${EVENT_TABLE});
CREATE UNIQUE INDEX IF NOT EXISTS noise_read_collapse ON noise (minute_key) WHERE minute_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS noise_ts ON noise (ts);
CREATE INDEX IF NOT EXISTS noise_kind ON noise (kind, sensitive, ts);
CREATE INDEX IF NOT EXISTS noise_kind_id ON noise (kind);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, data BLOB NOT NULL);
`;

const UNREFERENCED = ["events", "noise"].flatMap((table) => ["before_hash", "after_hash"].map((col) => `NOT EXISTS (SELECT 1 FROM ${table} WHERE ${col} = blobs.hash)`)).join(" AND ");
const REFERENCED = ["events", "noise"].flatMap((table) => ["before_hash", "after_hash"].map((col) => `SELECT ${col} FROM ${table} WHERE ${col} IS NOT NULL`)).join(" UNION ");

function hasColumn(db: DatabaseSync, table: string, column: string, schema = "main"): boolean {
  return (db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as { name: string }[]).some((item) => item.name === column);
}

export function openHistoryDb(path: string, readOnly = false): DatabaseSync {
  if (!readOnly) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { readOnly });
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA cache_size = -16000");
  db.exec("PRAGMA temp_store = MEMORY");
  if (readOnly) db.exec("PRAGMA mmap_size = 268435456");
  if (!readOnly) {
    db.exec("PRAGMA auto_vacuum = INCREMENTAL");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA journal_size_limit = 67108864");
    if (hasTable(db, "blobs") && !hasColumn(db, "blobs", "hash")) db.exec("DROP TABLE blobs");
    db.exec(SCHEMA);
    for (const table of ["events", "noise"]) for (const col of ["before_hash", "after_hash"]) if (!hasColumn(db, table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
    for (const table of ["events", "noise"]) for (const col of ["before_hash", "after_hash"]) db.exec(`CREATE INDEX IF NOT EXISTS ${table}_${col} ON ${table} (${col}) WHERE ${col} IS NOT NULL`);
  }
  return db;
}

function maxId(db: DatabaseSync): number {
  const events = (db.prepare("SELECT MAX(id) AS n FROM events").get() as { n: number | null }).n ?? 0;
  const noise = (db.prepare("SELECT MAX(id) AS n FROM noise").get() as { n: number | null }).n ?? 0;
  return Math.max(events, noise);
}

export function convertAutoVacuum(db: DatabaseSync): boolean {
  if (Number(Object.values(db.prepare("PRAGMA auto_vacuum").get() as Record<string, number>)[0]) === 2) return false;
  // VACUUM builds its copy in temp storage; keep it on disk, not in a root daemon's RAM.
  db.exec("PRAGMA temp_store = FILE");
  try {
    db.exec("PRAGMA auto_vacuum = INCREMENTAL");
    db.exec("VACUUM");
    checkpointHistory(db);
  } finally {
    db.exec("PRAGMA temp_store = MEMORY");
  }
  return true;
}

export const CONVERT_MAX_BYTES = 1024 ** 3;
export const CONVERT_SPACE_FACTOR = 3;

export type ConvertResult = { status: "converted" | "already" | "too-large" | "low-space"; bytes: number; free: number };

export function convertAutoVacuumIfSafe(db: DatabaseSync, path: string, free: number = freeBytes(path), maxBytes = CONVERT_MAX_BYTES): ConvertResult {
  const bytes = historyStorageBytes(path);
  if (bytes > maxBytes) return { status: "too-large", bytes, free };
  if (free < bytes * CONVERT_SPACE_FACTOR) return { status: "low-space", bytes, free };
  return { status: convertAutoVacuum(db) ? "converted" : "already", bytes, free };
}

function freeBytes(path: string): number {
  const fs = statfsSync(dirname(path));
  return Number(fs.bavail) * Number(fs.bsize);
}

export function checkpointHistory(db: DatabaseSync): void {
  db.exec("PRAGMA busy_timeout = 0");
  try {
    db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  } catch (error) {
    if (!(error instanceof Error && /busy|locked/i.test(error.message))) throw error;
  } finally {
    db.exec("PRAGMA busy_timeout = 5000");
  }
}

export function insertEvents(db: DatabaseSync, events: HistoryEvent[], ignored: readonly string[] = []): void {
  const kept = events.flatMap((event) => {
    const bucket = eventBucket(event, ignored);
    return bucket === "drop" ? [] : [{ event, bucket }];
  });
  if (!kept.length) return;
  let next = maxId(db);
  const insertMain = db.prepare(`INSERT OR IGNORE INTO events (${EVENT_COLS}) VALUES (${Array(16).fill("?").join(", ")})`);
  const insertNoise = db.prepare(`INSERT OR IGNORE INTO noise (${EVENT_COLS}) VALUES (${Array(16).fill("?").join(", ")})`);
  const insertBlob = db.prepare("INSERT OR IGNORE INTO blobs (hash, size, data) VALUES (?, ?, ?)");
  const store = (text: string | undefined): string | null => {
    if (text == null) return null;
    const hash = sha256(text);
    insertBlob.run(hash, Buffer.byteLength(text), deflateRawSync(text));
    return hash;
  };
  db.exec("BEGIN");
  try {
    for (const item of kept) {
      next += 1;
      const event = item.event;
      const minute = event.kind === "read" ? `${event.agent}|${event.path}|${Math.floor(event.ts / 60000)}` : null;
      const main = item.bucket === "main";
      const beforeHash = main ? store(event.beforeBlob) : null;
      const afterHash = main ? store(event.afterBlob) : null;
      const args = [next, event.ts, event.agent, event.pid, event.exe, event.kind, event.path, event.destPath ?? null, afterHash ?? event.sha256 ?? null, null, null, event.sensitive ? 1 : 0, event.source, minute, beforeHash, afterHash];
      (item.bucket === "noise" ? insertNoise : insertMain).run(...args);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const KINDS = new Set(["read", "write", "create", "delete", "rename", "exec", "net"]);

interface HistorySql {
  id: number;
  ts: number;
  agent: string;
  exe?: string;
  kind: string;
  path: string;
  dest_path: string | null;
  sensitive: number;
  before_blob?: string | null;
  after_blob?: string | null;
}

function toRow(row: HistorySql, withText: boolean): HistoryRow {
  return {
    id: row.id,
    ts: row.ts,
    agent: row.agent,
    exe: row.exe ?? "",
    kind: row.kind,
    path: row.path,
    destPath: row.dest_path,
    sensitive: row.sensitive === 1,
    beforeText: withText ? (row.before_blob ?? null) : null,
    afterText: withText ? (row.after_blob ?? null) : null,
  };
}

export interface HistoryFilter {
  from: number | null;
  to: number | null;
  agents: string[];
  path: string;
  kind: string;
  sensitive: boolean;
  includeNoise?: boolean;
  offset: number;
  limit: number;
}

const LIST_COLS = "id, ts, agent, exe, kind, path, dest_path, sensitive";

export function listHistory(db: DatabaseSync, afterId = 0, limit = 200): HistoryRow[] {
  const rows = db.prepare(`SELECT ${LIST_COLS} FROM events WHERE id > ? ORDER BY id DESC LIMIT ?`).all(afterId, limit) as unknown as HistorySql[];
  return rows.map((row) => toRow(row, false));
}

export function expandHistoryAgents(agents: string[]): string[] {
  const out = new Set<string>();
  for (const agent of agents) {
    if (!/^[a-z0-9-]+$/.test(agent)) continue;
    out.add(agent);
    if (agent === "claude" || agent === "claude-code") {
      out.add("claude");
      out.add("claude-code");
    } else if (agent === "cursor" || agent === "cursor-agent") {
      out.add("cursor");
      out.add("cursor-agent");
    }
  }
  return [...out];
}

function filters(filter: HistoryFilter): { clause: string; args: (string | number)[] } {
  const where = ["1 = 1"];
  const args: (string | number)[] = [];
  if (filter.from !== null) {
    where.push("ts >= ?");
    args.push(filter.from);
  }
  if (filter.to !== null) {
    where.push("ts <= ?");
    args.push(filter.to);
  }
  const agents = expandHistoryAgents(filter.agents);
  if (agents.length) {
    where.push(`agent IN (${agents.map(() => "?").join(", ")})`);
    args.push(...agents);
  }
  if (filter.path) {
    where.push("path LIKE ? ESCAPE '\\'");
    args.push(`%${filter.path.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
  }
  if (KINDS.has(filter.kind)) {
    where.push("kind = ?");
    args.push(filter.kind);
  }
  if (filter.sensitive) where.push("sensitive = 1");
  return { clause: where.join(" AND "), args };
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

export function queryHistory(db: DatabaseSync, filter: HistoryFilter): { rows: HistoryRow[]; total: number } {
  const { clause, args } = filters(filter);
  const tables = filter.includeNoise && hasTable(db, "noise") ? ["events", "noise"] : ["events"];
  const union = tables.map((table) => `SELECT ${LIST_COLS} FROM ${table} WHERE ${clause}`).join(" UNION ALL ");
  const unionArgs = tables.flatMap(() => args);
  const total = Number((db.prepare(`SELECT count(*) AS n FROM (${union})`).get(...unionArgs) as { n: number }).n);
  const rows = db.prepare(`SELECT * FROM (${union}) ORDER BY id DESC LIMIT ? OFFSET ?`).all(...unionArgs, filter.limit, filter.offset) as unknown as HistorySql[];
  return { rows: rows.map((row) => toRow(row, false)), total };
}

function blobText(db: DatabaseSync, hash: string | null | undefined): string | null {
  const row = hash ? (db.prepare("SELECT data FROM blobs WHERE hash = ?").get(hash) as { data: Uint8Array } | undefined) : undefined;
  return row ? inflateRawSync(row.data).toString("utf8") : null;
}

export function historyText(db: DatabaseSync, id: number): { before: string | null; after: string | null } {
  const sql = (table: string) => `SELECT before_blob, after_blob, ${hasColumn(db, table, "before_hash") ? "before_hash, after_hash" : "NULL AS before_hash, NULL AS after_hash"} FROM ${table} WHERE id = ?`;
  const row = (db.prepare(sql("events")).get(id) ?? (hasTable(db, "noise") ? db.prepare(sql("noise")).get(id) : undefined)) as { before_blob: string | null; after_blob: string | null; before_hash: string | null; after_hash: string | null } | undefined;
  return { before: blobText(db, row?.before_hash) ?? row?.before_blob ?? null, after: blobText(db, row?.after_hash) ?? row?.after_blob ?? null };
}

function verifyHistory(path: string): void {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const result = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (result.integrity_check !== "ok") throw new Error(`History integrity check failed: ${result.integrity_check}`);
  } finally {
    db.close();
  }
}

export function replaceHistory(original: string, replacement: string, verify: (path: string) => void = verifyHistory): void {
  const backup = `${original}.backup-${process.pid}-${Date.now()}`;
  renameSync(original, backup);
  try {
    renameSync(replacement, original);
    verify(original);
    rmSync(backup, { force: true });
  } catch (error) {
    rmSync(original, { force: true });
    renameSync(backup, original);
    rmSync(replacement, { force: true });
    throw error;
  }
}

export interface HistoryOptimization {
  beforeBytes: number;
  afterBytes: number;
}

export function historyStorageBytes(path: string): number {
  return ["", "-wal", "-shm"].reduce((total, suffix) => {
    const file = `${path}${suffix}`;
    return total + (existsSync(file) ? statSync(file).size : 0);
  }, 0);
}

export function optimizeHistory(path: string): HistoryOptimization {
  const before = statSync(path);
  const beforeBytes = historyStorageBytes(path);
  const replacement = `${path}.optimize-${process.pid}-${Date.now()}`;
  rmSync(replacement, { force: true });
  rmSync(`${replacement}-wal`, { force: true });
  rmSync(`${replacement}-shm`, { force: true });
  const source = new DatabaseSync(path);
  try {
    source.exec("PRAGMA busy_timeout = 0");
    const current = source.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    if (current.journal_mode === "wal") {
      let checkpoint: { busy: number; log: number; checkpointed: number };
      try {
        checkpoint = source.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number; log: number; checkpointed: number };
      } catch (error) {
        if (error instanceof Error && /busy|locked/i.test(error.message)) throw new Error("Cannot optimize history while an active history connection is open.");
        throw error;
      }
      if (checkpoint.busy !== 0 || checkpoint.log !== 0) throw new Error("Cannot optimize history while an active history connection is open.");
    }
    const mode = source.prepare("PRAGMA journal_mode = DELETE").get() as { journal_mode: string };
    if (mode.journal_mode !== "delete") throw new Error("Cannot optimize history while an active history connection is open.");
  } finally {
    source.close();
  }
  for (const suffix of ["-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  try {
    const compact = openHistoryDb(replacement);
    try {
      compact.prepare("ATTACH DATABASE ? AS source").run(path);
      compact.exec("BEGIN");
      try {
        const cols = (table: string) => (hasColumn(compact, table, "before_hash", "source") ? EVENT_COLS : LEGACY_COLS);
        compact.exec(`INSERT INTO events (${EVENT_COLS}) SELECT ${cols("events")} FROM source.events WHERE kind <> 'exec'`);
        const sourceNoise = compact.prepare("SELECT 1 AS n FROM source.sqlite_master WHERE type = 'table' AND name = 'noise'").get();
        if (sourceNoise) compact.exec(`INSERT INTO noise (${EVENT_COLS}) SELECT ${cols("noise")} FROM source.noise WHERE kind <> 'exec'`);
        if (hasColumn(compact, "blobs", "hash", "source")) compact.exec(`INSERT INTO blobs (hash, size, data) SELECT hash, size, data FROM source.blobs WHERE hash IN (${REFERENCED})`);
        const sourceMeta = compact.prepare("SELECT 1 AS n FROM source.sqlite_master WHERE type = 'table' AND name = 'meta'").get();
        if (sourceMeta) compact.exec("INSERT OR REPLACE INTO meta (key, value) SELECT key, value FROM source.meta");
        compact.exec("COMMIT");
      } catch (error) {
        compact.exec("ROLLBACK");
        throw error;
      }
      compact.exec("DETACH DATABASE source");
      compact.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const mode = compact.prepare("PRAGMA journal_mode = DELETE").get() as { journal_mode: string };
      if (mode.journal_mode !== "delete") throw new Error("Could not finalize optimized history.");
    } finally {
      compact.close();
    }
    verifyHistory(replacement);
    chmodSync(replacement, before.mode);
    if (process.platform !== "win32") chownSync(replacement, before.uid, before.gid);
    replaceHistory(path, replacement);
    return { beforeBytes, afterBytes: historyStorageBytes(path) };
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = `${replacement}${suffix}`;
      if (existsSync(file)) rmSync(file, { force: true });
    }
  }
}

export function splitHistory(db: DatabaseSync): void {
  if (db.prepare("SELECT value FROM meta WHERE key = 'noise-split'").get()) return;
  const rows = db.prepare("SELECT id, kind, path, dest_path FROM events").all() as unknown as { id: number; kind: string; path: string; dest_path: string | null }[];
  const move = db.prepare(
    `INSERT OR IGNORE INTO noise (${EVENT_COLS}) SELECT ${EVENT_COLS} FROM events WHERE id = ?`,
  );
  const del = db.prepare("DELETE FROM events WHERE id = ?");
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      const bucket = eventBucket({ kind: row.kind, path: row.path, destPath: row.dest_path });
      if (bucket === "main") continue;
      if (bucket === "noise") move.run(row.id);
      del.run(row.id);
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('noise-split', '1')").run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const IGNORED_CHUNK = 32;

export function ignoredKey(prefixes: readonly string[]): string {
  return JSON.stringify(prefixes);
}

export function appliedIgnoredKey(db: DatabaseSync): string {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'ignored-applied'").get() as { value: string } | undefined;
  return row?.value ?? "";
}

export function dropIgnored(db: DatabaseSync, prefixes: readonly string[]): void {
  const tables = ["events", ...(hasTable(db, "noise") ? ["noise"] : [])];
  const hashes: (string | null)[] = [];
  db.exec("BEGIN");
  try {
    // One scan per table per chunk; chunks keep the OR chain under SQLite's expression depth limit.
    for (let start = 0; start < prefixes.length; start += IGNORED_CHUNK) {
      const matches = prefixes.slice(start, start + IGNORED_CHUNK).map(ignoredMatchSql);
      const where = matches.map((match) => match.sql).join(" OR ");
      const args = matches.flatMap((match) => match.args);
      for (const table of tables) for (const gone of db.prepare(`DELETE FROM ${table} WHERE ${where} RETURNING before_hash, after_hash`).all(...args) as Hashed[]) hashes.push(gone.before_hash, gone.after_hash);
    }
    freeBlobs(db, hashes);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('ignored-applied', ?)").run(ignoredKey(prefixes));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function deleteOrphanBlobs(db: DatabaseSync): number {
  return Number(db.prepare(`DELETE FROM blobs WHERE ${UNREFERENCED}`).run().changes);
}

export function pruneHistory(db: DatabaseSync, now: number, mainDays = MAIN_RETENTION_DAYS, noiseDays = NOISE_RETENTION_DAYS): number {
  const deleted = Number(db.prepare("DELETE FROM events WHERE ts < ?").run(now - mainDays * DAY_MS).changes) + Number(db.prepare("DELETE FROM noise WHERE ts < ?").run(now - noiseDays * DAY_MS).changes);
  if (deleted) deleteOrphanBlobs(db);
  return deleted;
}

export function historyEvent(db: DatabaseSync, id: number): { path: string; kind: string } | null {
  const sql = "SELECT path, kind FROM events WHERE id = ?";
  const row = (db.prepare(sql).get(id) ?? (hasTable(db, "noise") ? db.prepare(sql.replace("events", "noise")).get(id) : undefined)) as { path: string; kind: string } | undefined;
  return row ?? null;
}

export function summarizeHistory(db: DatabaseSync, from: number): Omit<HistorySummary, "blocked"> {
  const rows = db.prepare("SELECT agent, kind, COUNT(*) AS n FROM events WHERE ts >= ? GROUP BY agent, kind").all(from) as unknown as { agent: string; kind: string; n: number }[];
  const agents = new Map<string, HistorySummary["agents"][number]>();
  let total = 0;
  for (const { agent, kind, n } of rows) {
    const entry = agents.get(agent) ?? { agent, reads: 0, writes: 0, execs: 0, net: 0, other: 0 };
    agents.set(agent, entry);
    total += n;
    if (kind === "read") entry.reads += n;
    else if (kind === "write" || kind === "create" || kind === "delete" || kind === "rename") entry.writes += n;
    else if (kind === "exec") entry.execs += n;
    else if (kind === "net") entry.net += n;
    else entry.other += n;
  }
  const sensitive = (db.prepare("SELECT COUNT(*) AS n FROM events WHERE ts >= ? AND sensitive = 1").get(from) as { n: number }).n;
  return { from, total, sensitive, agents: [...agents.values()] };
}

const BATCH = 5000;

export function historyUsage(db: DatabaseSync): number {
  const pragma = (name: string) => Number(Object.values(db.prepare(`PRAGMA ${name}`).get() as Record<string, number>)[0]);
  return (pragma("page_count") - pragma("freelist_count")) * pragma("page_size");
}

type Hashed = { before_hash: string | null; after_hash: string | null };

function freeBlobs(db: DatabaseSync, hashes: (string | null)[]): void {
  const unique = [...new Set(hashes.filter((hash): hash is string => hash !== null))];
  if (unique.length) db.prepare(`DELETE FROM blobs WHERE hash IN (SELECT value FROM json_each(?)) AND ${UNREFERENCED}`).run(JSON.stringify(unique));
}

function deleteOldest(db: DatabaseSync): number {
  const rows = db.prepare(`SELECT id, ts, 'events' AS source FROM events UNION ALL SELECT id, ts, 'noise' AS source FROM noise ORDER BY ts LIMIT ${BATCH}`).all() as { id: number; source: string }[];
  const hashes: (string | null)[] = [];
  db.exec("BEGIN");
  try {
    for (const table of ["events", "noise"]) {
      const ids = JSON.stringify(rows.filter((row) => row.source === table).map((row) => row.id));
      for (const gone of db.prepare(`DELETE FROM ${table} WHERE id IN (SELECT value FROM json_each(?)) RETURNING before_hash, after_hash`).all(ids) as Hashed[]) hashes.push(gone.before_hash, gone.after_hash);
    }
    freeBlobs(db, hashes);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return rows.length;
}

export function pruneBySize(db: DatabaseSync, cap: number, now: number): { deleted: number; hardCap: boolean } {
  const used = () => historyUsage(db);
  if (used() < cap * PRUNE_START) return { deleted: 0, hardCap: false };
  let deleted = 0;
  const drain = (batch: () => number, stop: number): boolean => {
    for (;;) {
      const n = batch();
      deleted += n;
      if (n && used() < stop) return true;
      if (n < BATCH) return false;
    }
  };
  const scratch = now - SCRATCH_READ_FLOOR_DAYS * DAY_MS;
  const project = now - PROJECT_READ_FLOOR_DAYS * DAY_MS;
  const steps: { table: string; where: string; args: number[] }[] = [
    { table: "noise", where: "kind = 'read' AND ts < ?", args: [scratch] },
    { table: "events", where: "kind = 'read' AND sensitive = 0 AND ts < ?", args: [project] },
    { table: "events", where: "kind = 'read' AND sensitive = 1 AND ts < ?", args: [project] },
    { table: "events", where: "kind = 'exec' AND sensitive = 0", args: [] },
    { table: "noise", where: "kind = 'exec' AND sensitive = 0", args: [] },
    { table: "noise", where: "kind <> 'read' AND sensitive = 0", args: [] },
    { table: "events", where: "kind <> 'read' AND sensitive = 0", args: [] },
  ];
  const done = steps.some(({ table, where, args }) => {
    const statement = db.prepare(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE ${where} ORDER BY ts LIMIT ${BATCH}) RETURNING before_hash, after_hash`);
    return drain(() => {
      db.exec("BEGIN");
      try {
        const gone = statement.all(...args) as Hashed[];
        freeBlobs(db, gone.flatMap((row) => [row.before_hash, row.after_hash]));
        db.exec("COMMIT");
        return gone.length;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }, cap * PRUNE_STOP);
  });
  const hardCap = !done && used() >= cap;
  if (hardCap) drain(() => deleteOldest(db), cap * HARD_CAP_STOP);
  if (deleted) {
    db.exec("PRAGMA incremental_vacuum");
    checkpointHistory(db);
  }
  return { deleted, hardCap };
}

export function historyCounts(db: DatabaseSync): HistoryStats["counts"] {
  return (["events", "noise"] as const).flatMap((table) => (hasTable(db, table) ? (db.prepare(`SELECT kind, sensitive, count(*) AS n FROM ${table} GROUP BY kind, sensitive`).all() as { kind: string; sensitive: number; n: number }[]).map((row) => ({ table, kind: row.kind, sensitive: row.sensitive === 1, rows: Number(row.n) })) : []));
}

export function writeHistoryStats(db: DatabaseSync, stats: HistoryStats): void {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('storage-stats', ?)").run(JSON.stringify(stats));
}

export function readHistoryStats(db: DatabaseSync): HistoryStats | null {
  const row = hasTable(db, "meta") ? (db.prepare("SELECT value FROM meta WHERE key = 'storage-stats'").get() as { value: string } | undefined) : undefined;
  try {
    return row ? (JSON.parse(row.value) as HistoryStats) : null;
  } catch {
    return null;
  }
}

export function purgeHistory(db: DatabaseSync, mode: Exclude<PurgeMode, "all">, now: number, days?: number): number {
  if (mode === "older" && !(days && days > 0)) throw new Error("Purging older history needs a number of days.");
  const cutoff = now - (days ?? 0) * DAY_MS;
  const plan: [string, string, number[]][] = mode === "reads" ? [["events", "kind = 'read' AND sensitive = 0", []], ["noise", "kind = 'read' AND sensitive = 0", []]] : mode === "noise" ? [["noise", "1 = 1", []], ["events", "kind = 'exec'", []]] : [["events", "ts < ?", [cutoff]], ["noise", "ts < ?", [cutoff]]];
  const deleted = plan.reduce((total, [table, where, args]) => total + Number(db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...args).changes), 0);
  if (deleted) deleteOrphanBlobs(db);
  return deleted;
}

export function resetHistory(path: string): HistoryOptimization {
  const before = existsSync(path) ? statSync(path) : null;
  const beforeBytes = historyStorageBytes(path);
  const dir = dirname(path);
  const name = basename(path);
  const stale = (file: string) => file === name || file === `${name}-wal` || file === `${name}-shm` || file.startsWith(`${name}.optimize-`) || file.startsWith(`${name}.backup-`);
  if (existsSync(dir)) for (const file of readdirSync(dir)) if (stale(file)) rmSync(join(dir, file), { force: true });
  openHistoryDb(path).close();
  if (before) {
    chmodSync(path, before.mode);
    if (process.platform !== "win32") chownSync(path, before.uid, before.gid);
  }
  return { beforeBytes, afterBytes: historyStorageBytes(path) };
}
