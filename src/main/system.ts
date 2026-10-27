import type { AgentId } from "../shared/types";

export interface PsRow {
  pid: number;
  ppid: number;
  args: string;
}

// Main executables across macOS, Linux, and Windows.
const GUI = [
  {
    agent: "cursor",
    name: "Cursor",
    bundleId: "com.todesktop.230313mzl4w4u92",
    match: /(\/Cursor\.app\/Contents\/MacOS\/Cursor|(\/|\\)opt(\/|\\)Cursor(\/|\\)cursor|(\/|\\)(Programs|Program Files)(\/|\\)cursor(\/|\\)Cursor(\.exe)?)(\s|$)/i,
  },
  {
    agent: "claude-code",
    name: "Claude",
    bundleId: "com.anthropic.claudefordesktop",
    match: /(\/Claude\.app\/Contents\/MacOS\/Claude|(\/|\\)(Programs|Program Files)(\/|\\)Claude(\/|\\)Claude(\.exe)?)(\s|$)/i,
  },
  {
    agent: "t3-code",
    name: "T3 Code",
    bundleId: "com.t3tools.t3code",
    match: /(\/T3 Code\.app\/Contents\/MacOS\/[^/\s]+|(\/|\\)(Programs|Program Files)(\/|\\)t3-code(\/|\\)T3 Code(\.exe)?)(\s|$)/i,
  },
  {
    agent: "antigravity",
    name: "Antigravity",
    bundleId: "com.google.antigravity",
    match: /(\/Antigravity\.app\/Contents\/MacOS\/[^/\s]+|(\/|\\)(Programs|Program Files)(\/|\\)Antigravity(\/|\\)Antigravity(\.exe)?)(\s|$)/i,
  },
] as const;

const CLI: Record<string, { agent: AgentId; name: string }> = {
  claude: { agent: "claude-code", name: "Claude" },
  "cursor-agent": { agent: "cursor", name: "Cursor agent" },
  codex: { agent: "codex", name: "Codex" },
  gemini: { agent: "gemini", name: "Gemini CLI" },
  agy: { agent: "antigravity", name: "Antigravity" },
  antigravity: { agent: "antigravity", name: "Antigravity" },
  hermes: { agent: "hermes", name: "Hermes" },
};

export function parsePs(text: string): PsRow[] {
  return text
    .split("\n")
    .slice(1)
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return match ? { pid: Number(match[1]), ppid: Number(match[2]), args: match[3]! } : null;
    })
    .filter((row): row is PsRow => row !== null);
}

/**
 * Parses Windows WMIC or PowerShell process CSV listings (CommandLine, ParentProcessId, ProcessId).
 */
export function parseWindowsProcessList(csvText: string): PsRow[] {
  const rows: PsRow[] = [];
  const lines = csvText.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("Node,") || trimmed.startsWith("CommandLine,")) continue;
    // Format: [Node,]CommandLine,ParentProcessId,ProcessId
    const match = /^(?:[^,]+,)?(".*?"|[^,]+),(\d+),(\d+)\s*$/.exec(trimmed);
    if (match) {
      const args = match[1]!;
      const ppid = Number(match[2]);
      const pid = Number(match[3]);
      rows.push({ pid, ppid, args });
    }
  }
  return rows;
}

export interface RestartTarget {
  agent: AgentId;
  name: string;
  pid: number;
  kind: "gui" | "cli";
  bundleId?: string;
}

const command = (token: string | undefined) => {
  if (!token) return undefined;
  const normalized = token.replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  return base.endsWith(".exe") ? base.slice(0, -4) : base;
};

export function restartTargets(rows: PsRow[]): RestartTarget[] {
  const targets: RestartTarget[] = [];
  for (const row of rows) {
    const gui = GUI.find((app) => app.match.test(row.args));
    if (gui) {
      targets.push({ agent: gui.agent, name: gui.name, pid: row.pid, kind: "gui", bundleId: gui.bundleId });
      continue;
    }
    // `node /path/bin/gemini` runs the CLI as the second token.
    const [first, second] = row.args.split(/\s+/);
    const cli = CLI[command(first) ?? ""] ?? (command(first) === "node" ? CLI[command(second) ?? ""] : undefined);
    if (cli) targets.push({ ...cli, pid: row.pid, kind: "cli" });
  }
  return targets;
}

export function guiQuitScript(bundleId: string): string {
  return `tell application id "${bundleId}" to quit`;
}

/**
 * Generates the platform-native graceful process termination command:
 * - macOS: AppleScript `tell app to quit`
 * - Windows: `taskkill /PID <pid>` (sends WM_CLOSE without forcing)
 * - Linux: `kill -TERM <pid>`
 */
export function formatGracefulQuitCommand(pid: number, bundleId?: string, platform = process.platform): string {
  if (platform === "darwin" && bundleId) {
    return guiQuitScript(bundleId);
  }
  if (platform === "win32") {
    return `taskkill /PID ${pid}`;
  }
  return `kill -TERM ${pid}`;
}

export function percentiles(values: number[]): { p50: number | null; p95: number | null } {
  if (!values.length) return { p50: null, p95: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
  return { p50: at(50), p95: at(95) };
}

export function parseLsof(text: string): { pid: number; remote: string }[] {
  const rows: { pid: number; remote: string }[] = [];
  for (const line of text.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    const pid = Number(parts[1]);
    const name = parts.find((part) => part.includes("->")) ?? "";
    const remote = name.includes("->") ? name.split("->")[1] : "";
    if (pid && remote) rows.push({ pid, remote: remote.replace(/\s*\(.*\)$/, "") });
  }
  return rows;
}
