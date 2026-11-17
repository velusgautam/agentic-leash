import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { homeDir } from "../../shared/constants";
import type { AgentId, PluginItem } from "../../shared/types";
import { AGENT_SKILL_PATHS, invalidateSkillsCache, scanPluginSkills } from "./skillsManager";

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

export const SKIP_SCAN_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".venv",
  "__pycache__",
  "vendor",
  "target",
]);

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
    if (entry.name.startsWith(".") || SKIP_SCAN_DIRS.has(entry.name)) continue;
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

export interface PluginManifest {
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

  // Scan skills (max depth 3, skipping heavy non-plugin directories)
  const skillsPath = join(pluginDir, "skills");
  if (existsSync(skillsPath)) {
    const queue: Array<{ dir: string; depth: number }> = [{ dir: skillsPath, depth: 0 }];
    while (queue.length > 0) {
      const { dir: current, depth } = queue.shift()!;
      try {
        const entries = readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
          if (entry.name.startsWith(".") || SKIP_SCAN_DIRS.has(entry.name)) continue;
          const sub = join(current, entry.name);
          if (existsSync(join(sub, "SKILL.md"))) {
            skills.push(entry.name);
          } else if (depth < 3) {
            queue.push({ dir: sub, depth: depth + 1 });
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

export interface AgentConfigJson {
  plugins?: Record<string, { enabled?: boolean }>;
  enabledPlugins?: string[];
  disabledPlugins?: string[];
  disabledSkills?: string[];
  agentDisabledSkills?: Partial<Record<AgentId, string[]>>;
  agentPlugins?: Partial<Record<AgentId, Record<string, boolean>>>;
  [key: string]: unknown;
}

export function readGeminiConfig(home = homeDir()): AgentConfigJson | null {
  return readJsonFile<AgentConfigJson>(getGeminiConfigPath(home));
}

export interface PluginDiscoveryContext {
  home: string;
  configJson: AgentConfigJson | null;
  discovered: DiscoveredPluginDir[];
  manifests: Map<string, PluginManifest | null>;
  skillsByPluginKey?: Map<string, string[]>;
  agentSkillEntries?: Map<AgentId, Set<string> | null>;
}

function getAgentSkillEntries(ctx: PluginDiscoveryContext, agentId: AgentId): Set<string> | null {
  if (!ctx.agentSkillEntries) ctx.agentSkillEntries = new Map();
  if (ctx.agentSkillEntries.has(agentId)) {
    return ctx.agentSkillEntries.get(agentId) ?? null;
  }
  const getAgentPath = AGENT_SKILL_PATHS[agentId];
  if (!getAgentPath) {
    ctx.agentSkillEntries.set(agentId, null);
    return null;
  }
  const dir = getAgentPath(ctx.home);
  if (!existsSync(dir)) {
    ctx.agentSkillEntries.set(agentId, null);
    return null;
  }
  try {
    const entries = new Set(readdirSync(dir));
    ctx.agentSkillEntries.set(agentId, entries);
    return entries;
  } catch {
    ctx.agentSkillEntries.set(agentId, null);
    return null;
  }
}

function getManifestCached(
  pluginDir: string,
  manifests: Map<string, PluginManifest | null>,
): PluginManifest | null {
  if (manifests.has(pluginDir)) {
    return manifests.get(pluginDir) ?? null;
  }
  const { manifest } = findManifest(pluginDir);
  manifests.set(pluginDir, manifest);
  return manifest;
}

export function isPluginEnabledWithContext(
  pluginName: string,
  agentId: AgentId,
  ctx: PluginDiscoveryContext,
): boolean {
  const { home, configJson: json, discovered, manifests } = ctx;
  const matchingDirs = discovered.filter((d) => {
    if (d.pluginFolder === pluginName) return true;
    return getManifestCached(d.pluginDir, manifests)?.name === pluginName;
  });

  const getSkillIdsForPlugin = (): string[] => {
    if (ctx.skillsByPluginKey) {
      return ctx.skillsByPluginKey.get(pluginName) ?? [];
    }
    const pluginSkills = scanPluginSkills(home, discovered, manifests);
    const map = new Map<string, string[]>();
    for (const s of pluginSkills) {
      for (const key of [s.pluginName, s.pluginFolder]) {
        if (!key) continue;
        const arr = map.get(key) ?? [];
        if (!arr.includes(s.id)) arr.push(s.id);
        map.set(key, arr);
      }
    }
    ctx.skillsByPluginKey = map;
    return map.get(pluginName) ?? [];
  };

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

    const agyEntries = getAgentSkillEntries(ctx, "antigravity");
    const agySkillDir = AGENT_SKILL_PATHS.antigravity?.(home);
    if (agyEntries && agySkillDir) {
      const skillIds = getSkillIdsForPlugin();
      if (skillIds.some((id) => agyEntries.has(id) && existsSync(join(agySkillDir, id)))) {
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

  const agentEntries = getAgentSkillEntries(ctx, agentId);
  const agentSkillDir = AGENT_SKILL_PATHS[agentId]?.(home);
  if (!agentEntries || !agentSkillDir) return false;

  const skillIds = getSkillIdsForPlugin();
  return skillIds.some((id) => agentEntries.has(id) && existsSync(join(agentSkillDir, id)));
}

export function isPluginEnabledForAgent(pluginName: string, agentId: AgentId, home = homeDir()): boolean {
  const ctx: PluginDiscoveryContext = {
    home,
    configJson: readGeminiConfig(home),
    discovered: discoverPluginDirs(home),
    manifests: new Map(),
  };
  return isPluginEnabledWithContext(pluginName, agentId, ctx);
}

const PLUGIN_AGENTS_TO_CHECK: AgentId[] = [
  "antigravity",
  "claude-code",
  "gemini",
  "cursor",
  "codex",
  "hermes",
];

const PLUGINS_CACHE_TTL_MS = 3000;

interface PluginsCacheEntry {
  items: DiscoveredPluginItem[];
  fetchedAt: number;
  refreshing: boolean;
}

const pluginsCache = new Map<string, PluginsCacheEntry>();

export function invalidatePluginsCache(home?: string): void {
  if (home !== undefined) {
    pluginsCache.delete(home);
  } else {
    pluginsCache.clear();
  }
}

function computePlugins(home: string): DiscoveredPluginItem[] {
  const discovered = discoverPluginDirs(home);
  const configJson = readGeminiConfig(home);
  const manifests = new Map<string, PluginManifest | null>();
  const skillsByPluginKey = new Map<string, string[]>();

  const preScanned = discovered.map(({ pluginDir, pluginFolder, sourceAgent }) => {
    const manifest = getManifestCached(pluginDir, manifests);
    const scanned = scanPluginFolder(pluginDir);
    const name = manifest?.name || pluginFolder;

    for (const key of [name, pluginFolder]) {
      if (!key) continue;
      const existingIds = skillsByPluginKey.get(key) ?? [];
      for (const skillId of scanned.skills) {
        if (!existingIds.includes(skillId)) existingIds.push(skillId);
      }
      skillsByPluginKey.set(key, existingIds);
    }

    return { pluginDir, pluginFolder, sourceAgent, manifest, scanned, name };
  });

  const ctx: PluginDiscoveryContext = {
    home,
    configJson,
    discovered,
    manifests,
    skillsByPluginKey,
  };

  const pluginsMap = new Map<string, DiscoveredPluginItem>();
  const enabledMemo = new Map<string, AgentId[]>();

  for (const { pluginDir, sourceAgent, manifest, scanned, name } of preScanned) {
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

    let enabledAgents = enabledMemo.get(name);
    if (!enabledAgents) {
      enabledAgents = [];
      for (const agent of PLUGIN_AGENTS_TO_CHECK) {
        if (isPluginEnabledWithContext(name, agent, ctx)) {
          enabledAgents.push(agent);
        }
      }
      enabledMemo.set(name, enabledAgents);
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

export function listPluginsCached(home = homeDir()): DiscoveredPluginItem[] {
  const now = Date.now();
  const cached = pluginsCache.get(home);
  if (cached) {
    if (now - cached.fetchedAt < PLUGINS_CACHE_TTL_MS) {
      return cached.items;
    }
    if (!cached.refreshing) {
      cached.refreshing = true;
      setImmediate(() => {
        try {
          const fresh = computePlugins(home);
          pluginsCache.set(home, { items: fresh, fetchedAt: Date.now(), refreshing: false });
        } catch {
          cached.refreshing = false;
        }
      });
    }
    return cached.items;
  }
  const items = computePlugins(home);
  pluginsCache.set(home, { items, fetchedAt: Date.now(), refreshing: false });
  return items;
}

export function listPlugins(home = homeDir()): DiscoveredPluginItem[] {
  if (home === homeDir()) {
    return listPluginsCached(home);
  }
  const items = computePlugins(home);
  pluginsCache.set(home, { items, fetchedAt: Date.now(), refreshing: false });
  return items;
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
    invalidatePluginsCache(home);
    invalidateSkillsCache(home);
    return;
  }

  // Other agents (claude-code, codex, gemini, cursor)
  if (!config.agentPlugins) config.agentPlugins = {};
  if (!config.agentPlugins[agentId]) config.agentPlugins[agentId] = {};
  config.agentPlugins[agentId]![pluginName] = enabled;
  writeJsonFile(configPath, config);

  const getAgentPath = AGENT_SKILL_PATHS[agentId];
  if (!getAgentPath) {
    invalidatePluginsCache(home);
    invalidateSkillsCache(home);
    return;
  }

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

  invalidatePluginsCache(home);
  invalidateSkillsCache(home);
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
    invalidatePluginsCache(home);
    invalidateSkillsCache(home);
    return { ok: true, name: repoName };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Git clone failed: ${message}` };
  }
}

export async function uninstallPlugin(pluginName: string, home = homeDir()): Promise<{ ok: boolean; error?: string }> {
  const plugins = computePlugins(home);
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
    invalidatePluginsCache(home);
    invalidateSkillsCache(home);
    return { ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to remove ${resolvedTarget}: ${message}` };
  }
}
