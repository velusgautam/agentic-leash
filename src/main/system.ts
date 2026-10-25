import type { AgentId } from "../shared/types";

export interface PsRow {
  pid: number;
  ppid: number;
  args: string;
}

// Main executables only; Electron helpers live under Contents/Frameworks.
const GUI = [
  { agent: "cursor", name: "Cursor", bundleId: "com.todesktop.230313mzl4w4u92", match: /\/Cursor\.app\/Contents\/MacOS\/Cursor(\s|$)/ },
  { agent: "claude-code", name: "Claude", bundleId: "com.anthropic.claudefordesktop", match: /\/Claude\.app\/Contents\/MacOS\/Claude(\s|$)/ },
  { agent: "t3-code", name: "T3 Code", bundleId: "com.t3tools.t3code", match: /\/T3 Code\.app\/Contents\/MacOS\/[^/\s]+(\s|$)/ },
  { agent: "gemini", name: "Gemini", bundleId: "com.google.gemini", match: /\/Gemini\.app\/Contents\/MacOS\/[^/\s]+(\s|$)/ },
  { agent: "antigravity", name: "Antigravity", bundleId: "com.google.antigravity", match: /\/Antigravity\.app\/Contents\/MacOS\/[^/\s]+(\s|$)/ },
] as const;

const CLI: Record<string, { agent: AgentId; name: string }> = {
  claude: { agent: "claude-code", name: "Claude" },
  "cursor-agent": { agent: "cursor", name: "Cursor agent" },
  codex: { agent: "codex", name: "Codex" },
  gemini: { agent: "gemini", name: "Gemini" },
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

export interface RestartTarget {
  agent: AgentId;
  name: string;
  pid: number;
  kind: "gui" | "cli";
  bundleId?: string;
}

const command = (token: string | undefined) => token?.slice(token.lastIndexOf("/") + 1);

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
