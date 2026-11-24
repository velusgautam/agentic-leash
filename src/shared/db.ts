import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { homeDir, leashDir } from "./constants";
import { ensureIgnored } from "./ignored";
import { expandHome, isUnder } from "./paths";
import { validateRule } from "./rules";
import { BUILTIN_SECURE_AREAS } from "./secureAreas";
import type {
  Access,
  AgentId,
  AllowRule,
  BlockRule,
  ContentGuardLane,
  ContentGuardSettings,
  DecisionRow,
  ExportAuditResult,
  FindingRow,
  Grant,
  GuardSettings,
  HealthWarning,
  ScheduledRevoke,
  SecureArea,
  SecureAreaGroup,
  SecureAreaRule,
  SessionAllow,
  ValueExceptionRow,
} from "./types";

const SAFE_COMMANDS = [
  "pwd", "whoami", "id", "id -u", "id -un", "id -g", "id -gn",
  "uname", "uname -a", "uname -m", "arch", "hostname", "tty",
  "sw_vers", "sw_vers -productName", "sw_vers -productVersion", "sw_vers -buildVersion",
  "true", "false",
  "git --version", "node --version", "npm --version", "npx --version", "pnpm --version",
  "yarn --version", "bun --version", "deno --version", "python --version", "python3 --version",
  "ruby --version", "go version", "rustc --version", "cargo --version", "java -version",
  "javac -version", "swift --version", "clang --version", "tsc --version", "docker --version",
  "gh --version", "xcodebuild -version", "xcode-select -p",
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS grants (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  path TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('read','write')),
  source TEXT NOT NULL CHECK (source IN ('leash','config')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  command TEXT
);
CREATE INDEX IF NOT EXISTS grants_live ON grants (agent, expires_at);
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('folder','command')),
  agent TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (kind, agent, value)
);
CREATE TABLE IF NOT EXISTS blocks (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('path','command')),
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (agent, kind, value)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scheduled_revokes (
  path TEXT PRIMARY KEY,
  due_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  agent TEXT NOT NULL,
  tool TEXT NOT NULL,
  paths TEXT NOT NULL,
  verdict TEXT NOT NULL,
  reason TEXT,
  grant_id INTEGER,
  duration_ms INTEGER,
  command TEXT,
  url TEXT
);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  agent TEXT NOT NULL,
  path TEXT,
  command TEXT,
  access TEXT NOT NULL,
  ttl_seconds INTEGER
);
CREATE TABLE IF NOT EXISTS ignored_noise (
  id INTEGER PRIMARY KEY,
  prefix TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS secret_touches (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  session_id TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS secret_touches_lookup ON secret_touches (agent, ts);
CREATE TABLE IF NOT EXISTS secure_areas (
  id INTEGER PRIMARY KEY,
  pattern TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  "group" TEXT NOT NULL,
  read_rule TEXT NOT NULL CHECK (read_rule IN ('allow','monitor','warn','ask','block')),
  write_rule TEXT NOT NULL CHECK (write_rule IN ('allow','monitor','warn','ask','block')),
  enabled INTEGER NOT NULL DEFAULT 1,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS session_allows (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  agent TEXT NOT NULL,
  session_id TEXT,
  access TEXT NOT NULL CHECK (access IN ('read','write')),
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS session_allows_lookup ON session_allows (agent, path);
CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  agent TEXT NOT NULL,
  session_id TEXT,
  tool TEXT NOT NULL,
  target TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  label TEXT NOT NULL,
  preview TEXT NOT NULL,
  value_hash TEXT NOT NULL,
  action TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS findings_ts_desc ON findings (ts DESC);
CREATE TABLE IF NOT EXISTS value_exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  value_hash TEXT NOT NULL UNIQUE,
  preview TEXT NOT NULL,
  label TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL
);
`;

interface GrantSql {
  id: number;
  agent: string;
  path: string;
  access: string;
  source: string;
  created_at: number;
  expires_at: number | null;
  command: string | null;
  session_id?: string | null;
  idle_seconds?: number | null;
  last_used_at?: number | null;
}

function ensureSafeCommandRules(db: DatabaseSync): void {
  if (getSetting(db, "safe_command_seed_v1")) return;
  const insert = db.prepare("INSERT OR IGNORE INTO rules (kind, agent, value, created_at) VALUES ('command', '*', ?, ?)");
  db.exec("BEGIN");
  try {
    const now = Date.now();
    for (const command of SAFE_COMMANDS) insert.run(command, now);
    setSetting(db, "safe_command_seed_v1", "1");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function toGrant(row: GrantSql): Grant {
  return {
    id: row.id,
    agent: row.agent as AgentId | "*",
    path: row.path,
    access: row.access as Access,
    source: row.source as "leash" | "config",
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    command: row.command ?? null,
    sessionId: row.session_id ?? null,
    idleSeconds: row.idle_seconds ?? null,
    lastUsedAt: row.last_used_at ?? null,
  };
}

function ensureSecureAreas(db: DatabaseSync): void {
  if (getSetting(db, "secure_areas_seed_v1")) return;
  const insert = db.prepare(
    'INSERT OR IGNORE INTO secure_areas (pattern, label, "group", read_rule, write_rule, enabled, builtin, created_at) VALUES (?, ?, ?, ?, ?, 1, 1, ?)',
  );
  db.exec("BEGIN");
  try {
    const now = Date.now();
    for (const area of BUILTIN_SECURE_AREAS) {
      insert.run(area.pattern, area.label, area.group, area.readRule, area.writeRule, now);
    }
    setSetting(db, "secure_areas_seed_v1", "1");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrateSecureAreasCheckConstraint(db: DatabaseSync): void {
  const meta = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'secure_areas'")
    .get() as { sql: string } | undefined;
  if (!meta?.sql) return;
  const hasMonitor = /['"]monitor['"]/.test(meta.sql);
  const hasWarn = /['"]warn['"]/.test(meta.sql);
  if (hasMonitor && hasWarn) return;

  db.exec("BEGIN");
  try {
    db.exec(`
      DROP TABLE IF EXISTS secure_areas_new;
      CREATE TABLE secure_areas_new (
        id INTEGER PRIMARY KEY,
        pattern TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        "group" TEXT NOT NULL,
        read_rule TEXT NOT NULL CHECK (read_rule IN ('allow','monitor','warn','ask','block')),
        write_rule TEXT NOT NULL CHECK (write_rule IN ('allow','monitor','warn','ask','block')),
        enabled INTEGER NOT NULL DEFAULT 1,
        builtin INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      INSERT INTO secure_areas_new (id, pattern, label, "group", read_rule, write_rule, enabled, builtin, created_at)
      SELECT id, pattern, label, "group", read_rule, write_rule, enabled, builtin, created_at FROM secure_areas;
      DROP TABLE secure_areas;
      ALTER TABLE secure_areas_new RENAME TO secure_areas;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function openGrantsDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(SCHEMA);
  migrateSecureAreasCheckConstraint(db);
  const cols = db.prepare("PRAGMA table_info(grants)").all() as { name: string }[];
  for (const [name, type] of [["command", "TEXT"], ["session_id", "TEXT"], ["idle_seconds", "INTEGER"], ["last_used_at", "INTEGER"]]) {
    if (!cols.some((col) => col.name === name)) db.exec(`ALTER TABLE grants ADD COLUMN ${name} ${type}`);
  }
  const decisionCols = db.prepare("PRAGMA table_info(decisions)").all() as { name: string }[];
  for (const [name, type] of [["command", "TEXT"], ["url", "TEXT"], ["session_id", "TEXT"], ["secret", "INTEGER"], ["prompted", "INTEGER"]]) {
    if (!decisionCols.some((col) => col.name === name)) db.exec(`ALTER TABLE decisions ADD COLUMN ${name} ${type}`);
  }
  const ignoredCols = db.prepare("PRAGMA table_info(ignored_noise)").all() as { name: string }[];
  if (!ignoredCols.some((col) => col.name === "created_at")) {
    db.exec("ALTER TABLE ignored_noise ADD COLUMN created_at INTEGER");
  }
  ensureIgnored(db);
  ensureSafeCommandRules(db);
  ensureSecureAreas(db);
  return db;
}

export const openDb = openGrantsDb;

export function checkpointGrantsDb(db: DatabaseSync): void {
  db.exec("PRAGMA busy_timeout = 0");
  try {
    db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  } catch (error) {
    if (!(error instanceof Error && /busy|locked/i.test(error.message))) throw error;
    try {
      db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
    } catch {
      /* ignore busy passive checkpoint */
    }
  } finally {
    db.exec("PRAGMA busy_timeout = 5000");
  }
}

export function listGrants(db: DatabaseSync): Grant[] {
  return db.prepare("SELECT * FROM grants ORDER BY id").all().map((row) => toGrant(row as unknown as GrantSql));
}

type GrantWrite = {
  agent: string;
  path: string;
  access: Access;
  source: "leash" | "config";
  createdAt: number;
  expiresAt: number | null;
  command?: string | null;
  sessionId?: string | null;
  idleSeconds?: number | null;
};

export function insertGrant(db: DatabaseSync, grant: GrantWrite): number {
  const result = db
    .prepare("INSERT INTO grants (agent, path, access, source, created_at, expires_at, command, session_id, idle_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(grant.agent, grant.path, grant.access, grant.source, grant.createdAt, grant.expiresAt, grant.command ?? null, grant.sessionId ?? null, grant.idleSeconds ?? null);
  return Number(result.lastInsertRowid);
}

export function upsertGrant(db: DatabaseSync, grant: GrantWrite): number {
  const existing = db
    .prepare(
      "SELECT id, created_at, expires_at FROM grants WHERE agent = ? AND path = ? AND access = ? AND source = ? AND command IS NULL AND session_id IS ? AND (idle_seconds IS NULL) = ? ORDER BY id LIMIT 1",
    )
    .get(grant.agent, grant.path, grant.access, grant.source, grant.sessionId ?? null, grant.idleSeconds == null ? 1 : 0) as { id: number; created_at: number; expires_at: number | null } | undefined;
  if (!existing) return insertGrant(db, grant);
  const expiresAt = existing.expires_at === null || grant.expiresAt === null ? null : Math.max(existing.expires_at, grant.expiresAt);
  if (expiresAt === existing.expires_at) return existing.id;
  db.prepare("UPDATE grants SET created_at = ?, expires_at = ? WHERE id = ?").run(grant.createdAt, expiresAt, existing.id);
  return existing.id;
}

export function upsertCommandGrant(db: DatabaseSync, grant: { agent: string; command: string; createdAt: number; expiresAt: number | null }): number {
  const existing = db
    .prepare("SELECT id, created_at, expires_at FROM grants WHERE agent = ? AND command = ? AND path = '' AND command IS NOT NULL AND access = 'write' AND source = 'leash' ORDER BY id LIMIT 1")
    .get(grant.agent, grant.command) as { id: number; created_at: number; expires_at: number | null } | undefined;
  if (!existing) {
    return insertGrant(db, { agent: grant.agent, path: "", access: "write", source: "leash", createdAt: grant.createdAt, expiresAt: grant.expiresAt, command: grant.command });
  }
  const expiresAt = existing.expires_at === null || grant.expiresAt === null ? null : Math.max(existing.expires_at, grant.expiresAt);
  if (expiresAt === existing.expires_at) return existing.id;
  db.prepare("UPDATE grants SET created_at = ?, expires_at = ? WHERE id = ?").run(existing.created_at, expiresAt, existing.id);
  return existing.id;
}

export function collapseGrantDupes(db: DatabaseSync): void {
  const groups = new Map<string, Grant[]>();
  for (const grant of listGrants(db)) {
    const key = `${grant.source}\0${grant.agent}\0${grant.access}\0${grant.path}\0${grant.command ?? ""}\0${grant.sessionId ?? ""}\0${grant.idleSeconds ?? ""}`;
    const group = groups.get(key);
    if (group) group.push(grant);
    else groups.set(key, [grant]);
  }
  const update = db.prepare("UPDATE grants SET expires_at = ? WHERE id = ?");
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const keep = group.reduce((a, b) => (a.id < b.id ? a : b));
    const expiresAt = group.some((grant) => grant.expiresAt === null) ? null : Math.max(...group.map((grant) => grant.expiresAt ?? 0));
    if (keep.expiresAt !== expiresAt) update.run(expiresAt, keep.id);
    for (const grant of group) if (grant.id !== keep.id) deleteGrant(db, grant.id);
  }
}

export function listScheduled(db: DatabaseSync): ScheduledRevoke[] {
  const rows = db.prepare("SELECT path, due_at FROM scheduled_revokes ORDER BY due_at").all() as unknown as { path: string; due_at: number }[];
  return rows.map((row) => ({ path: row.path, dueAt: row.due_at }));
}

export function scheduleRevoke(db: DatabaseSync, path: string, dueAt: number): void {
  db.prepare("INSERT INTO scheduled_revokes (path, due_at) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET due_at = excluded.due_at").run(path, dueAt);
}

export function cancelScheduled(db: DatabaseSync, path: string): void {
  db.prepare("DELETE FROM scheduled_revokes WHERE path = ?").run(path);
}

export function deleteGrant(db: DatabaseSync, id: number): void {
  db.prepare("DELETE FROM grants WHERE id = ?").run(id);
}

export function deleteGrants(db: DatabaseSync, where: string, ...args: (string | number)[]): number {
  const result = db.prepare(`DELETE FROM grants WHERE ${where}`).run(...args);
  return Number(result.changes);
}

export function getSetting(db: DatabaseSync, key: string, fallback = ""): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export function setSetting(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function getAutoAcceptMode(db: DatabaseSync): { until: number; agent: string } {
  const until = Number(getSetting(db, "auto_accept_mode_until", "0")) || 0;
  const agent = getSetting(db, "auto_accept_mode_agent", "*");
  return { until, agent };
}

export function setAutoAcceptMode(db: DatabaseSync, until: number, agent = "*"): void {
  setSetting(db, "auto_accept_mode_until", String(until));
  setSetting(db, "auto_accept_mode_agent", agent);
}

export function clearAutoAcceptMode(db: DatabaseSync): void {
  setSetting(db, "auto_accept_mode_until", "0");
  setSetting(db, "auto_accept_mode_agent", "*");
}

export function getGodMode(db: DatabaseSync): { until: number; agent: string } {
  const until = Number(getSetting(db, "god_mode_until", "0")) || 0;
  const agent = getSetting(db, "god_mode_agent", "*");
  return { until, agent };
}

export function setGodMode(db: DatabaseSync, until: number, agent = "*"): void {
  setSetting(db, "god_mode_until", String(until));
  setSetting(db, "god_mode_agent", agent);
}

export function clearGodMode(db: DatabaseSync): void {
  setSetting(db, "god_mode_until", "0");
  setSetting(db, "god_mode_agent", "*");
}

export function recordSecretTouch(
  db: DatabaseSync,
  touch: { agent: string; sessionId?: string; ts: number },
): void {
  db.prepare("INSERT INTO secret_touches (agent, session_id, ts) VALUES (?, ?, ?)").run(
    touch.agent,
    touch.sessionId ?? null,
    touch.ts,
  );
}

export function pruneSecretTouches(db: DatabaseSync, olderThan: number): number {
  if (!Number.isFinite(olderThan) || olderThan <= 0) return 0;
  return Number(db.prepare("DELETE FROM secret_touches WHERE ts < ?").run(olderThan).changes);
}

export function recordDecision(
  db: DatabaseSync,
  row: { ts: number; agent: string; tool: string; paths: string[]; verdict: string; reason?: string; grantId?: number; durationMs?: number; command?: string; url?: string; sessionId?: string; secret?: boolean; prompted?: boolean },
): void {
  db.prepare(
    "INSERT INTO decisions (ts, agent, tool, paths, verdict, reason, grant_id, duration_ms, command, url, session_id, secret, prompted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    row.ts,
    row.agent,
    row.tool,
    JSON.stringify(row.paths),
    row.verdict,
    row.reason ?? null,
    row.grantId ?? null,
    row.durationMs ?? null,
    row.command ?? null,
    row.url ?? null,
    row.sessionId ?? null,
    row.secret ? 1 : 0,
    row.prompted ? 1 : 0,
  );
  if (row.secret && row.verdict === "pass") {
    try {
      recordSecretTouch(db, { agent: row.agent, sessionId: row.sessionId, ts: row.ts });
    } catch {
      /* ignore if secret_touches table absent in raw test db */
    }
  }
}

/** True when this agent session was let through to a secret since `since`. Without a session id, any session of the agent counts. */
export function readSecretSince(
  db: DatabaseSync,
  agent: string,
  sessionId: string | undefined,
  since: number,
  historyDb?: DatabaseSync | null,
): boolean {
  const sid = sessionId && sessionId.length > 0 ? sessionId : null;
  try {
    const touchRow = sid !== null
      ? db
          .prepare("SELECT 1 AS n FROM secret_touches WHERE agent = ? AND ts >= ? AND session_id = ? LIMIT 1")
          .get(agent, since, sid)
      : db
          .prepare("SELECT 1 AS n FROM secret_touches WHERE agent = ? AND ts >= ? LIMIT 1")
          .get(agent, since);
    if (touchRow !== undefined) return true;
  } catch {
    /* fallback to decisions and unscoped history */
  }
  try {
    const row = sid !== null
      ? db
          .prepare("SELECT 1 AS n FROM decisions WHERE agent = ? AND secret = 1 AND verdict = 'pass' AND ts >= ? AND session_id = ? LIMIT 1")
          .get(agent, since, sid)
      : db
          .prepare("SELECT 1 AS n FROM decisions WHERE agent = ? AND secret = 1 AND verdict = 'pass' AND ts >= ? LIMIT 1")
          .get(agent, since);
    if (row !== undefined) return true;
  } catch {
    /* fallback to unscoped history */
  }
  if (sid === null && historyDb) {
    try {
      const histRow = historyDb
        .prepare("SELECT 1 AS n FROM events WHERE agent = ? AND sensitive = 1 AND ts >= ? LIMIT 1")
        .get(agent, since);
      if (histRow !== undefined) return true;
    } catch {
      /* ignore history read error */
    }
  }
  return false;
}

/**
 * Marks grants as used. A grant with an idle limit moves its expiry to `now + idle`,
 * capped at `maxMs` after it was approved.
 */
export function touchGrants(db: DatabaseSync, ids: number[], now: number, maxMs: number): void {
  if (!ids.length) return;
  db.prepare(
    "UPDATE grants SET last_used_at = ?, expires_at = CASE WHEN idle_seconds IS NULL THEN expires_at ELSE MIN(? + idle_seconds * 1000, created_at + ?) END WHERE id IN (SELECT value FROM json_each(?))",
  ).run(now, now, maxMs, JSON.stringify(ids));
}

export interface DecisionStat { ts: number; agent: string; verdict: string; durationMs: number | null; paths: string; secret: boolean; prompted: boolean }

export function decisionsSince(db: DatabaseSync, since: number): DecisionStat[] {
  const rows = db.prepare("SELECT ts, agent, verdict, duration_ms, paths, secret, prompted FROM decisions WHERE ts >= ? ORDER BY ts").all(since) as unknown as {
    ts: number;
    agent: string;
    verdict: string;
    duration_ms: number | null;
    paths: string;
    secret: number | null;
    prompted: number | null;
  }[];
  return rows.map((row) => ({ ts: row.ts, agent: row.agent, verdict: row.verdict, durationMs: row.duration_ms, paths: row.paths, secret: row.secret === 1, prompted: row.prompted === 1 }));
}

interface DecisionSql {
  id: number;
  ts: number;
  agent: string;
  tool: string;
  paths: string;
  verdict: string;
  reason: string | null;
  grant_id: number | null;
  duration_ms: number | null;
  command: string | null;
  url: string | null;
}

function toDecisionRow(row: DecisionSql): DecisionRow {
  return {
    id: row.id,
    ts: row.ts,
    agent: row.agent,
    tool: row.tool,
    paths: row.paths,
    verdict: row.verdict,
    reason: row.reason,
    grantId: row.grant_id,
    durationMs: row.duration_ms,
    command: row.command ?? null,
    url: row.url ?? null,
  };
}

export function listDecisions(db: DatabaseSync, limit = 200): DecisionRow[] {
  const rows = db.prepare("SELECT * FROM decisions ORDER BY id DESC LIMIT ?").all(limit) as unknown as DecisionSql[];
  return rows.map(toDecisionRow);
}

export function listDeniedDecisions(db: DatabaseSync, limit = 200): DecisionRow[] {
  const rows = db
    .prepare("SELECT * FROM decisions WHERE verdict IN ('deny', 'timeout') ORDER BY ts DESC, id DESC LIMIT ?")
    .all(limit) as unknown as DecisionSql[];
  return rows.map(toDecisionRow);
}

export function decisionDurations(db: DatabaseSync): number[] {
  return (db.prepare("SELECT duration_ms FROM decisions WHERE duration_ms IS NOT NULL AND (prompted IS NULL OR prompted = 0)").all() as unknown as { duration_ms: number }[]).map(
    (row) => row.duration_ms,
  );
}

export function pruneDecisions(db: DatabaseSync, olderThan: number): number {
  if (!Number.isFinite(olderThan) || olderThan <= 0) return 0;
  return Number(db.prepare("DELETE FROM decisions WHERE ts < ?").run(olderThan).changes);
}

function ruleRows(db: DatabaseSync): AllowRule[] {
  const rows = db.prepare("SELECT id, kind, agent, value, created_at FROM rules ORDER BY id").all() as {
    id: number;
    kind: AllowRule["kind"];
    agent: AllowRule["agent"];
    value: string;
    created_at: number;
  }[];
  return rows.map((row) => ({ id: row.id, kind: row.kind, agent: row.agent, value: row.value, createdAt: row.created_at }));
}

export function listRules(db: DatabaseSync): AllowRule[] {
  return ruleRows(db);
}

export function createRule(db: DatabaseSync, input: { kind: unknown; agent: unknown; value: unknown }, home: string, now: number): { rules: AllowRule[]; error: string | null } {
  const parsed = validateRule(input, home);
  if (!parsed.ok) return { rules: ruleRows(db), error: parsed.error };
  if (ruleRows(db).some((rule) => rule.kind === parsed.kind && rule.agent === parsed.agent && rule.value === parsed.value)) {
    return { rules: ruleRows(db), error: "Already in the allow list." };
  }
  db.prepare("INSERT INTO rules (kind, agent, value, created_at) VALUES (?, ?, ?, ?)").run(parsed.kind, parsed.agent, parsed.value, now);
  return { rules: ruleRows(db), error: null };
}

export function updateRule(db: DatabaseSync, id: number, input: { kind: unknown; agent: unknown; value: unknown }, home: string, now: number): { rules: AllowRule[]; error: string | null } {
  const parsed = validateRule(input, home);
  if (!parsed.ok) return { rules: ruleRows(db), error: parsed.error };
  const rows = ruleRows(db);
  if (!rows.some((rule) => rule.id === id)) return { rules: rows, error: "That rule is gone." };
  if (rows.some((rule) => rule.id !== id && rule.kind === parsed.kind && rule.agent === parsed.agent && rule.value === parsed.value)) {
    return { rules: rows, error: "Already in the allow list." };
  }
  db.prepare("UPDATE rules SET kind = ?, agent = ?, value = ?, created_at = ? WHERE id = ?").run(parsed.kind, parsed.agent, parsed.value, now, id);
  return { rules: ruleRows(db), error: null };
}

export function deleteRule(db: DatabaseSync, id: number): AllowRule[] {
  db.prepare("DELETE FROM rules WHERE id = ?").run(id);
  return ruleRows(db);
}

export function extendGrant(db: DatabaseSync, id: number, seconds: number, now: number): number | null {
  const result = db.prepare("UPDATE grants SET expires_at = MAX(expires_at, ?) + ? WHERE id = ? AND expires_at IS NOT NULL AND source = 'leash'").run(now, seconds * 1000, id);
  if (Number(result.changes) === 0) return null;
  return (db.prepare("SELECT expires_at FROM grants WHERE id = ?").get(id) as { expires_at: number }).expires_at;
}

export interface ApprovalRow { id?: number; ts: number; agent: string; path: string | null; command: string | null; access: Access; ttlSeconds: number | null }

export function recordApproval(db: DatabaseSync, row: Omit<ApprovalRow, "id">): void {
  db.prepare("INSERT INTO approvals (ts, agent, path, command, access, ttl_seconds) VALUES (?, ?, ?, ?, ?, ?)").run(row.ts, row.agent, row.path, row.command, row.access, row.ttlSeconds);
}

export function listApprovals(db: DatabaseSync, since: number): ApprovalRow[] {
  const rows = db.prepare("SELECT * FROM approvals WHERE ts >= ? ORDER BY id").all(since) as unknown as { id: number; ts: number; agent: string; path: string | null; command: string | null; access: string; ttl_seconds: number | null }[];
  return rows.map((row) => ({ id: row.id, ts: row.ts, agent: row.agent, path: row.path, command: row.command, access: row.access as Access, ttlSeconds: row.ttl_seconds }));
}

export function pruneApprovals(db: DatabaseSync, olderThan: number): number {
  if (!Number.isFinite(olderThan) || olderThan <= 0) return 0;
  return Number(db.prepare("DELETE FROM approvals WHERE ts < ?").run(olderThan).changes);
}

export function healthFilePath(home = homeDir()): string {
  return join(leashDir(home), "health.json");
}

export function recordHealthWarning(db: DatabaseSync | null | undefined, warning: HealthWarning, home?: string): void {
  const payload = JSON.stringify({ ts: warning.ts, message: warning.message });
  if (db) {
    try {
      setSetting(db, "health_warning", payload);
    } catch {
      /* fallback to health.json when db is locked or read-only */
    }
  }
  if (home || !db) {
    try {
      const file = healthFilePath(home);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${payload}\n`, "utf8");
    } catch {
      /* never fail the caller */
    }
  }
}

function parseHealthWarning(raw: string): HealthWarning | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<HealthWarning>;
    if (typeof parsed.ts === "number" && typeof parsed.message === "string" && parsed.message.length > 0) {
      return { ts: parsed.ts, message: parsed.message };
    }
  } catch {
    /* ignore malformed json */
  }
  return null;
}

export function getHealthWarning(db: DatabaseSync | null | undefined, home?: string): HealthWarning | null {
  let fromDb: HealthWarning | null = null;
  if (db) {
    try {
      fromDb = parseHealthWarning(getSetting(db, "health_warning", ""));
    } catch {
      fromDb = null;
    }
  }
  let fromFile: HealthWarning | null = null;
  try {
    const file = healthFilePath(home);
    if (existsSync(file)) {
      fromFile = parseHealthWarning(readFileSync(file, "utf8"));
    }
  } catch {
    fromFile = null;
  }
  if (fromDb && fromFile) return fromDb.ts >= fromFile.ts ? fromDb : fromFile;
  return fromDb ?? fromFile;
}

export function clearHealthWarning(db: DatabaseSync | null | undefined, home?: string): void {
  if (db) {
    try {
      db.prepare("DELETE FROM settings WHERE key = 'health_warning'").run();
    } catch {
      /* ignore */
    }
  }
  try {
    const file = healthFilePath(home);
    if (existsSync(file)) rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
}

export interface ExportAuditOptions {
  targetDir: string;
  grantsPath: string;
  historyPath?: string | null;
  userHistoryPath?: string | null;
}

function vacuumInto(sourcePath: string, destPath: string): void {
  mkdirSync(dirname(destPath), { recursive: true });
  if (existsSync(destPath)) rmSync(destPath, { force: true });
  const escaped = destPath.replace(/'/g, "''");
  let db: DatabaseSync | null = null;
  try {
    try {
      db = new DatabaseSync(sourcePath);
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec(`VACUUM INTO '${escaped}'`);
      return;
    } catch {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
      db = null;
    }
    db = new DatabaseSync(sourcePath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(`VACUUM INTO '${escaped}'`);
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

export function exportAuditData(options: ExportAuditOptions): ExportAuditResult {
  try {
    mkdirSync(options.targetDir, { recursive: true });
    const files: string[] = [];
    const candidates: [string | null | undefined, string][] = [
      [options.grantsPath, "grants.db"],
      [options.historyPath, "history.db"],
      [
        options.userHistoryPath && options.userHistoryPath !== options.historyPath ? options.userHistoryPath : null,
        "history-user.db",
      ],
    ];
    for (const [src, name] of candidates) {
      if (!src || !existsSync(src)) continue;
      const dest = join(options.targetDir, name);
      vacuumInto(src, dest);
      files.push(dest);
    }
    return { ok: true, exportDir: options.targetDir, files };
  } catch (error) {
    return {
      ok: false,
      exportDir: null,
      files: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function countBlocked(db: DatabaseSync, from: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE ts >= ? AND verdict IN ('deny','timeout')").get(from) as { n: number }).n;
}

export function listBlocks(db: DatabaseSync): BlockRule[] {
  const rows = db.prepare("SELECT id, agent, kind, value, created_at FROM blocks ORDER BY id").all() as unknown as { id: number; agent: BlockRule["agent"]; kind: BlockRule["kind"]; value: string; created_at: number }[];
  return rows.map((row) => ({ id: row.id, agent: row.agent, kind: row.kind, value: row.value, createdAt: row.created_at }));
}

/** Adds a "Never" rule, or returns the id of the one already there. */
export function addBlock(db: DatabaseSync, block: Omit<BlockRule, "id" | "createdAt">, now: number): number {
  db.prepare("INSERT OR IGNORE INTO blocks (agent, kind, value, created_at) VALUES (?, ?, ?, ?)").run(block.agent, block.kind, block.value, now);
  return (db.prepare("SELECT id FROM blocks WHERE agent = ? AND kind = ? AND value = ?").get(block.agent, block.kind, block.value) as { id: number }).id;
}

export function deleteBlocks(db: DatabaseSync, ids: number[]): number {
  if (!ids.length) return 0;
  return Number(db.prepare("DELETE FROM blocks WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(ids)).changes);
}

interface SecureAreaSql {
  id: number;
  pattern: string;
  label: string;
  group: string;
  read_rule: string;
  write_rule: string;
  enabled: number;
  builtin: number;
  created_at: number;
}

function toSecureArea(row: SecureAreaSql): SecureArea {
  return {
    id: row.id,
    pattern: row.pattern,
    label: row.label,
    group: row.group as SecureAreaGroup,
    readRule: row.read_rule as SecureAreaRule,
    writeRule: row.write_rule as SecureAreaRule,
    enabled: row.enabled === 1,
    builtin: row.builtin === 1,
    createdAt: row.created_at,
  };
}

export function listSecureAreas(db: DatabaseSync): SecureArea[] {
  const rows = db.prepare('SELECT id, pattern, label, "group", read_rule, write_rule, enabled, builtin, created_at FROM secure_areas ORDER BY id').all() as unknown as SecureAreaSql[];
  return rows.map(toSecureArea);
}

export function upsertSecureArea(
  db: DatabaseSync,
  input: {
    pattern: string;
    label?: string;
    group?: SecureAreaGroup;
    readRule: SecureAreaRule;
    writeRule: SecureAreaRule;
    enabled?: boolean;
    builtin?: boolean;
    createdAt?: number;
  },
): SecureArea {
  const pattern = input.pattern.trim();
  const label = (input.label ?? (pattern.split("/").filter(Boolean).pop() || pattern)).trim();
  const group: SecureAreaGroup = input.group ?? "custom";
  const enabled = input.enabled === false ? 0 : 1;
  const builtin = input.builtin ? 1 : 0;
  const createdAt = input.createdAt ?? Date.now();
  db.prepare(
    `INSERT INTO secure_areas (pattern, label, "group", read_rule, write_rule, enabled, builtin, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(pattern) DO UPDATE SET
       label = excluded.label,
       "group" = excluded."group",
       read_rule = excluded.read_rule,
       write_rule = excluded.write_rule,
       enabled = excluded.enabled`,
  ).run(pattern, label, group, input.readRule, input.writeRule, enabled, builtin, createdAt);
  const row = db
    .prepare('SELECT id, pattern, label, "group", read_rule, write_rule, enabled, builtin, created_at FROM secure_areas WHERE pattern = ?')
    .get(pattern) as unknown as SecureAreaSql;
  return toSecureArea(row);
}

export function updateSecureArea(
  db: DatabaseSync,
  id: number,
  patch: Partial<Pick<SecureArea, "pattern" | "label" | "group" | "readRule" | "writeRule" | "enabled">>,
): SecureArea | null {
  const existing = db
    .prepare('SELECT id, pattern, label, "group", read_rule, write_rule, enabled, builtin, created_at FROM secure_areas WHERE id = ?')
    .get(id) as unknown as SecureAreaSql | undefined;
  if (!existing) return null;
  const nextPattern = patch.pattern !== undefined ? patch.pattern.trim() : existing.pattern;
  const nextLabel = patch.label !== undefined ? patch.label.trim() : existing.label;
  const nextGroup = patch.group ?? existing.group;
  const nextRead = patch.readRule ?? existing.read_rule;
  const nextWrite = patch.writeRule ?? existing.write_rule;
  const nextEnabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled;
  db.prepare(
    'UPDATE secure_areas SET pattern = ?, label = ?, "group" = ?, read_rule = ?, write_rule = ?, enabled = ? WHERE id = ?',
  ).run(nextPattern, nextLabel, nextGroup, nextRead, nextWrite, nextEnabled, id);
  const updated = db
    .prepare('SELECT id, pattern, label, "group", read_rule, write_rule, enabled, builtin, created_at FROM secure_areas WHERE id = ?')
    .get(id) as unknown as SecureAreaSql;
  return toSecureArea(updated);
}

export function deleteSecureArea(db: DatabaseSync, id: number): boolean {
  return Number(db.prepare("DELETE FROM secure_areas WHERE id = ?").run(id).changes) > 0;
}

interface SessionAllowSql {
  id: number;
  path: string;
  agent: string;
  session_id: string | null;
  access: string;
  expires_at: number | null;
  created_at: number;
}

function toSessionAllow(row: SessionAllowSql): SessionAllow {
  return {
    id: row.id,
    path: row.path,
    agent: row.agent,
    sessionId: row.session_id ?? null,
    access: row.access as Access,
    expiresAt: row.expires_at ?? null,
    createdAt: row.created_at,
  };
}

export function listSessionAllows(db: DatabaseSync, now?: number): SessionAllow[] {
  const rows = (
    now === undefined
      ? db.prepare("SELECT id, path, agent, session_id, access, expires_at, created_at FROM session_allows ORDER BY id").all()
      : db
          .prepare("SELECT id, path, agent, session_id, access, expires_at, created_at FROM session_allows WHERE expires_at IS NULL OR expires_at > ? ORDER BY id")
          .all(now)
  ) as unknown as SessionAllowSql[];
  return rows.map(toSessionAllow);
}

export function grantSessionAllow(
  db: DatabaseSync,
  input: {
    path: string;
    agent: string;
    sessionId?: string | null;
    access: Access;
    expiresAt: number | null;
    createdAt?: number;
  },
): SessionAllow {
  const sessionId = input.sessionId ?? null;
  const createdAt = input.createdAt ?? Date.now();
  const existing = db
    .prepare(
      "SELECT id, path, agent, session_id, access, expires_at, created_at FROM session_allows WHERE path = ? AND agent = ? AND session_id IS ? AND access = ? ORDER BY id LIMIT 1",
    )
    .get(input.path, input.agent, sessionId, input.access) as unknown as SessionAllowSql | undefined;
  if (existing) {
    const expiresAt =
      existing.expires_at === null || input.expiresAt === null
        ? null
        : Math.max(existing.expires_at, input.expiresAt);
    db.prepare("UPDATE session_allows SET expires_at = ?, created_at = ? WHERE id = ?").run(expiresAt, createdAt, existing.id);
    const updated = db
      .prepare("SELECT id, path, agent, session_id, access, expires_at, created_at FROM session_allows WHERE id = ?")
      .get(existing.id) as unknown as SessionAllowSql;
    return toSessionAllow(updated);
  }
  const result = db
    .prepare("INSERT INTO session_allows (path, agent, session_id, access, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(input.path, input.agent, sessionId, input.access, input.expiresAt, createdAt);
  const row = db
    .prepare("SELECT id, path, agent, session_id, access, expires_at, created_at FROM session_allows WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as unknown as SessionAllowSql;
  return toSessionAllow(row);
}

export function revokeSessionAllow(db: DatabaseSync, id: number): boolean {
  return Number(db.prepare("DELETE FROM session_allows WHERE id = ?").run(id).changes) > 0;
}

export function sessionAllowsCoverPath(
  allows: readonly SessionAllow[],
  query: { path: string; agent: string; sessionId?: string; access: Access; now: number; home?: string },
): boolean {
  const target = query.home ? expandHome(query.path, query.home) : query.path;
  return allows.some((allow) => {
    if (allow.agent !== "*" && allow.agent !== query.agent) return false;
    if (allow.expiresAt !== null && allow.expiresAt <= query.now) return false;
    if (allow.sessionId && allow.sessionId !== query.sessionId) return false;
    if (allow.access !== "write" && query.access === "write") return false;
    const allowedPath = query.home ? expandHome(allow.path, query.home) : allow.path;
    return isUnder(target, allowedPath);
  });
}

export function isAllowedBySessionAllow(
  db: DatabaseSync,
  query: { path: string; agent: string; sessionId?: string; access: Access; now: number; home?: string },
): boolean {
  const allows = listSessionAllows(db, query.now);
  return sessionAllowsCoverPath(allows, query);
}

export function getGuardSettings(db: DatabaseSync): GuardSettings {
  return {
    destructiveCommands: getSetting(db, "guard_destructive_commands", "1") !== "0",
    egressAfterSecret: getSetting(db, "guard_egress_after_secret", "1") !== "0",
  };
}

export function setGuardSettings(db: DatabaseSync, patch: Partial<GuardSettings>): GuardSettings {
  if (patch.destructiveCommands !== undefined) {
    setSetting(db, "guard_destructive_commands", patch.destructiveCommands ? "1" : "0");
  }
  if (patch.egressAfterSecret !== undefined) {
    setSetting(db, "guard_egress_after_secret", patch.egressAfterSecret ? "1" : "0");
  }
  return getGuardSettings(db);
}

export function isSecureAreasSetupDone(db: DatabaseSync): boolean {
  return getSetting(db, "secure_areas_setup_done", "0") === "1";
}

export function setSecureAreasSetupDone(db: DatabaseSync, done = true): void {
  setSetting(db, "secure_areas_setup_done", done ? "1" : "0");
}

export function getVerboseCapture(db: DatabaseSync): boolean {
  return getSetting(db, "verbose_capture", "0") === "1";
}

export function setVerboseCapture(db: DatabaseSync, enabled: boolean): boolean {
  setSetting(db, "verbose_capture", enabled ? "1" : "0");
  return enabled;
}

interface FindingSql {
  id: number;
  ts: number;
  agent: string;
  session_id: string | null;
  tool: string;
  target: string;
  rule_id: string;
  category: string;
  severity: string;
  label: string;
  preview: string;
  value_hash: string;
  action: string;
}

function toFindingRow(row: FindingSql): FindingRow {
  return {
    id: row.id,
    ts: row.ts,
    agent: row.agent,
    sessionId: row.session_id ?? null,
    tool: row.tool,
    target: row.target,
    ruleId: row.rule_id,
    category: row.category as FindingRow["category"],
    severity: row.severity as FindingRow["severity"],
    label: row.label,
    preview: row.preview,
    valueHash: row.value_hash,
    action: row.action,
  };
}

export interface RecordFindingInput {
  ts?: number;
  agent: string;
  sessionId?: string | null;
  tool: string;
  target: string;
  ruleId: string;
  category: FindingRow["category"];
  severity: FindingRow["severity"];
  label: string;
  preview: string;
  valueHash: string;
  action: string;
}

export function recordFinding(db: DatabaseSync, input: RecordFindingInput): FindingRow {
  const ts = input.ts ?? Date.now();
  const sessionId = input.sessionId ?? null;
  const result = db
    .prepare(
      "INSERT INTO findings (ts, agent, session_id, tool, target, rule_id, category, severity, label, preview, value_hash, action) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      ts,
      input.agent,
      sessionId,
      input.tool,
      input.target,
      input.ruleId,
      input.category,
      input.severity,
      input.label,
      input.preview,
      input.valueHash,
      input.action,
    );
  const row = db
    .prepare("SELECT * FROM findings WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as unknown as FindingSql;
  return toFindingRow(row);
}

export function listFindings(db: DatabaseSync, limit = 200): FindingRow[] {
  const rows = db
    .prepare("SELECT * FROM findings ORDER BY ts DESC, id DESC LIMIT ?")
    .all(limit) as unknown as FindingSql[];
  return rows.map(toFindingRow);
}

export function clearFindings(db: DatabaseSync): void {
  db.prepare("DELETE FROM findings").run();
}

interface ValueExceptionSql {
  id: number;
  value_hash: string;
  preview: string;
  label: string;
  note: string | null;
  created_at: number;
}

function toValueExceptionRow(row: ValueExceptionSql): ValueExceptionRow {
  return {
    id: row.id,
    valueHash: row.value_hash,
    preview: row.preview,
    label: row.label,
    note: row.note ?? null,
    createdAt: row.created_at,
  };
}

export function addValueException(
  db: DatabaseSync,
  input: { valueHash: string; preview: string; label: string; note?: string | null; createdAt?: number },
): ValueExceptionRow {
  const createdAt = input.createdAt ?? Date.now();
  const note = input.note ?? null;
  db.prepare(
    `INSERT INTO value_exceptions (value_hash, preview, label, note, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(value_hash) DO UPDATE SET
       preview = excluded.preview,
       label = excluded.label,
       note = excluded.note`,
  ).run(input.valueHash, input.preview, input.label, note, createdAt);
  const row = db
    .prepare("SELECT id, value_hash, preview, label, note, created_at FROM value_exceptions WHERE value_hash = ?")
    .get(input.valueHash) as unknown as ValueExceptionSql;
  return toValueExceptionRow(row);
}

export function listValueExceptions(db: DatabaseSync): ValueExceptionRow[] {
  const rows = db
    .prepare("SELECT id, value_hash, preview, label, note, created_at FROM value_exceptions ORDER BY created_at DESC, id DESC")
    .all() as unknown as ValueExceptionSql[];
  return rows.map(toValueExceptionRow);
}

export function deleteValueException(db: DatabaseSync, id: number): void {
  db.prepare("DELETE FROM value_exceptions WHERE id = ?").run(id);
}

export function getValueExceptionHashes(db: DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT value_hash FROM value_exceptions").all() as unknown as { value_hash: string }[];
  return new Set(rows.map((row) => row.value_hash));
}

export const DEFAULT_TRUSTED_EGRESS_HOSTS: readonly string[] = [
  "github.com",
  "api.github.com",
  "gist.github.com",
  "raw.githubusercontent.com",
  "gitlab.com",
  "bitbucket.org",
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "proxy.golang.org",
  "localhost",
  "127.0.0.1",
];

function normalizeTrustedHosts(hosts: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of hosts) {
    if (typeof raw !== "string") continue;
    const norm = raw.trim().toLowerCase();
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

export function getTrustedHosts(db: DatabaseSync): string[] {
  const raw = getSetting(db, "trusted_egress_hosts", "");
  if (!raw) return [...DEFAULT_TRUSTED_EGRESS_HOSTS];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_TRUSTED_EGRESS_HOSTS];
    return normalizeTrustedHosts(parsed);
  } catch {
    return [...DEFAULT_TRUSTED_EGRESS_HOSTS];
  }
}

export function setTrustedHosts(db: DatabaseSync, hosts: string[]): string[] {
  const normalized = normalizeTrustedHosts(hosts);
  setSetting(db, "trusted_egress_hosts", JSON.stringify(normalized));
  return normalized;
}

export const DEFAULT_CONTENT_GUARD_SETTINGS: ContentGuardSettings = {
  secrets: "ask",
  pci: "ask",
  pii: "warn",
  phi: "warn",
  pipeToShell: true,
};

const CONTENT_GUARD_LANES = new Set<ContentGuardLane>(["off", "monitor", "warn", "ask", "block"]);

function parseLane(value: unknown, fallback: ContentGuardLane): ContentGuardLane {
  return typeof value === "string" && CONTENT_GUARD_LANES.has(value as ContentGuardLane)
    ? (value as ContentGuardLane)
    : fallback;
}

export function getContentGuardSettings(db: DatabaseSync): ContentGuardSettings {
  const raw = getSetting(db, "content_guard_settings", "");
  if (!raw) return { ...DEFAULT_CONTENT_GUARD_SETTINGS };
  try {
    const parsed = JSON.parse(raw) as Partial<ContentGuardSettings> | null;
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_CONTENT_GUARD_SETTINGS };
    return {
      secrets: parseLane(parsed.secrets, DEFAULT_CONTENT_GUARD_SETTINGS.secrets),
      pci: parseLane(parsed.pci, DEFAULT_CONTENT_GUARD_SETTINGS.pci),
      pii: parseLane(parsed.pii, DEFAULT_CONTENT_GUARD_SETTINGS.pii),
      phi: parseLane(parsed.phi, DEFAULT_CONTENT_GUARD_SETTINGS.phi),
      pipeToShell: typeof parsed.pipeToShell === "boolean" ? parsed.pipeToShell : DEFAULT_CONTENT_GUARD_SETTINGS.pipeToShell,
    };
  } catch {
    return { ...DEFAULT_CONTENT_GUARD_SETTINGS };
  }
}

export function setContentGuardSettings(db: DatabaseSync, patch: Partial<ContentGuardSettings>): ContentGuardSettings {
  const current = getContentGuardSettings(db);
  const next: ContentGuardSettings = {
    secrets: patch.secrets !== undefined ? parseLane(patch.secrets, current.secrets) : current.secrets,
    pci: patch.pci !== undefined ? parseLane(patch.pci, current.pci) : current.pci,
    pii: patch.pii !== undefined ? parseLane(patch.pii, current.pii) : current.pii,
    phi: patch.phi !== undefined ? parseLane(patch.phi, current.phi) : current.phi,
    pipeToShell: typeof patch.pipeToShell === "boolean" ? patch.pipeToShell : current.pipeToShell,
  };
  setSetting(db, "content_guard_settings", JSON.stringify(next));
  return next;
}
