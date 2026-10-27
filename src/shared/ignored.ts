import type { DatabaseSync } from "node:sqlite";

// DMG volumes are named "Agentic Leash 1" and "Agentic Leash 3".
const CLAUDE_CACHE = [
  "Partitions",
  "Local Storage",
  "GraphiteDawnCache",
  "IndexedDB",
  "Session Storage",
  "GPUCache",
  "WebStorage",
  "Cache",
  "Code Cache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GPUPersistentCache",
  "Shared Dictionary",
  "sentry",
  "Crashpad",
  "fcache",
  "Service Worker",
  "blob_storage",
  "DIPS",
  "DIPS-wal",
  "DIPS-shm",
  "Cookies",
  "Cookies-journal",
].map((name) => `/Library/Application Support/Claude/${name}`);

const ANTIGRAVITY_CACHE = [
  "/.gemini/antigravity-cli/cache",
  "/.gemini/antigravity-cli/log",
  "/.gemini/antigravity-cli/crashes",
  "/.gemini/antigravity-cli/brain",
  "/.gemini/antigravity/brain",
  "/.gemini/antigravity-ide/brain",
  "/Applications/Antigravity.app",
];

export const BUILTIN_IGNORED = [
  "/.cursor/acp-sessions",
  "/.cursor/chats",
  "/.cursor/plugins/cache",
  "/.cursor/skills-cursor",
  "/.cursor/extensions",
  "/.agentic-leash",
  "/Applications/Agentic Leash.app",
  "/Volumes/Agentic Leash ",
  "/usr/bin",
  "/bin",
  ...CLAUDE_CACHE,
  ...ANTIGRAVITY_CACHE,
  "/Library/Application Scripts",
  "/Library/Containers",
  "/Applications/Claude.app",
  "/opt/homebrew/var",
  "/opt/homebrew/share",
];

export interface IgnoredRow {
  id: number;
  prefix: string;
  enabled: boolean;
  builtin: boolean;
  category: IgnoredCategory;
  createdAt: number | null;
}

export type IgnoredCategory = "Cursor" | "Claude" | "Antigravity" | "Agentic Leash" | "System" | "Homebrew" | "User added";

interface IgnoredSql {
  id: number;
  prefix: string;
  enabled: number;
  builtin: number;
  created_at?: number | null;
}

function isRootOnly(prefix: string): boolean {
  if (prefix.endsWith(" ")) return false;
  const parts = prefix.split("/").filter(Boolean);
  if (parts.length === 1) return !parts[0]!.startsWith(".");
  return parts[0] === "usr" && parts.length === 2 && parts[1] === "bin";
}

export function normalizePrefix(prefix: string): string {
  if (prefix.endsWith(" ")) return prefix;
  const stripped = prefix.trim().replace(/\/+$/, "");
  return stripped === "" ? "/" : stripped;
}

export function matchesIgnored(path: string, prefix: string): boolean {
  if (!prefix || prefix === "/") return false;
  if (prefix.endsWith(" ")) return path.startsWith(prefix);
  const norm = normalizePrefix(prefix);
  if (norm === "/") return false;
  if (path === norm || path.startsWith(`${norm}/`)) return true;
  if (isRootOnly(norm)) return false;
  return path.endsWith(norm) || path.includes(`${norm}/`);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function ignoredMatchSql(prefix: string): { sql: string; args: string[] } {
  if (prefix.endsWith(" ")) {
    const like = escapeLike(prefix);
    const cols = ["path", "dest_path"];
    return { sql: `(${cols.map((col) => `${col} LIKE ? ESCAPE '\\'`).join(" OR ")})`, args: cols.map(() => `${like}%`) };
  }
  const norm = normalizePrefix(prefix);
  const like = escapeLike(norm);
  const cols = ["path", "dest_path"];
  if (isRootOnly(norm)) {
    return {
      sql: `(${cols.flatMap((col) => [`${col} = ?`, `${col} LIKE ? ESCAPE '\\'`]).join(" OR ")})`,
      args: cols.flatMap(() => [norm, `${like}/%`]),
    };
  }
  return {
    sql: `(${cols.flatMap((col) => [`${col} = ?`, `${col} LIKE ? ESCAPE '\\'`, `${col} LIKE ? ESCAPE '\\'`, `${col} LIKE ? ESCAPE '\\'`]).join(" OR ")})`,
    args: cols.flatMap(() => [norm, `${like}/%`, `%${like}`, `%${like}/%`]),
  };
}

export function ignoredCategory(prefix: string, builtin: boolean): IgnoredCategory {
  if (!builtin) return "User added";
  if (prefix.includes("/.cursor/")) return "Cursor";
  if (prefix.includes("Agentic Leash") || prefix.includes("/.agentic-leash")) return "Agentic Leash";
  if (prefix.includes("Claude")) return "Claude";
  if (prefix.includes("/.gemini/") || prefix.includes("antigravity") || prefix.includes("Antigravity")) return "Antigravity";
  if (prefix.startsWith("/opt/homebrew/")) return "Homebrew";
  return "System";
}

function toRow(row: IgnoredSql): IgnoredRow {
  const builtin = row.builtin === 1;
  return { id: row.id, prefix: row.prefix, enabled: row.enabled === 1, builtin, category: ignoredCategory(row.prefix, builtin), createdAt: row.created_at ?? null };
}

export function ensureIgnored(db: DatabaseSync): void {
  const insert = db.prepare("INSERT OR IGNORE INTO ignored_noise (prefix, enabled, builtin, created_at) VALUES (?, 1, 1, NULL)");
  for (const prefix of BUILTIN_IGNORED) insert.run(prefix);
  db.exec("UPDATE ignored_noise SET prefix = rtrim(prefix, '/') WHERE prefix != '/' AND prefix LIKE '%/'");
}

export function listIgnored(db: DatabaseSync): IgnoredRow[] {
  ensureIgnored(db);
  const rows = db.prepare("SELECT id, prefix, enabled, builtin, created_at FROM ignored_noise").all() as unknown as IgnoredSql[];
  const order = new Map(BUILTIN_IGNORED.map((prefix, index) => [prefix, index]));
  return rows.map(toRow).sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? 1 : -1;
    if (a.builtin) {
      return (order.get(a.prefix) ?? 1000) - (order.get(b.prefix) ?? 1000) || (a.prefix < b.prefix ? -1 : 1);
    }
    const timeA = a.createdAt ?? a.id;
    const timeB = b.createdAt ?? b.id;
    if (timeA !== timeB) return timeB - timeA;
    return a.prefix < b.prefix ? -1 : 1;
  });
}

export function enabledIgnoredPrefixes(db: DatabaseSync): string[] {
  const table = db.prepare("SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = 'ignored_noise'").get();
  if (!table) return [...BUILTIN_IGNORED];
  const rows = db.prepare("SELECT prefix, enabled, builtin FROM ignored_noise").all() as unknown as { prefix: string; enabled: number; builtin: number }[];
  const state = new Map(rows.map((row) => [row.prefix, row.enabled === 1]));
  const builtins = BUILTIN_IGNORED.filter((prefix) => state.get(prefix) !== false);
  const custom = rows.filter((row) => row.builtin === 0 && row.enabled === 1).map((row) => row.prefix);
  return [...builtins, ...custom];
}

export function setIgnoredEnabled(db: DatabaseSync, id: number, enabled: boolean): void {
  db.prepare("UPDATE ignored_noise SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
}

export function addIgnored(db: DatabaseSync, prefix: string): IgnoredRow | null {
  const cleaned = normalizePrefix(prefix);
  if (!cleaned.startsWith("/") || cleaned === "/" || /[\0\n\r]/.test(cleaned)) return null;
  ensureIgnored(db);
  const builtin = BUILTIN_IGNORED.includes(cleaned) ? 1 : 0;
  const now = Date.now();
  db.prepare("INSERT OR IGNORE INTO ignored_noise (prefix, enabled, builtin, created_at) VALUES (?, 1, ?, ?)").run(cleaned, builtin, now);
  db.prepare("UPDATE ignored_noise SET enabled = 1, created_at = COALESCE(created_at, ?) WHERE prefix = ?").run(now, cleaned);
  const row = db.prepare("SELECT id, prefix, enabled, builtin, created_at FROM ignored_noise WHERE prefix = ?").get(cleaned) as IgnoredSql | undefined;
  return row ? toRow(row) : null;
}

export function updateIgnored(db: DatabaseSync, id: number, prefix: string): IgnoredRow | null {
  const row = db.prepare("SELECT builtin FROM ignored_noise WHERE id = ?").get(id) as { builtin: number } | undefined;
  if (!row || row.builtin === 1) return null;
  const cleaned = normalizePrefix(prefix);
  if (!cleaned.startsWith("/") || cleaned === "/" || /[\0\n\r]/.test(cleaned)) return null;
  const existing = db.prepare("SELECT id FROM ignored_noise WHERE prefix = ? AND id != ?").get(cleaned, id);
  if (existing) return null;
  db.prepare("UPDATE ignored_noise SET prefix = ? WHERE id = ?").run(cleaned, id);
  const updated = db.prepare("SELECT id, prefix, enabled, builtin, created_at FROM ignored_noise WHERE id = ?").get(id) as IgnoredSql | undefined;
  return updated ? toRow(updated) : null;
}

export function deleteIgnored(db: DatabaseSync, id: number): boolean {
  const row = db.prepare("SELECT builtin FROM ignored_noise WHERE id = ?").get(id) as { builtin: number } | undefined;
  if (!row || row.builtin === 1) return false;
  db.prepare("DELETE FROM ignored_noise WHERE id = ?").run(id);
  return true;
}
