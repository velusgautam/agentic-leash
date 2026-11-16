import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { homeDir } from "../../shared/constants";
import type { AgentId, PluginItem } from "../../shared/types";
import { AGENT_SKILL_PATHS, scanPluginSkills } from "./skillsManager";

const exec = promisify(execFile);

export interface PluginDirSource {
  dir: string;
  agent: AgentId;
}

export interface DiscoveredPluginDir {
  pluginDir: string;
  pluginFolder: string;
  sourceAgent: AgentId;
}

export interface DiscoveredPluginItem extends PluginItem {
  agents?: AgentId[];
  sourceAgent?: AgentId;
}

export function getPluginDirSources(home = homeDir()): PluginDirSource[] {
  return [
    { dir: join(home, ".gemini/config/plugins"), agent: "antigravity" },
    { dir: join(home, ".gemini/plugins"), agent: "gemini" },
    { dir: join(home, ".claude/plugins"), agent: "claude-code" },
    { dir: join(home, ".cursor/plugins"), agent: "cursor" },
    { dir: join(home, ".codex/plugins"), agent: "codex" },
    { dir: join(home, ".hermes/plugins"), agent: "hermes" },
  ];
}

export function getPluginDirs(home = homeDir()): string[] {
  return getPluginDirSources(home).map((s) => s.dir);
}

const CONTAINER_PLUGIN_FOLDERS = new Set(["cache", "marketplaces", "repos"]);

function looksLikePluginRoot(dir: string): boolean {
  return (
    existsSync(join(dir, "plugin.json")) ||
    existsSync(join(dir, ".claude-plugin/plugin.json")) ||
    existsSync(join(dir, "package.json")) ||
    existsSync(join(dir, "skills")) ||
    existsSync(join(dir, "rules")) ||
    existsSync(join(dir, "mcp.json")) ||
    existsSync(join(dir, "hooks.json"))
  );
}

function collectNestedPlugins(dir: string, sourceAgent: AgentId, depth: number, out: DiscoveredPluginDir[]): void {
  if (depth > 4) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue;
    const sub = join(dir, entry.name);
    if (looksLikePluginRoot(sub)) {
      out.push({ pluginDir: sub, pluginFolder: entry.name, sourceAgent });
    } else {
      collectNestedPlugins(sub, sourceAgent, depth + 1, out);
    }
  }
}

export function discoverPluginDirs(home = homeDir()): DiscoveredPluginDir[] {
  const discovered: DiscoveredPluginDir[] = [];

  for (const { dir: base, agent: sourceAgent } of getPluginDirSources(home)) {
    if (!existsSync(base)) continue;
    let entries;
    try {
      entries = readdirSync(base, { withFileTypes: true })
        .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith("."));
    } catch {
      continue;
    }

    for (const entry of entries) {
      const pluginDir = join(base, entry.name);
      if (CONTAINER_PLUGIN_FOLDERS.has(entry.name) && !looksLikePluginRoot(pluginDir)) {
        collectNestedPlugins(pluginDir, sourceAgent, 1, discovered);
      } else {
        discovered.push({
          pluginDir,
          pluginFolder: entry.name,
          sourceAgent,
        });
      }
    }
  }

  return discovered;
}

interface PluginManifest {
  name?: string;
  version?: string;
  description?: string;
  author?: string | { name?: string };
  skills?: string[] | Record<string, unknown>;
  rules?: string[] | Record<string, unknown>;
  mcpServers?: Record<string, unknown>;
  hooks?: unknown[];
}

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function findManifest(pluginDir: string): { manifest: PluginManifest | null; manifestPath: string | null } {
  const candidatePaths = [
    join(pluginDir, "plugin.json"),
    join(pluginDir, ".claude-plugin/plugin.json"),
    join(pluginDir, "package.json"),
  ];

  for (const p of candidatePaths) {
    if (existsSync(p)) {
      const parsed = readJsonFile<PluginManifest>(p);
      if (parsed) return { manifest: parsed, manifestPath: p };
    }
  }

  return { manifest: null, manifestPath: null };
}

function scanPluginFolder(pluginDir: string): {
  skills: string[];
  rulesCount: number;
  mcpServersCount: number;
  hooksCount: number;
} {
  const skills: string[] = [];
  let rulesCount = 0;
  let mcpServersCount = 0;
  let hooksCount = 0;

  // Scan skills
  const skillsPath = join(pluginDir, "skills");
  if (existsSync(skillsPath)) {
    const queue = [skillsPath];
    while (queue.length > 0) {
      const current = queue.shift()!;
      try {
        const entries = readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const sub = join(current, entry.name);
          if (existsSync(join(sub, "SKILL.md"))) {
            skills.push(entry.name);
          } else {
            queue.push(sub);
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  // Scan rules
  const rulesPath = join(pluginDir, "rules");
  if (existsSync(rulesPath)) {
    try {
      const entries = readdirSync(rulesPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".json"))) {
          rulesCount++;
        }
      }
    } catch {
      /* ignore */
    }
  }

  // Scan mcp
  for (const mcpFile of ["mcp.json", "mcp_config.json", ".claude-plugin/mcp.json"]) {
    const p = join(pluginDir, mcpFile);
    if (existsSync(p)) {
      const json = readJsonFile<{ mcpServers?: Record<string, unknown> }>(p);
      if (json?.mcpServers) {
        mcpServersCount = Math.max(mcpServersCount, Object.keys(json.mcpServers).length);
      }
    }
  }

  // Scan hooks
  for (const hookFile of ["hooks.json", ".claude-plugin/hooks.json"]) {
    const p = join(pluginDir, hookFile);
    if (existsSync(p)) {
      const json = readJsonFile<Record<string, unknown> | unknown[]>(p);
      if (Array.isArray(json)) {
        hooksCount = Math.max(hooksCount, json.length);
      } else if (json && typeof json === "object") {
        hooksCount = Math.max(hooksCount, Object.keys(json).length);
      }
    }
  }

  return { skills, rulesCount, mcpServersCount, hooksCount };
}

function getGeminiConfigPath(home: string): string {
  return join(home, ".gemini/config/config.json");
}

function safeRemoveLink(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      unlinkSync(path);
    }
  } catch {
    /* ignore if not exists */
  }
}

interface AgentConfigJson {
  plugins?: Record<string, { enabled?: boolean }>;
  enabledPlugins?: string[];
  disabledPlugins?: string[];
  disabledSkills?: string[];
  agentPlugins?: Partial<Record<AgentId, Record<string, boolean>>>;
  [key: string]: unknown;
}

function pluginMatchesName(d: DiscoveredPluginDir, pluginName: string): boolean {
  if (d.pluginFolder === pluginName) return true;
  const manifestName = findManifest(d.pluginDir).manifest?.name;
  return manifestName === pluginName;
}

export function isPluginEnabledForAgent(pluginName: string, agentId: AgentId, home = homeDir()): boolean {
  const configPath = getGeminiConfigPath(home);
  const json = existsSync(configPath) ? readJsonFile<AgentConfigJson>(configPath) : null;
  const discovered = discoverPluginDirs(home);
  const matchingDirs = discovered.filter((d) => pluginMatchesName(d, pluginName));

  if (agentId === "antigravity") {
    const installedInAntigravity = matchingDirs.some(
      (d) => d.sourceAgent === "antigravity" || d.sourceAgent === "gemini",
    );

    if (json?.disabledPlugins && json.disabledPlugins.includes(pluginName)) {
      return false;
    }

    if (json?.plugins && json.plugins[pluginName]) {
      return json.plugins[pluginName]!.enabled !== false;
    }

    if (json?.enabledPlugins) {
      return json.enabledPlugins.includes(pluginName);
    }

    if (installedInAntigravity || matchingDirs.length === 0) {
      return installedInAntigravity || !json;
    }

    const agySkillDir = AGENT_SKILL_PATHS.antigravity?.(home);
    if (agySkillDir && existsSync(agySkillDir)) {
      const pluginSkills = scanPluginSkills(home).filter(
        (s) => s.pluginName === pluginName || s.pluginFolder === pluginName,
      );
      if (pluginSkills.length > 0 && pluginSkills.some((s) => existsSync(join(agySkillDir, s.id)))) {
        return true;
      }
    }

    return false;
  }

  // Other agents (claude-code, codex, gemini, cursor, hermes)
  const explicit = json?.agentPlugins?.[agentId]?.[pluginName];
  if (typeof explicit === "boolean") {
    return explicit;
  }

  if (matchingDirs.some((d) => d.sourceAgent === agentId)) {
    return true;
  }

  const getAgentPath = AGENT_SKILL_PATHS[agentId];
  if (!getAgentPath) return false;

  const agentSkillDir = getAgentPath(home);
  if (!existsSync(agentSkillDir)) return false;

  const pluginSkills = scanPluginSkills(home).filter(
    (s) => s.pluginName === pluginName || s.pluginFolder === pluginName,
  );
  return pluginSkills.length > 0 && pluginSkills.some((s) => existsSync(join(agentSkillDir, s.id)));
}

const PLUGIN_AGENTS_TO_CHECK: AgentId[] = [
  "antigravity",
  "claude-code",
  "gemini",
  "cursor",
  "codex",
  "hermes",
];

export function listPlugins(home = homeDir()): DiscoveredPluginItem[] {
  const discovered = discoverPluginDirs(home);
  const pluginsMap = new Map<string, DiscoveredPluginItem>();

  for (const { pluginDir, pluginFolder, sourceAgent } of discovered) {
    const { manifest } = findManifest(pluginDir);
    const scanned = scanPluginFolder(pluginDir);

    const name = manifest?.name || pluginFolder;
    const version = manifest?.version;
    const description = manifest?.description;
    const author = typeof manifest?.author === "string" ? manifest.author : manifest?.author?.name;

    const skills = Array.from(new Set([
      ...scanned.skills,
      ...(Array.isArray(manifest?.skills) ? manifest.skills : Object.keys(manifest?.skills || {})),
    ]));

    const rulesCount = Math.max(
      scanned.rulesCount,
      Array.isArray(manifest?.rules) ? manifest.rules.length : Object.keys(manifest?.rules || {}).length,
    );

    const mcpServersCount = Math.max(
      scanned.mcpServersCount,
      manifest?.mcpServers ? Object.keys(manifest.mcpServers).length : 0,
    );

    const hooksCount = Math.max(
      scanned.hooksCount,
      Array.isArray(manifest?.hooks) ? manifest.hooks.length : 0,
    );

    const enabledAgents: AgentId[] = [];
    for (const agent of PLUGIN_AGENTS_TO_CHECK) {
      if (isPluginEnabledForAgent(name, agent, home)) {
        enabledAgents.push(agent);
      }
    }

    const existing = pluginsMap.get(name);
    if (existing) {
      const mergedSkills = Array.from(new Set([...existing.skills, ...skills]));
      const mergedEnabled = Array.from(new Set([...existing.enabledAgents, ...enabledAgents]));
      const mergedAgents = Array.from(new Set([...(existing.agents ?? []), sourceAgent, ...mergedEnabled]));
      pluginsMap.set(name, {
        ...existing,
        version: existing.version ?? version,
        description: existing.description ?? description,
        author: existing.author ?? author,
        skills: mergedSkills,
        skillsCount: mergedSkills.length,
        rulesCount: Math.max(existing.rulesCount, rulesCount),
        mcpServersCount: Math.max(existing.mcpServersCount, mcpServersCount),
        hooksCount: Math.max(existing.hooksCount, hooksCount),
        enabledAgents: mergedEnabled,
        agents: mergedAgents,
      });
    } else {
      const agents = Array.from(new Set([sourceAgent, ...enabledAgents]));
      pluginsMap.set(name, {
        name,
        version,
        description,
        author,
        path: pluginDir,
        skillsCount: skills.length,
        rulesCount,
        mcpServersCount,
        hooksCount,
        skills,
        enabledAgents,
        agents,
        sourceAgent,
      });
    }
  }

  return Array.from(pluginsMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function filterPluginsByAgent<T extends PluginItem & { agents?: AgentId[]; sourceAgent?: AgentId }>(
  plugins: T[],
  agent: AgentId | "all",
): T[] {
  if (agent === "all") return plugins;
  return plugins.filter(
    (p) => p.enabledAgents.includes(agent) || p.agents?.includes(agent) || p.sourceAgent === agent,
  );
}

export function togglePluginForAgent(pluginName: string, agentId: AgentId, enabled: boolean, home = homeDir()): void {
  const configPath = getGeminiConfigPath(home);
  const config = readJsonFile<AgentConfigJson>(configPath) || {};
  const pluginSkills = scanPluginSkills(home).filter(
    (s) => s.pluginName === pluginName || s.pluginFolder === pluginName,
  );

  if (agentId === "antigravity") {
    if (!config.plugins) config.plugins = {};
    config.plugins[pluginName] = { ...config.plugins[pluginName], enabled };

    // Also maintain disabledPlugins list for easy checking
    if (!config.disabledPlugins) config.disabledPlugins = [];
    if (enabled) {
      config.disabledPlugins = config.disabledPlugins.filter((p) => p !== pluginName);
      if (Array.isArray(config.disabledSkills)) {
        const pluginSkillIds = new Set(pluginSkills.map((s) => s.id));
        config.disabledSkills = config.disabledSkills.filter((id) => !pluginSkillIds.has(id));
      }
    } else if (!config.disabledPlugins.includes(pluginName)) {
      config.disabledPlugins.push(pluginName);
    }

    writeJsonFile(configPath, config);
    return;
  }

  // Other agents (claude-code, codex, gemini, cursor)
  if (!config.agentPlugins) config.agentPlugins = {};
  if (!config.agentPlugins[agentId]) config.agentPlugins[agentId] = {};
  config.agentPlugins[agentId]![pluginName] = enabled;
  writeJsonFile(configPath, config);

  const getAgentPath = AGENT_SKILL_PATHS[agentId];
  if (!getAgentPath) return;

  const agentSkillDir = getAgentPath(home);
  for (const skill of pluginSkills) {
    const linkPath = join(agentSkillDir, skill.id);
    if (enabled) {
      mkdirSync(agentSkillDir, { recursive: true });
      if (existsSync(linkPath)) {
        try {
          const stat = lstatSync(linkPath);
          if (!stat.isSymbolicLink()) {
            // Do not clobber a real native directory
            continue;
          }
          unlinkSync(linkPath);
        } catch {
          continue;
        }
      }
      symlinkSync(skill.path, linkPath, "dir");
    } else {
      safeRemoveLink(linkPath);
    }
  }
}

export function extractRepoName(gitUrl: string): string {
  const cleaned = gitUrl.trim().replace(/\/+$/, "");
  const lastPart = cleaned.split("/").pop() || "";
  return lastPart.replace(/\.git$/i, "") || "plugin";
}

export async function installPlugin(gitUrl: string, home = homeDir()): Promise<{ ok: boolean; error?: string; name?: string }> {
  const repoName = extractRepoName(gitUrl);
  const targetDir = join(home, ".gemini/config/plugins", repoName);

  if (existsSync(targetDir)) {
    return { ok: false, error: `Plugin "${repoName}" already exists at ${targetDir}` };
  }

  mkdirSync(dirname(targetDir), { recursive: true });

  try {
    await exec("git", ["clone", gitUrl, targetDir]);
    return { ok: true, name: repoName };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Git clone failed: ${message}` };
  }
}

export async function uninstallPlugin(pluginName: string, home = homeDir()): Promise<{ ok: boolean; error?: string }> {
  const plugins = listPlugins(home);
  const target = plugins.find((p) => p.name === pluginName || basename(p.path) === pluginName);
  if (!target) {
    return { ok: false, error: `Plugin "${pluginName}" not found.` };
  }

  const baseDirs = getPluginDirs(home).map((d) => resolve(d));
  const resolvedTarget = resolve(target.path);

  const isContained = baseDirs.some((base) => {
    const rel = relative(base, resolvedTarget);
    return rel && !rel.startsWith("..") && !isAbsolute(rel);
  });

  if (!isContained) {
    return { ok: false, error: `Refusing to delete plugin outside plugin directories: ${resolvedTarget}` };
  }

  try {
    rmSync(resolvedTarget, { recursive: true, force: true });
    return { ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to remove ${resolvedTarget}: ${message}` };
  }
}
