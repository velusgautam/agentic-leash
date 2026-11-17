import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Access, AgentSnapshot } from "../../shared/types";
import { readJson, readJsonFiles } from "./fs";

export type ClaudeSettings = {
  allowManagedHooksOnly?: boolean;
  disableAllHooks?: boolean;
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[]; additionalDirectories?: string[] };
  sandbox?: { network?: { allowedDomains?: string[]; deniedDomains?: string[] }; filesystem?: { allowWrite?: string[]; denyRead?: string[] } };
};

type McpServer = { url?: string; command?: string };
type ClaudeJson = {
  mcpServers?: Record<string, McpServer>;
  projects?: Record<string, { hasTrustDialogAccepted?: boolean; mcpServers?: Record<string, McpServer> }>;
};
type ManagedFile = { source: string; settings: ClaudeSettings; mcp?: { serverUrl?: string }[] };

const MANAGED_DIR = "/Library/Application Support/ClaudeCode";

const PATH_TOOLS = new Set(["Read", "Edit", "Write", "NotebookEdit", "Glob", "Grep"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

export function claudeHooksBlocked(managed: ClaudeSettings[], effective: ClaudeSettings): boolean {
  return managed.some((settings) => settings.allowManagedHooksOnly === true) || effective.disableAllHooks === true;
}

function parseRule(rule: string): { tool: string; arg?: string } {
  const match = /^([A-Za-z][\w]*)(?:\((.*)\))?$/.exec(rule);
  return match ? { tool: match[1]!, arg: match[2] } : { tool: rule };
}

function consume(settings: ClaudeSettings, source: string, locked: boolean, snapshot: Pick<AgentSnapshot, "folders" | "network">): void {
  const permissions = settings.permissions ?? {};
  const denied = new Set(permissions.deny ?? []);
  for (const dir of permissions.additionalDirectories ?? []) snapshot.folders.push({ path: dir, access: "write", source, locked });
  for (const rule of [...(permissions.allow ?? []), ...(permissions.deny ?? []), ...(permissions.ask ?? [])]) {
    const { tool, arg } = parseRule(rule);
    if (PATH_TOOLS.has(tool) && arg && !arg.startsWith("domain:")) {
      const access: Access = WRITE_TOOLS.has(tool) ? "write" : "read";
      snapshot.folders.push({ path: arg, access, source, locked });
    } else if (tool === "WebFetch" || tool === "WebSearch") {
      snapshot.network.push({ rule, effect: denied.has(rule) ? "deny" : "allow", source, locked });
    }
  }
  for (const domain of settings.sandbox?.network?.allowedDomains ?? []) snapshot.network.push({ rule: domain, effect: "allow", source, locked });
  for (const domain of settings.sandbox?.network?.deniedDomains ?? []) snapshot.network.push({ rule: domain, effect: "deny", source, locked });
  for (const path of settings.sandbox?.filesystem?.allowWrite ?? []) snapshot.folders.push({ path, access: "write", source, locked });
  for (const path of settings.sandbox?.filesystem?.denyRead ?? []) snapshot.folders.push({ path, access: "read", source, locked });
}

export function snapshotFromClaude(input: { settings: ClaudeSettings; settingsLocal: ClaudeSettings; claudeJson: ClaudeJson; managed: ManagedFile[]; installed: boolean }): AgentSnapshot {
  const managedSettings = input.managed.map((file) => file.settings);
  const blocked = claudeHooksBlocked(managedSettings, { ...input.settings, disableAllHooks: input.settings.disableAllHooks || input.settingsLocal.disableAllHooks });
  const company = managedSettings.some((settings) => settings.allowManagedHooksOnly === true);
  const snapshot: AgentSnapshot = {
    id: "claude-code",
    name: "Claude",
    installed: input.installed,
    enforcement: blocked ? "rules" : "hook",
    note: blocked ? (company ? "Rules mode (fallback): company policy blocks hooks" : "Rules mode (fallback): hooks are disabled") : "Hook mode",
    folders: [],
    mcpServers: [],
    network: [],
    children: [],
    workers: [],
    privacy: [],
  };
  consume(input.settings, "settings.json", false, snapshot);
  consume(input.settingsLocal, "settings.local.json", false, snapshot);
  for (const file of input.managed) consume(file.settings, file.source, true, snapshot);
  const addMcp = (name: string, server: McpServer, source: string, locked: boolean) => snapshot.mcpServers.push({ name, url: server.url, command: server.command, source, locked });
  for (const [name, server] of Object.entries(input.claudeJson.mcpServers ?? {})) addMcp(name, server, "~/.claude.json", false);
  for (const [project, meta] of Object.entries(input.claudeJson.projects ?? {})) {
    if (meta.hasTrustDialogAccepted) snapshot.folders.push({ path: project, access: "write", source: "~/.claude.json", locked: false });
    for (const [name, server] of Object.entries(meta.mcpServers ?? {})) addMcp(name, server, "~/.claude.json", false);
  }
  for (const file of input.managed) {
    for (const server of file.mcp ?? []) {
      if (server.serverUrl) snapshot.mcpServers.push({ name: server.serverUrl, url: server.serverUrl, source: file.source, locked: true });
    }
  }
  return snapshot;
}

export function claudeWatchPaths(root: string, managedDir = MANAGED_DIR): string[] {
  return [join(root, "settings.json"), join(root, "settings.local.json"), join(root, "remote-settings.json"), join(root, "..", ".claude.json"), join(managedDir, "managed-settings.json"), join(managedDir, "managed-settings.d")];
}

export function loadClaude(root: string, claudeJsonPath: string, managedDir = MANAGED_DIR): AgentSnapshot {
  const settings = readJson(join(root, "settings.json")) as ClaudeSettings;
  const settingsLocal = readJson(join(root, "settings.local.json")) as ClaudeSettings;
  const remote = readJson(join(root, "remote-settings.json")) as ClaudeSettings & { allowedMcpServers?: { serverUrl?: string }[] };
  const managedFile = readJson(join(managedDir, "managed-settings.json")) as ClaudeSettings;
  const extra = readJsonFiles(join(managedDir, "managed-settings.d")).map((file) => ({ source: file.name, settings: file.value as ClaudeSettings }));
  const managed: ManagedFile[] = [
    { source: "remote-settings.json", settings: remote, mcp: remote.allowedMcpServers },
    { source: "managed-settings.json", settings: managedFile },
    ...extra,
  ];
  return snapshotFromClaude({
    settings,
    settingsLocal,
    claudeJson: readJson(claudeJsonPath) as ClaudeJson,
    managed,
    installed: existsSync(root),
  });
}
