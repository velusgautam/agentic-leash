import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentId, AgentSnapshot } from "../../shared/types";
import { readJson } from "./fs";

const CHILD_KEYS: Record<string, AgentId> = { claudeAgent: "claude-code", claude: "claude-code", cursor: "cursor", codex: "codex", gemini: "gemini", antigravity: "antigravity", agy: "antigravity" };

type Instance = { enabled?: boolean; config?: { binaryPath?: string } };

export function snapshotFromT3(settings: { providers?: Record<string, { enabled?: boolean }>; providerInstances?: Record<string, Instance> }, installed: boolean): AgentSnapshot {
  const children = new Set<AgentId>();
  const binaries: string[] = [];
  for (const [key, value] of Object.entries(settings.providers ?? {})) {
    if (value.enabled && CHILD_KEYS[key]) children.add(CHILD_KEYS[key]);
  }
  for (const [key, value] of Object.entries(settings.providerInstances ?? {})) {
    if (!value.enabled) continue;
    const id = CHILD_KEYS[key];
    if (id) children.add(id);
    if (value.config?.binaryPath) binaries.push(value.config.binaryPath);
  }
  return {
    id: "t3-code",
    name: "T3 Code",
    installed,
    enforcement: "monitor-only",
    note: binaries.length ? binaries.join(", ") : "Runs other agents. Their own hooks apply.",
    folders: [],
    mcpServers: [],
    network: [],
    children: [...children],
    workers: [],
    privacy: [],
  };
}

export function loadT3(settingsPath: string): AgentSnapshot {
  return snapshotFromT3(readJson(settingsPath) as { providers?: Record<string, { enabled?: boolean }>; providerInstances?: Record<string, Instance> }, existsSync(settingsPath));
}

export function tomlMcpNames(text: string): string[] {
  return [...text.matchAll(/^\[mcp_servers\.([^\]]+)\]/gm)].map((match) => match[1]!);
}

export function loadCodex(configPath: string): AgentSnapshot {
  const installed = existsSync(configPath);
  const text = installed ? readFileSync(configPath, "utf8") : "";
  return {
    id: "codex",
    name: "Codex",
    installed,
    enforcement: "monitor-only",
    note: "Monitor only in v1",
    folders: [],
    mcpServers: tomlMcpNames(text).map((name) => ({ name, source: "config.toml", locked: false })),
    network: [],
    children: [],
    workers: [],
    privacy: [],
  };
}

export function loadHermes(dir: string): AgentSnapshot {
  return {
    id: "hermes",
    name: "Hermes",
    installed: existsSync(dir),
    enforcement: "hook",
    note: "",
    folders: [],
    mcpServers: [],
    network: [],
    children: [],
    workers: [],
    privacy: [],
  };
}

export function loadGemini(dir: string): AgentSnapshot {
  const settingsPath = join(dir, "settings.json");
  const trustedPath = join(dir, "trustedFolders.json");
  const installed = existsSync(settingsPath) || existsSync(trustedPath);
  const settings = readJson(settingsPath) as { mcpServers?: Record<string, { url?: string; command?: string }> };
  const trusted = readJson(trustedPath) as Record<string, string>;
  return {
    id: "gemini",
    name: "Gemini CLI",
    installed,
    enforcement: "monitor-only",
    note: "Monitor only in v1",
    folders: Object.entries(trusted)
      .filter((entry) => typeof entry[1] === "string")
      .map(([path, trust]) => ({ path, access: "read" as const, source: `trustedFolders.json (${trust})`, locked: false })),
    mcpServers: Object.entries(settings.mcpServers ?? {}).map(([name, server]) => ({ name, url: server.url, command: server.command, source: "settings.json", locked: false })),
    network: [],
    children: [],
    workers: [],
    privacy: [],
  };
}

export function antigravityPresent(dir: string): boolean {
  return (
    existsSync(join(dir, "antigravity")) ||
    existsSync(join(dir, "antigravity-cli")) ||
    existsSync(join(dir, "antigravity-ide")) ||
    existsSync(join(dir, "config/hooks.json")) ||
    existsSync(join(dir, "config/mcp_config.json"))
  );
}

export function loadAntigravity(dir: string): AgentSnapshot {
  const mcpPath = join(dir, "config/mcp_config.json");
  const hooksPath = join(dir, "config/hooks.json");
  const installed = antigravityPresent(dir);
  const mcp = readJson(mcpPath) as { mcpServers?: Record<string, { url?: string; serverUrl?: string; command?: string }> };
  const hooks = readJson(hooksPath) as Record<string, { enabled?: boolean; PreToolUse?: { hooks?: { command?: string }[] }[] }>;
  const hasHook = Object.values(hooks).some(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      entry.enabled !== false &&
      (entry.PreToolUse ?? []).some((group) => (group.hooks ?? []).some((hook) => hook.command?.includes("leash-hook"))),
  );
  return {
    id: "antigravity",
    name: "Antigravity",
    installed,
    enforcement: hasHook ? "hook" : "monitor-only",
    note: hasHook ? undefined : "Install hooks to gate tool calls",
    folders: [],
    mcpServers: Object.entries(mcp.mcpServers ?? {}).map(([name, server]) => ({
      name,
      url: server.url ?? server.serverUrl,
      command: server.command,
      source: "config/mcp_config.json",
      locked: false,
    })),
    network: [],
    children: [],
    workers: [],
    privacy: [],
  };
}
