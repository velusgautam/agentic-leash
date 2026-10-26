import type { PendingRequest } from "./types";

export const AGENT_LABELS: Record<string, string> = { "claude-code": "Claude Code", cursor: "Cursor", codex: "Codex", gemini: "Gemini CLI", antigravity: "Antigravity", hermes: "Hermes" };

export const agentLabel = (agent: string) => (agent === "*" ? "All agents" : AGENT_LABELS[agent] ?? agent);

export function pendingNotice(item: PendingRequest): { title: string; body: string } {
  const { agent, access, command, paths, url } = item.request;
  const target = command?.trim() || url || paths[0] || "";
  const extra = !command?.trim() && !url && paths.length > 1 ? ` and ${paths.length - 1} more` : "";
  const name = AGENT_LABELS[agent] ?? agent;
  const title = item.policy ? `${name} wants to ${item.policy.summary}` : `${name} wants ${access} access`;
  const reason = item.policy?.reasons[0];
  return { title, body: reason ? `${target}${extra}\n${reason}` : `${target}${extra}` };
}
