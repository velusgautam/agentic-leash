import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homeDir, leashDir } from "../../shared/constants";
import type { AgentId, McpServerConfig } from "../../shared/types";

const SUPPORTED_AGENTS: AgentId[] = ["claude-code", "antigravity", "cursor", "gemini", "codex"];

function registryPath(home: string): string {
  return join(leashDir(home), "mcp-registry.json");
}

function agentMcpPath(agent: AgentId, home: string): string | null {
  switch (agent) {
    case "claude-code":
      return join(home, ".claude.json");
    case "antigravity":
      return join(home, ".gemini/config/mcp_config.json");
    case "cursor":
      return join(home, ".cursor/mcp.json");
    case "gemini":
      return join(home, ".gemini/settings.json");
    case "codex":
      return join(home, ".codex/config.toml");
    default:
      return null;
  }
}

interface McpJsonFile {
  mcpServers?: Record<string, {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    serverUrl?: string;
  }>;
  [key: string]: unknown;
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

// TOML helpers for Codex (~/.codex/config.toml)
interface ParsedTomlMcp {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export function parseCodexToml(content: string): Record<string, ParsedTomlMcp> {
  const result: Record<string, ParsedTomlMcp> = {};
  const lines = content.split(/\r?\n/);
  let currentServer: string | null = null;
  let inEnv = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const sectionMatch = line.match(/^\[mcp_servers\.(?:(?:"([^"]+)")|([A-Za-z0-9_\-]+))(\.env)?\]$/);
    if (sectionMatch) {
      const serverName = sectionMatch[1] ?? sectionMatch[2]!;
      const isEnv = Boolean(sectionMatch[3]);
      currentServer = serverName;
      inEnv = isEnv;
      if (!result[currentServer]) {
        result[currentServer] = {};
      }
      continue;
    }

    if (line.startsWith("[")) {
      currentServer = null;
      inEnv = false;
      continue;
    }

    if (currentServer && result[currentServer]) {
      const eqIdx = line.indexOf("=");
      if (eqIdx !== -1) {
        const key = line.slice(0, eqIdx).trim();
        let rawVal = line.slice(eqIdx + 1).trim();

        if (inEnv) {
          const srv = result[currentServer];
          if (srv) {
            if (!srv.env) srv.env = {};
            const unquoted = rawVal.replace(/^["']|["']$/g, "");
            srv.env[key] = unquoted;
          }
        } else if (key === "command") {
          result[currentServer].command = rawVal.replace(/^["']|["']$/g, "");
        } else if (key === "url") {
          result[currentServer].url = rawVal.replace(/^["']|["']$/g, "");
        } else if (key === "args") {
          // If the array spans multiple lines, collect until closing bracket ']'
          while (!rawVal.includes("]") && i + 1 < lines.length) {
            i++;
            rawVal += ` ${lines[i]!.trim()}`;
          }
          try {
            result[currentServer].args = JSON.parse(rawVal);
          } catch {
            const items = rawVal
              .replace(/^\[|\]$/g, "")
              .split(",")
              .map((s) => s.trim().replace(/^["']|["']$/g, ""))
              .filter(Boolean);
            result[currentServer].args = items;
          }
        }
      }
    }
  }

  return result;
}

export function serializeCodexToml(content: string, serverName: string, config: ParsedTomlMcp | null): string {
  // Remove existing sections for this server
  const lines = content.split(/\r?\n/);
  const outLines: string[] = [];
  let skipping = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    const isMatch = trimmed.match(/^\[mcp_servers\.(?:(?:"([^"]+)")|([A-Za-z0-9_\-]+))(?:\.env)?\]$/);
    if (isMatch) {
      const name = isMatch[1] ?? isMatch[2];
      if (name === serverName) {
        skipping = true;
        continue;
      } else {
        skipping = false;
      }
    } else if (trimmed.startsWith("[")) {
      skipping = false;
    }

    if (!skipping) {
      outLines.push(line);
    }
  }

  // If adding/updating config
  if (config) {
    // Trim trailing empty lines
    while (outLines.length && outLines[outLines.length - 1]!.trim() === "") {
      outLines.pop();
    }
    outLines.push("");
    const formattedName = /^[A-Za-z0-9_-]+$/.test(serverName) ? serverName : `"${serverName}"`;
    outLines.push(`[mcp_servers.${formattedName}]`);
    if (config.command) {
      outLines.push(`command = ${JSON.stringify(config.command)}`);
    }
    if (config.args && config.args.length > 0) {
      outLines.push(`args = ${JSON.stringify(config.args)}`);
    }
    if (config.url) {
      outLines.push(`url = ${JSON.stringify(config.url)}`);
    }
    if (config.env && Object.keys(config.env).length > 0) {
      outLines.push("");
      outLines.push(`[mcp_servers.${formattedName}.env]`);
      for (const [k, v] of Object.entries(config.env)) {
        outLines.push(`${k} = ${JSON.stringify(v)}`);
      }
    }
    outLines.push("");
  }

  return outLines.join("\n");
}

function readAgentMcp(agent: AgentId, home: string): Record<string, ParsedTomlMcp> {
  const path = agentMcpPath(agent, home);
  if (!path || !existsSync(path)) return {};

  if (agent === "codex") {
    try {
      const text = readFileSync(path, "utf8");
      return parseCodexToml(text);
    } catch {
      return {};
    }
  }

  const json = readJsonFile<McpJsonFile>(path);
  if (!json?.mcpServers) return {};

  const result: Record<string, ParsedTomlMcp> = {};
  for (const [name, server] of Object.entries(json.mcpServers)) {
    result[name] = {
      command: server.command,
      args: server.args,
      env: server.env,
      url: server.url ?? server.serverUrl,
    };
  }
  return result;
}

function writeAgentMcp(agent: AgentId, serverName: string, config: McpServerConfig | null, home: string): void {
  const path = agentMcpPath(agent, home);
  if (!path) return;

  if (agent === "codex") {
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
    const updated = serializeCodexToml(existing, serverName, config);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, updated, "utf8");
    return;
  }

  const existing = readJsonFile<McpJsonFile>(path) ?? {};
  if (!existing.mcpServers) existing.mcpServers = {};

  if (config) {
    const entry: Record<string, unknown> = {};
    if (config.command) entry.command = config.command;
    if (config.args) entry.args = config.args;
    if (config.env) entry.env = config.env;
    if (config.url) entry.url = config.url;
    existing.mcpServers[serverName] = entry;
  } else {
    delete existing.mcpServers[serverName];
  }

  writeJsonFile(path, existing);
}

interface RegistryFile {
  servers?: Record<string, McpServerConfig> | McpServerConfig[];
}

function loadRegistry(home: string): Record<string, McpServerConfig> {
  const regPath = registryPath(home);
  const data = readJsonFile<RegistryFile>(regPath);
  if (!data?.servers) return {};

  if (Array.isArray(data.servers)) {
    const map: Record<string, McpServerConfig> = {};
    for (const s of data.servers) {
      if (s?.name) map[s.name] = s;
    }
    return map;
  }

  return data.servers;
}

function saveRegistry(registry: Record<string, McpServerConfig>, home: string): void {
  const regPath = registryPath(home);
  writeJsonFile(regPath, { servers: registry });
}

export function listMcpServers(home = homeDir()): McpServerConfig[] {
  const registry = loadRegistry(home);
  const agentConfigs: Partial<Record<AgentId, Record<string, ParsedTomlMcp>>> = {};

  for (const agent of SUPPORTED_AGENTS) {
    agentConfigs[agent] = readAgentMcp(agent, home);
  }

  // Gather all unique server names from registry and all agent configs
  const serverNames = new Set<string>(Object.keys(registry));
  for (const agent of SUPPORTED_AGENTS) {
    for (const name of Object.keys(agentConfigs[agent] ?? {})) {
      serverNames.add(name);
    }
  }

  const result: McpServerConfig[] = [];

  for (const name of serverNames) {
    const regItem = registry[name];
    const enabledAgents: AgentId[] = [];

    let command = regItem?.command;
    let args = regItem?.args;
    let env = regItem?.env;
    let url = regItem?.url;

    for (const agent of SUPPORTED_AGENTS) {
      const agentServer = agentConfigs[agent]?.[name];
      if (agentServer) {
        enabledAgents.push(agent);
        command = command ?? agentServer.command;
        args = args ?? agentServer.args;
        env = env ?? agentServer.env;
        url = url ?? agentServer.url;
      }
    }

    result.push({
      name,
      command,
      args,
      env,
      url,
      enabledAgents,
    });
  }

  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export function saveMcpServer(server: McpServerConfig, home = homeDir()): void {
  const registry = loadRegistry(home);
  registry[server.name] = { ...server };
  saveRegistry(registry, home);

  for (const agent of SUPPORTED_AGENTS) {
    if (server.enabledAgents.includes(agent)) {
      writeAgentMcp(agent, server.name, server, home);
    } else {
      writeAgentMcp(agent, server.name, null, home);
    }
  }
}

export function deleteMcpServer(name: string, home = homeDir()): void {
  const registry = loadRegistry(home);
  delete registry[name];
  saveRegistry(registry, home);

  for (const agent of SUPPORTED_AGENTS) {
    writeAgentMcp(agent, name, null, home);
  }
}

export function toggleMcpForAgent(serverName: string, agentId: AgentId, enabled: boolean, home = homeDir()): void {
  const allServers = listMcpServers(home);
  const target = allServers.find((s) => s.name === serverName);

  const registry = loadRegistry(home);
  const regItem = registry[serverName] || (target ? { ...target } : { name: serverName, enabledAgents: [] });

  const currentSet = new Set(regItem.enabledAgents || target?.enabledAgents || []);
  if (enabled) {
    currentSet.add(agentId);
  } else {
    currentSet.delete(agentId);
  }

  regItem.enabledAgents = Array.from(currentSet);
  registry[serverName] = regItem;
  saveRegistry(registry, home);

  // Update only agentId's configuration without rewriting any other agent's config
  if (enabled) {
    const configToWrite: McpServerConfig = target || {
      name: serverName,
      command: regItem.command,
      args: regItem.args,
      env: regItem.env,
      url: regItem.url,
      enabledAgents: regItem.enabledAgents,
    };
    writeAgentMcp(agentId, serverName, configToWrite, home);
  } else {
    writeAgentMcp(agentId, serverName, null, home);
  }
}
