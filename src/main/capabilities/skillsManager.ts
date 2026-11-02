import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homeDir, leashDir } from "../../shared/constants";
import type { AgentId, SkillItem } from "../../shared/types";
import { findManifest, isPluginEnabledForAgent } from "./pluginsManager";
import { getSkillAnalytics } from "./skillsAnalytics";

export const AGENT_SKILL_PATHS: Partial<Record<AgentId, (home: string) => string>> = {
  "claude-code": (home) => join(home, ".claude/skills"),
  "antigravity": (home) => join(home, ".gemini/config/skills"),
  "codex": (home) => join(home, ".codex/skills"),
  "gemini": (home) => join(home, ".agents/skills"),
  "cursor": (home) => join(home, ".cursor/skills"),
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

export interface DiscoveredSkill {
  id: string;
  name: string;
  description: string;
  path: string;
  isPlugin: boolean;
  pluginName?: string;
  pluginFolder?: string;
}

export function scanPluginSkills(home: string): DiscoveredSkill[] {
  const discovered: DiscoveredSkill[] = [];
  const baseDirs = pluginDirs(home);

  for (const base of baseDirs) {
    if (!existsSync(base)) continue;
    let pluginFolders: string[] = [];
    try {
      pluginFolders = readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory() || d.isSymbolicLink())
        .map((d) => d.name);
    } catch {
      continue;
    }

    for (const pluginFolder of pluginFolders) {
      const pluginDir = join(base, pluginFolder);
      const pluginName = findManifest(pluginDir).manifest?.name || pluginFolder;
      const pluginSkillsPath = join(pluginDir, "skills");
      if (!existsSync(pluginSkillsPath)) continue;

      // Scan skills directly under skills/ or nested categories skills/<cat>/<skill>
      const queue = [pluginSkillsPath];
      while (queue.length > 0) {
        const current = queue.shift()!;
        try {
          const entries = readdirSync(current, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
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
                pluginName,
                pluginFolder,
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
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
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

function scanAgentPathSkills(home: string): DiscoveredSkill[] {
  const discovered: DiscoveredSkill[] = [];
  for (const getPath of Object.values(AGENT_SKILL_PATHS)) {
    const dir = getPath(home);
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const subPath = join(dir, entry.name);
        const skillMd = join(subPath, "SKILL.md");
        if (!existsSync(skillMd)) continue;
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
  }
  return discovered;
}

export function listSkills(home = homeDir()): SkillItem[] {
  const analytics = getSkillAnalytics(home);
  const pluginSkills = scanPluginSkills(home);
  const canonicalSkills = scanCanonicalSkills(home);
  const agentPathSkills = scanAgentPathSkills(home);

  const skillsMap = new Map<string, DiscoveredSkill>();

  // Canonical skills take priority if ID collides, but plugin skills are also registered
  for (const skill of pluginSkills) {
    skillsMap.set(skill.id, skill);
  }
  for (const skill of canonicalSkills) {
    skillsMap.set(skill.id, skill);
  }
  for (const skill of agentPathSkills) {
    if (!skillsMap.has(skill.id)) {
      skillsMap.set(skill.id, skill);
    }
  }

  const configPath = join(home, ".gemini/config/config.json");
  let disabledSkills: string[] = [];
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { disabledSkills?: string[] };
      if (Array.isArray(parsed.disabledSkills)) {
        disabledSkills = parsed.disabledSkills;
      }
    } catch {
      /* ignore */
    }
  }

  const items: SkillItem[] = [];

  for (const [id, skill] of skillsMap.entries()) {
    const enabledAgents: AgentId[] = [];
    const isOverriddenFor: AgentId[] = [];

    if (skill.isPlugin && skill.pluginName) {
      const pluginEnabled =
        isPluginEnabledForAgent(skill.pluginName, "antigravity", home) &&
        (!skill.pluginFolder || isPluginEnabledForAgent(skill.pluginFolder, "antigravity", home));
      if (pluginEnabled && !disabledSkills.includes(id)) {
        enabledAgents.push("antigravity");
      }
    }

    // Check each agent's skill dir
    for (const [agent, getPath] of Object.entries(AGENT_SKILL_PATHS) as [AgentId, (h: string) => string][]) {
      const agentDir = getPath(home);
      const linkPath = join(agentDir, id);

      if (existsSync(linkPath)) {
        if (!enabledAgents.includes(agent)) {
          if (!(agent === "antigravity" && skill.isPlugin && disabledSkills.includes(id))) {
            enabledAgents.push(agent);
          }
        }
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

export function isValidSkillId(skillId: string): boolean {
  return typeof skillId === "string" && /^[a-zA-Z0-9_-]+$/.test(skillId);
}

export function getSkillContent(skillId: string, agentId?: AgentId, home = homeDir()): string {
  if (!isValidSkillId(skillId)) return "";

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

  // Check native agent skill paths
  if (agentId && AGENT_SKILL_PATHS[agentId]) {
    const nativeMd = join(AGENT_SKILL_PATHS[agentId]!(home), skillId, "SKILL.md");
    if (existsSync(nativeMd)) return readFileSync(nativeMd, "utf8");
  }

  for (const getPath of Object.values(AGENT_SKILL_PATHS)) {
    const nativeMd = join(getPath(home), skillId, "SKILL.md");
    if (existsSync(nativeMd)) return readFileSync(nativeMd, "utf8");
  }

  return "";
}

export function saveSkillContent(skillId: string, content: string, agentId?: AgentId, home = homeDir()): void {
  if (!isValidSkillId(skillId)) {
    throw new Error(`Invalid skill ID "${skillId}"`);
  }

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

  // When saving global canonical, update non-overridden agent symlinks to point to canonical
  if (!agentId) {
    const canonicalPath = join(canonicalDir(home), skillId);
    for (const [agent, getPath] of Object.entries(AGENT_SKILL_PATHS) as [AgentId, (h: string) => string][]) {
      const agentDir = getPath(home);
      const linkPath = join(agentDir, skillId);
      if (existsSync(linkPath)) {
        try {
          const stat = lstatSync(linkPath);
          const isOverridden =
            stat.isSymbolicLink() && readlinkSync(linkPath).includes(`variants/${agent}/${skillId}`);
          if (!isOverridden) {
            safeRemove(linkPath);
            symlinkSync(canonicalPath, linkPath, "dir");
          }
        } catch {
          /* ignore */
        }
      }
    }
  }
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
  if (!isValidSkillId(skillId)) return;
  const getAgentPath = AGENT_SKILL_PATHS[agentId];
  if (!getAgentPath) return;

  const agentSkillDir = getAgentPath(home);
  const linkPath = join(agentSkillDir, skillId);

  // If disabling a native skill directory (not symlink), preserve it by copying to canonical first
  if (!enabled && existsSync(linkPath)) {
    try {
      const stat = lstatSync(linkPath);
      if (!stat.isSymbolicLink()) {
        const canDir = join(canonicalDir(home), skillId);
        if (!existsSync(canDir)) {
          mkdirSync(canDir, { recursive: true });
          cpSync(linkPath, canDir, { recursive: true });
        }
      }
    } catch {
      /* ignore */
    }
  }

  const pluginSkill = scanPluginSkills(home).find((s) => s.id === skillId);
  if (agentId === "antigravity" && pluginSkill) {
    const configPath = join(home, ".gemini/config/config.json");
    let config: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try {
        config = (JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>) || {};
      } catch {
        config = {};
      }
    }
    const currentDisabled = Array.isArray(config.disabledSkills)
      ? (config.disabledSkills as string[])
      : [];
    if (enabled) {
      config.disabledSkills = currentDisabled.filter((id) => id !== skillId);
    } else {
      if (!currentDisabled.includes(skillId)) {
        config.disabledSkills = [...currentDisabled, skillId];
      }
      safeRemove(linkPath);
    }
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return;
  }

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
  if (!isValidSkillId(skillId)) return;
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
  if (!isValidSkillId(skillId)) return;
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
  if (!isValidSkillId(skillId)) {
    return { ok: false, error: "Invalid skill ID" };
  }

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
