import type { Verdict } from "../shared/types";

export function respond(entry: "claude" | "cursor" | "codex" | "gemini" | "antigravity" | "hermes", verdict: Verdict | "timeout"): { stdout: string; exitCode: number } {
  if (entry === "hermes") {
    if (verdict === "timeout") return { stdout: JSON.stringify({ action: "approve", message: "Agentic Leash is not answering" }), exitCode: 0 };
    if (verdict.kind === "deny") return { stdout: JSON.stringify({ decision: "block", reason: verdict.reason }), exitCode: 0 };
    return { stdout: "{}\n", exitCode: 0 };
  }
  if (entry === "antigravity") {
    if (verdict === "timeout") return { stdout: JSON.stringify({ decision: "ask", reason: "Agentic Leash is not answering" }), exitCode: 0 };
    if (verdict.kind === "deny") return { stdout: JSON.stringify({ decision: "deny", reason: verdict.reason }), exitCode: 0 };
    return { stdout: JSON.stringify({ decision: "allow" }), exitCode: 0 };
  }
  if (entry === "gemini") {
    if (verdict !== "timeout" && verdict.kind === "deny") return { stdout: JSON.stringify({ decision: "deny", reason: verdict.reason }), exitCode: 0 };
    return { stdout: "", exitCode: 0 };
  }
  if (verdict === "timeout") {
    if (entry === "codex") return { stdout: "", exitCode: 0 };
    if (entry === "claude") {
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "Agentic Leash is not answering" },
        }),
        exitCode: 0,
      };
    }
    return { stdout: JSON.stringify({ permission: "allow" }), exitCode: 0 };
  }
  if (verdict.kind === "pass") {
    return entry === "cursor" ? { stdout: JSON.stringify({ permission: "allow" }), exitCode: 0 } : { stdout: "", exitCode: 0 };
  }
  if (verdict.kind === "deny") {
    if (entry === "claude" || entry === "codex") {
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: verdict.reason },
        }),
        exitCode: 0,
      };
    }
    return { stdout: JSON.stringify({ permission: "deny", user_message: verdict.reason, agent_message: verdict.reason }), exitCode: 0 };
  }
  return respond(entry, "timeout");
}
