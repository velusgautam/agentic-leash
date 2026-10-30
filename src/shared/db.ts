import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureIgnored } from "./ignored";
import { validateRule } from "./rules";
import type { Access, AgentId, AllowRule, BlockRule, DecisionRow, Grant, ScheduledRevoke } from "./types";

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

export function openGrantsDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
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
  return db;
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
}

/** True when this agent session was let through to a secret since `since`. Without a session id, any session of the agent counts. */
export function readSecretSince(db: DatabaseSync, agent: string, sessionId: string | undefined, since: number): boolean {
  const row = db
    .prepare("SELECT 1 AS n FROM decisions WHERE agent = ? AND secret = 1 AND verdict = 'pass' AND ts >= ? AND (? IS NULL OR session_id = ?) LIMIT 1")
    .get(agent, since, sessionId ?? null, sessionId ?? null);
  return row !== undefined;
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

export function listDecisions(db: DatabaseSync, limit = 200): DecisionRow[] {
  const rows = db.prepare("SELECT * FROM decisions ORDER BY id DESC LIMIT ?").all(limit) as unknown as {
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
  }[];
  return rows.map((row) => ({
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
  }));
}

export function decisionDurations(db: DatabaseSync): number[] {
  return (db.prepare("SELECT duration_ms FROM decisions WHERE duration_ms IS NOT NULL AND (prompted IS NULL OR prompted = 0)").all() as unknown as { duration_ms: number }[]).map(
    (row) => row.duration_ms,
  );
}

export function pruneDecisions(db: DatabaseSync, olderThan: number): number {
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
  return Number(db.prepare("DELETE FROM approvals WHERE ts < ?").run(olderThan).changes);
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
