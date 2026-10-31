import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { homeDir } from "../../shared/constants";
import type { AgentId, PluginItem } from "../../shared/types";

const exec = promisify(execFile);

export function getPluginDirs(home = homeDir()): string[] {
  return [
    join(home, ".gemini/config/plugins"),
    join(home, ".gemini/plugins"),
  ];
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

function findManifest(pluginDir: string): { manifest: PluginManifest | null; manifestPath: string | null } {
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

function getAgentPluginConfigPath(agentId: AgentId, home: string): string | null {
  if (agentId === "antigravity") {
    return join(home, ".gemini/config/config.json");
  }
  return null;
}

interface AgentConfigJson {
  plugins?: Record<string, { enabled?: boolean }>;
  enabledPlugins?: string[];
  disabledPlugins?: string[];
  [key: string]: unknown;
}

export function isPluginEnabledForAgent(pluginName: string, agentId: AgentId, home = homeDir()): boolean {
  const configPath = getAgentPluginConfigPath(agentId, home);
  if (!configPath || !existsSync(configPath)) {
    // Default to true for antigravity if installed in gemini config plugins
    return agentId === "antigravity";
  }

  const json = readJsonFile<AgentConfigJson>(configPath);
  if (!json) return agentId === "antigravity";

  if (json.disabledPlugins && json.disabledPlugins.includes(pluginName)) {
    return false;
  }

  if (json.plugins && json.plugins[pluginName]) {
    return json.plugins[pluginName]!.enabled !== false;
  }

  if (json.enabledPlugins) {
    return json.enabledPlugins.includes(pluginName);
  }

  return agentId === "antigravity";
}

export function listPlugins(home = homeDir()): PluginItem[] {
  const baseDirs = getPluginDirs(home);
  const pluginsMap = new Map<string, PluginItem>();

  for (const base of baseDirs) {
    if (!existsSync(base)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }

    for (const folderName of entries) {
      const pluginDir = join(base, folderName);
      const { manifest } = findManifest(pluginDir);
      const scanned = scanPluginFolder(pluginDir);

      const name = manifest?.name || folderName;
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
      const agentsToCheck: AgentId[] = ["antigravity", "claude-code", "gemini", "cursor", "codex"];
      for (const agent of agentsToCheck) {
        if (isPluginEnabledForAgent(name, agent, home)) {
          enabledAgents.push(agent);
        }
      }

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
      });
    }
  }

  return Array.from(pluginsMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function togglePluginForAgent(pluginName: string, agentId: AgentId, enabled: boolean, home = homeDir()): void {
  const configPath = getAgentPluginConfigPath(agentId, home);
  if (!configPath) return;

  const config = readJsonFile<AgentConfigJson>(configPath) || {};
  if (!config.plugins) config.plugins = {};
  config.plugins[pluginName] = { ...config.plugins[pluginName], enabled };

  // Also maintain disabledPlugins list for easy checking
  if (!config.disabledPlugins) config.disabledPlugins = [];
  if (enabled) {
    config.disabledPlugins = config.disabledPlugins.filter((p) => p !== pluginName);
  } else if (!config.disabledPlugins.includes(pluginName)) {
    config.disabledPlugins.push(pluginName);
  }

  writeJsonFile(configPath, config);
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
  const baseDirs = getPluginDirs(home);
  let removed = false;

  for (const base of baseDirs) {
    const targetDir = join(base, pluginName);
    if (existsSync(targetDir)) {
      try {
        rmSync(targetDir, { recursive: true, force: true });
        removed = true;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `Failed to remove ${targetDir}: ${message}` };
      }
    }
  }

  if (!removed) {
    return { ok: false, error: `Plugin "${pluginName}" not found.` };
  }

  return { ok: true };
}
