import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { homeDir, leashDir } from "../../shared/constants";
import type { HookRequest } from "../../shared/types";

export function analyticsDbPath(home = homeDir()): string {
  return join(leashDir(home), "analytics", "skill-usage.sqlite");
}

const dbCache = new Map<string, DatabaseSync>();

export function openAnalyticsDb(home = homeDir()): DatabaseSync {
  const path = analyticsDbPath(home);
  let db = dbCache.get(path);
  if (!db) {
    mkdirSync(dirname(path), { recursive: true });
    db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE IF NOT EXISTS skill_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_skill_usage ON skill_usage (skill_id, agent_id);
    `);
    dbCache.set(path, db);
  }
  return db;
}

export function closeAnalyticsDb(home = homeDir()): void {
  const path = analyticsDbPath(home);
  const db = dbCache.get(path);
  if (db) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    dbCache.delete(path);
  }
}

export function recordSkillUsage(skillId: string, agentId: string, home = homeDir(), timestamp = Date.now()): void {
  if (!skillId || !agentId) return;
  try {
    const db = openAnalyticsDb(home);
    const stmt = db.prepare("INSERT INTO skill_usage (skill_id, agent_id, timestamp) VALUES (?, ?, ?)");
    stmt.run(skillId, agentId, timestamp);
  } catch {
    /* ignore db errors in analytics */
  }
}

export interface SkillAnalyticsData {
  total: number;
  byAgent: Record<string, number>;
}

export function getSkillAnalytics(home = homeDir()): Record<string, SkillAnalyticsData> {
  const path = analyticsDbPath(home);
  if (!existsSync(path)) return {};

  try {
    const db = openAnalyticsDb(home);
    const stmt = db.prepare(`
      SELECT skill_id, agent_id, COUNT(*) as cnt
      FROM skill_usage
      GROUP BY skill_id, agent_id
    `);
    const rows = stmt.all() as { skill_id: string; agent_id: string; cnt: number | bigint }[];

    const result: Record<string, SkillAnalyticsData> = {};

    for (const row of rows) {
      const count = Number(row.cnt);
      if (!result[row.skill_id]) {
        result[row.skill_id] = { total: 0, byAgent: {} };
      }
      result[row.skill_id]!.total += count;
      result[row.skill_id]!.byAgent[row.agent_id] = (result[row.skill_id]!.byAgent[row.agent_id] ?? 0) + count;
    }

    return result;
  } catch {
    return {};
  }
}

/**
 * Extracts a skill identifier from a hook request if it targets a skill file or skill tool.
 */
export function extractSkillFromRequest(request: HookRequest): string | null {
  const toolLower = (request.tool || "").toLowerCase();

  // If tool itself is a skill execution tool (e.g., "Skill", "use_skill", "activate_skill")
  if (toolLower === "skill" || toolLower === "use_skill" || toolLower === "activate_skill") {
    if (request.command) {
      const clean = request.command.trim().replace(/^["']|["']$/g, "");
      if (clean) return clean;
    }
    if (request.paths && request.paths.length > 0) {
      const p = request.paths[0]!;
      const match = p.match(/(?:^|[/\\])skills[/\\](?:[^/\\]+[/\\])?([^/\\]+?)(?:[/\\]SKILL\.md)?$/i);
      if (match) return match[1]!;
      const base = p.split(/[/\\]/).pop();
      if (base && !base.endsWith(".md")) return base;
    }
  }

  // If request reads a skill file (e.g. read_file on .../skills/.../SKILL.md)
  for (const p of request.paths || []) {
    // Matches .../skills/<category>/<skill-name> or .../skills/<skill-name>
    const skillMdMatch = p.match(/(?:^|[/\\])skills[/\\](?:[^/\\]+[/\\])?([^/\\]+?)[/\\]SKILL\.md$/i);
    if (skillMdMatch) return skillMdMatch[1]!;

    const skillsDirMatch = p.match(/(?:^|[/\\])skills[/\\](?:[^/\\]+[/\\])?([^/\\]+?)(?:[/\\]|$)/i);
    if (skillsDirMatch && skillsDirMatch[1] && skillsDirMatch[1] !== "skills") {
      return skillsDirMatch[1]!;
    }
  }

  return null;
}

export function detectAndRecordSkillUsage(request: HookRequest, home = homeDir()): void {
  const skillId = extractSkillFromRequest(request);
  if (skillId) {
    recordSkillUsage(skillId, request.agent, home);
  }
}
