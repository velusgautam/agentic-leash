import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homeDir, leashDir } from "../../shared/constants";
import type { AgentId, SkillItem } from "../../shared/types";
import { getSkillAnalytics } from "./skillsAnalytics";

export const AGENT_SKILL_PATHS: Partial<Record<AgentId, (home: string) => string>> = {
  "claude-code": (home) => join(home, ".claude/skills"),
  "antigravity": (home) => join(home, ".gemini/config/skills"),
  "codex": (home) => join(home, ".codex/skills"),
  "gemini": (home) => join(home, ".agents/skills"),
};

function canonicalDir(home: string): string {
  return join(leashDir(home), "skills", "canonical");
}

function variantsDir(home: string): string {
  return join(leashDir(home), "skills", "variants");
}

function pluginDirs(home: string): string[] {
  return [
    join(home, ".gemini/config/plugins"),
    join(home, ".gemini/plugins"),
  ];
}

function parseSkillMetadata(skillMdPath: string): { name: string; description: string } {
  if (!existsSync(skillMdPath)) return { name: "", description: "" };
  try {
    const content = readFileSync(skillMdPath, "utf8");
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fmMatch) return { name: "", description: "" };
    const fm = fmMatch[1]!;
    const nameMatch = fm.match(/^name:\s*(.+)$/m);
    const descMatch = fm.match(/^description:\s*(.+)$/m);
    return {
      name: nameMatch ? nameMatch[1]!.trim().replace(/^["']|["']$/g, "") : "",
      description: descMatch ? descMatch[1]!.trim().replace(/^["']|["']$/g, "") : "",
    };
  } catch {
    return { name: "", description: "" };
  }
}

interface DiscoveredSkill {
  id: string;
  name: string;
  description: string;
  path: string;
  isPlugin: boolean;
  pluginName?: string;
}

function scanPluginSkills(home: string): DiscoveredSkill[] {
  const discovered: DiscoveredSkill[] = [];
  const baseDirs = pluginDirs(home);

  for (const base of baseDirs) {
    if (!existsSync(base)) continue;
    let pluginFolders: string[] = [];
    try {
      pluginFolders = readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }

    for (const pluginFolder of pluginFolders) {
      const pluginSkillsPath = join(base, pluginFolder, "skills");
      if (!existsSync(pluginSkillsPath)) continue;

      // Scan skills directly under skills/ or nested categories skills/<cat>/<skill>
      const queue = [pluginSkillsPath];
      while (queue.length > 0) {
        const current = queue.shift()!;
        try {
          const entries = readdirSync(current, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const subPath = join(current, entry.name);
            const skillMd = join(subPath, "SKILL.md");
            if (existsSync(skillMd)) {
              const meta = parseSkillMetadata(skillMd);
              discovered.push({
                id: entry.name,
                name: meta.name || entry.name,
                description: meta.description,
                path: subPath,
                isPlugin: true,
                pluginName: pluginFolder,
              });
            } else {
              // Could be a category directory (like engineering/ or productivity/)
              queue.push(subPath);
            }
          }
        } catch {
          /* ignore unreadable dirs */
        }
      }
    }
  }

  return discovered;
}

function scanCanonicalSkills(home: string): DiscoveredSkill[] {
  const discovered: DiscoveredSkill[] = [];
  const dir = canonicalDir(home);
  if (!existsSync(dir)) return discovered;

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subPath = join(dir, entry.name);
      const skillMd = join(subPath, "SKILL.md");
      const meta = parseSkillMetadata(skillMd);
      discovered.push({
        id: entry.name,
        name: meta.name || entry.name,
        description: meta.description,
        path: subPath,
        isPlugin: false,
      });
    }
  } catch {
    /* ignore */
  }

  return discovered;
}

export function listSkills(home = homeDir()): SkillItem[] {
  const analytics = getSkillAnalytics(home);
  const pluginSkills = scanPluginSkills(home);
  const canonicalSkills = scanCanonicalSkills(home);

  const skillsMap = new Map<string, DiscoveredSkill>();

  // Canonical skills take priority if ID collides, but plugin skills are also registered
  for (const skill of pluginSkills) {
    skillsMap.set(skill.id, skill);
  }
  for (const skill of canonicalSkills) {
    skillsMap.set(skill.id, skill);
  }

  const items: SkillItem[] = [];

  for (const [id, skill] of skillsMap.entries()) {
    const enabledAgents: AgentId[] = [];
    const isOverriddenFor: AgentId[] = [];

    // Check each agent's skill dir
    for (const [agent, getPath] of Object.entries(AGENT_SKILL_PATHS) as [AgentId, (h: string) => string][]) {
      const agentDir = getPath(home);
      const linkPath = join(agentDir, id);

      if (existsSync(linkPath)) {
        enabledAgents.push(agent);
        try {
          const stat = lstatSync(linkPath);
          if (stat.isSymbolicLink()) {
            const rawTarget = readlinkSync(linkPath);
            const resolvedTarget = resolve(agentDir, rawTarget);
            const variantPath = join(variantsDir(home), agent, id);
            if (resolvedTarget === variantPath || resolvedTarget.includes(`variants/${agent}/${id}`)) {
              isOverriddenFor.push(agent);
            }
          }
        } catch {
          /* ignore */
        }
      }
    }

    const usage = analytics[id] ?? { total: 0, byAgent: {} };

    items.push({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      path: skill.path,
      isPlugin: skill.isPlugin,
      pluginName: skill.pluginName,
      enabledAgents,
      isOverriddenFor,
      usageCount: usage.total,
      usageByAgent: usage.byAgent,
    });
  }

  return items.sort((a, b) => a.name.localeCompare(b.name));
}

export function getSkillContent(skillId: string, agentId?: AgentId, home = homeDir()): string {
  if (agentId) {
    const variantMd = join(variantsDir(home), agentId, skillId, "SKILL.md");
    if (existsSync(variantMd)) {
      return readFileSync(variantMd, "utf8");
    }
  }

  const canonicalMd = join(canonicalDir(home), skillId, "SKILL.md");
  if (existsSync(canonicalMd)) {
    return readFileSync(canonicalMd, "utf8");
  }

  // Check plugin skills
  const pluginSkills = scanPluginSkills(home);
  const found = pluginSkills.find((s) => s.id === skillId);
  if (found) {
    const pMd = join(found.path, "SKILL.md");
    if (existsSync(pMd)) return readFileSync(pMd, "utf8");
  }

  return "";
}

export function saveSkillContent(skillId: string, content: string, agentId?: AgentId, home = homeDir()): void {
  let targetMd: string;

  if (agentId) {
    const variantPath = join(variantsDir(home), agentId, skillId);
    if (existsSync(variantPath)) {
      targetMd = join(variantPath, "SKILL.md");
    } else {
      targetMd = join(canonicalDir(home), skillId, "SKILL.md");
    }
  } else {
    targetMd = join(canonicalDir(home), skillId, "SKILL.md");
  }

  mkdirSync(dirname(targetMd), { recursive: true });
  writeFileSync(targetMd, content, "utf8");
}

function resolveSkillSourcePath(skillId: string, agentId: AgentId, home: string): string | null {
  const variantPath = join(variantsDir(home), agentId, skillId);
  if (existsSync(variantPath)) return variantPath;

  const canonicalPath = join(canonicalDir(home), skillId);
  if (existsSync(canonicalPath)) return canonicalPath;

  const pluginSkills = scanPluginSkills(home);
  const found = pluginSkills.find((s) => s.id === skillId);
  if (found && existsSync(found.path)) return found.path;

  return null;
}

function safeRemove(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      unlinkSync(path);
      return;
    }
    rmSync(path, { recursive: true, force: true });
  } catch {
    /* ignore if not exists */
  }
}

export function toggleSkillForAgent(skillId: string, agentId: AgentId, enabled: boolean, home = homeDir()): void {
  const getAgentPath = AGENT_SKILL_PATHS[agentId];
  if (!getAgentPath) return;

  const agentSkillDir = getAgentPath(home);
  const linkPath = join(agentSkillDir, skillId);

  if (enabled) {
    const sourcePath = resolveSkillSourcePath(skillId, agentId, home);
    if (!sourcePath) return;

    mkdirSync(agentSkillDir, { recursive: true });
    safeRemove(linkPath);
    symlinkSync(sourcePath, linkPath, "dir");
  } else {
    safeRemove(linkPath);
  }
}

export function overrideSkillForAgent(skillId: string, agentId: AgentId, home = homeDir()): void {
  const sourcePath = resolveSkillSourcePath(skillId, agentId, home);
  if (!sourcePath) return;

  const variantPath = join(variantsDir(home), agentId, skillId);
  mkdirSync(dirname(variantPath), { recursive: true });
  safeRemove(variantPath);

  cpSync(sourcePath, variantPath, { recursive: true });

  // Update symlink
  const getAgentPath = AGENT_SKILL_PATHS[agentId];
  if (getAgentPath) {
    const linkPath = join(getAgentPath(home), skillId);
    mkdirSync(getAgentPath(home), { recursive: true });
    safeRemove(linkPath);
    symlinkSync(variantPath, linkPath, "dir");
  }
}

export function resetSkillOverride(skillId: string, agentId: AgentId, home = homeDir()): void {
  const variantPath = join(variantsDir(home), agentId, skillId);
  safeRemove(variantPath);

  // Restore symlink to canonical or plugin
  const canonicalPath = join(canonicalDir(home), skillId);
  let targetPath = existsSync(canonicalPath) ? canonicalPath : null;

  if (!targetPath) {
    const pluginSkills = scanPluginSkills(home);
    const found = pluginSkills.find((s) => s.id === skillId);
    if (found) targetPath = found.path;
  }

  const getAgentPath = AGENT_SKILL_PATHS[agentId];
  if (getAgentPath && targetPath) {
    const linkPath = join(getAgentPath(home), skillId);
    safeRemove(linkPath);
    symlinkSync(targetPath, linkPath, "dir");
  }
}

export function deleteSkill(skillId: string, home = homeDir()): { ok: boolean; error?: string } {
  // Check if it's a plugin skill
  const pluginSkills = scanPluginSkills(home);
  if (pluginSkills.some((s) => s.id === skillId)) {
    return { ok: false, error: "Plugin-bundled skills cannot be deleted; disable them instead" };
  }

  // Standalone: remove symlinks across all agents
  for (const getPath of Object.values(AGENT_SKILL_PATHS)) {
    const linkPath = join(getPath(home), skillId);
    safeRemove(linkPath);
  }

  // Remove variants
  for (const agent of Object.keys(AGENT_SKILL_PATHS)) {
    const variantPath = join(variantsDir(home), agent, skillId);
    safeRemove(variantPath);
  }

  // Remove canonical
  const canPath = join(canonicalDir(home), skillId);
  safeRemove(canPath);

  return { ok: true };
}
