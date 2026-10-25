import { grantRoot } from "./parents";
import { expandHome, normalise } from "./paths";
import { personalKind, secretKind, startupKind } from "./sensitive";
import type { AllowRule } from "./types";

function ruleAgent(agent: unknown): AllowRule["agent"] | null {
  if (agent === "*" || agent === "claude-code" || agent === "cursor" || agent === "codex" || agent === "gemini" || agent === "antigravity" || agent === "hermes") return agent;
  return null;
}

export function validateRule(
  input: { kind: unknown; agent: unknown; value: unknown },
  home: string,
): { ok: true; kind: AllowRule["kind"]; agent: AllowRule["agent"]; value: string } | { ok: false; error: string } {
  if (input.kind !== "folder" && input.kind !== "command") return { ok: false, error: "Pick a folder or a command." };
  const agent = ruleAgent(input.agent);
  if (!agent) return { ok: false, error: "Pick an agent." };
  const raw = typeof input.value === "string" ? input.value.trim() : "";
  if (!raw) return { ok: false, error: "Enter a folder path or a command." };
  if (input.kind === "command") return { ok: true, kind: "command", agent, value: raw };
  const expanded = expandHome(raw, home);
  if (!expanded.startsWith("/")) return { ok: false, error: "Folder path must be absolute." };
  const value = normalise(expanded, home, home);
  if (grantRoot(value, true, () => true) !== value) return { ok: false, error: "That folder is too broad." };
  if (secretKind(value, home) || startupKind(value, home)) return { ok: false, error: "Secret and startup files can't be allowed forever. Approve them from the popup when needed." };
  const personal = personalKind(value, home);
  if (personal && value.split("/").pop() === personal) return { ok: false, error: `Your whole ${personal} folder can't be allowed forever. Pick a folder inside it.` };
  return { ok: true, kind: "folder", agent, value };
}
