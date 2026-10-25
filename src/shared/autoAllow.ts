import type { AgentId } from "./types";

export interface AutoAllow {
  id: string;
  agent: AgentId | "*";
  folder: string;
  label: string;
}

export const AUTO_ALLOWS: AutoAllow[] = [
  { id: "claude-skills", agent: "claude-code", folder: ".claude/skills", label: "Skills" },
  { id: "claude-plugins", agent: "claude-code", folder: ".claude/plugins", label: "Plugins" },
  { id: "claude-commands", agent: "claude-code", folder: ".claude/commands", label: "Commands" },
  { id: "cursor-skills", agent: "cursor", folder: ".cursor/skills", label: "Skills" },
  { id: "cursor-skills-builtin", agent: "cursor", folder: ".cursor/skills-cursor", label: "Built-in skills" },
  { id: "codex-skills", agent: "codex", folder: ".codex/skills", label: "Skills" },
  { id: "antigravity-skills", agent: "antigravity", folder: ".gemini/config/skills", label: "Global skills" },
  { id: "antigravity-builtin-skills", agent: "antigravity", folder: ".gemini/antigravity-cli/builtin/skills", label: "Built-in skills" },
  { id: "agents-skills", agent: "*", folder: ".agents/skills", label: "Shared skills" },
];

export function parseAutoAllowOff(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function folderMatches(path: string, folder: string): boolean {
  const parts = path.split("/").filter(Boolean);
  const want = folder.split("/").filter(Boolean);
  return parts.some((_, index) => want.every((part, offset) => parts[index + offset] === part));
}

export function autoAllowCovers(agent: string, path: string, off: readonly string[]): boolean {
  return AUTO_ALLOWS.some((rule) => !off.includes(rule.id) && (rule.agent === "*" || rule.agent === agent) && folderMatches(path, rule.folder));
}
