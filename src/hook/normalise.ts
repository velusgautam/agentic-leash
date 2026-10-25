import { isReadOnlyCommand } from "../shared/commands";
import { extractShellPaths, normalise } from "../shared/paths";
import type { Access, HookRequest } from "../shared/types";

export type Normalised = { kind: "ignore" } | { kind: "request"; request: HookRequest };

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function resolveOne(path: string, cwd: string, home?: string): string {
  const cwdNorm = normalise(cwd, cwd, home);
  return extractShellPaths(path, cwd, home).find((item) => item !== cwdNorm) ?? normalise(path, cwd, home);
}

// A read grant on the folder covers `git status` and friends; anything else needs write.
function shellAccess(command: string): Access {
  return isReadOnlyCommand(command) ? "read" : "write";
}

function request(partial: HookRequest): Normalised {
  return { kind: "request", request: partial };
}

export function normaliseHook(raw: unknown, entry: "claude" | "cursor" | "codex" | "gemini" | "antigravity" | "hermes", home?: string): Normalised {
  const payload = asRecord(raw);
  if (entry === "claude" && typeof payload.cursor_version === "string") return { kind: "ignore" };

  const input = asRecord(payload.tool_input);
  const cwd = str(payload.cwd) || str(input.cwd) || (Array.isArray(payload.workspace_roots) ? str(payload.workspace_roots[0]) : "") || "/";
  const event = str(payload.hook_event_name);
  const sessionId = str(payload.session_id) || str(payload.turn_id) || undefined;
  const agent = entry === "claude" ? "claude-code" : entry;

  if (entry === "gemini") {
    const tool = str(payload.tool_name) || "unknown";
    if (tool === "run_shell_command" || tool === "Shell") {
      const command = str(input.command) || str(payload.command);
      return request({ agent, event, tool, access: shellAccess(command), paths: extractShellPaths(command, cwd, home), cwd, command, sessionId });
    }
    const rawPaths = [input.file_path, input.path].filter((value): value is string => typeof value === "string" && value.length > 0);
    const access: Access = tool === "write_file" || tool === "replace" ? "write" : "read";
    return request({ agent, event, tool, access, paths: rawPaths.map((path) => resolveOne(path, cwd, home)), cwd, sessionId });
  }

  if (entry === "antigravity") {
    const toolCall = asRecord(payload.toolCall);
    const callArgs = asRecord(toolCall.args);
    const args = Object.keys(callArgs).length ? callArgs : input;
    const tool = str(toolCall.name) || str(payload.tool_name) || "unknown";
    const workspaceRoot = Array.isArray(payload.workspacePaths) ? str(payload.workspacePaths[0]) : "";
    const agyCwd = str(payload.cwd) || str(args.cwd) || workspaceRoot || cwd;
    const agySession = str(payload.conversationId) || sessionId;
    const agyEvent = event || "PreToolUse";
    if (tool === "run_command" || tool === "run_shell_command" || tool === "Shell" || tool === "Bash") {
      const command = str(args.CommandLine) || str(args.command) || str(payload.command);
      return request({ agent: "antigravity", event: agyEvent, tool, access: shellAccess(command), paths: extractShellPaths(command, agyCwd, home), cwd: agyCwd, command, sessionId: agySession });
    }
    if (tool === "search_web" || tool === "read_url_content" || tool === "WebFetch" || tool === "WebSearch") {
      return request({ agent: "antigravity", event: agyEvent, tool, access: "read", paths: [], cwd: agyCwd, url: str(args.Url) || str(args.url) || str(args.query) || undefined, sessionId: agySession });
    }
    const rawPaths = [args.Path, args.TargetFile, args.SearchPath, args.DirectoryPath, args.file_path, args.path].filter((value): value is string => typeof value === "string" && value.length > 0);
    const access: Access = tool === "write_file" || tool === "edit_file" || tool === "replace" || tool === "replace_file_content" || tool === "multi_replace_file_content" || WRITE_TOOLS.has(tool) ? "write" : "read";
    return request({ agent: "antigravity", event: agyEvent, tool, access, paths: rawPaths.map((path) => resolveOne(path, agyCwd, home)), cwd: agyCwd, sessionId: agySession });
  }

  if (entry === "hermes") {
    const tool = str(payload.tool_name) || "unknown";
    if (tool === "terminal") {
      const command = str(input.command);
      return request({ agent, event, tool, access: shellAccess(command), paths: extractShellPaths(command, cwd, home), cwd, command, sessionId });
    }
    const path = str(input.path);
    const paths = path ? [resolveOne(path, cwd, home)] : [];
    if (tool === "write_file" || tool === "patch") return request({ agent, event, tool, access: "write", paths, cwd, sessionId });
    if (tool === "read_file") return request({ agent, event, tool, access: "read", paths, cwd, sessionId });
    return request({ agent, event, tool, access: "read", paths: [], cwd, sessionId });
  }

  if (entry === "cursor" && event === "beforeReadFile") {
    const file = str(payload.file_path);
    return request({ agent, event, tool: "Read", access: "read", paths: file ? [resolveOne(file, cwd, home)] : [], cwd, sessionId });
  }
  if (entry === "cursor" && event === "beforeShellExecution") {
    const command = str(payload.command);
    return request({ agent, event, tool: "Shell", access: shellAccess(command), paths: extractShellPaths(command, cwd, home), cwd, command, sessionId });
  }
  // Shell, Read and MCP calls are gated by their own before* events.
  if (entry === "cursor" && event === "preToolUse" && /^(shell|read|mcp.*)$/i.test(str(payload.tool_name))) return { kind: "ignore" };
  if (entry === "cursor" && event === "beforeMCPExecution") {
    return request({ agent, event, tool: str(payload.tool_name) || "MCP", access: "read", paths: [], cwd, sessionId });
  }

  const tool = str(payload.tool_name) || "unknown";
  if (tool === "Bash" || tool === "Shell") {
    const command = str(input.command) || str(payload.command);
    const shellCwd = str(input.cwd) || cwd;
    return request({ agent, event, tool, access: shellAccess(command), paths: extractShellPaths(command, shellCwd, home), cwd: shellCwd, command, sessionId });
  }
  if (tool === "WebFetch") {
    return request({ agent, event, tool, access: "read", paths: [], cwd, url: str(input.url) || undefined, sessionId });
  }
  if (tool === "WebSearch" || tool.startsWith("mcp")) {
    return request({ agent, event, tool, access: "read", paths: [], cwd, sessionId });
  }

  const rawPaths = [input.file_path, input.notebook_path, input.path].filter((value): value is string => typeof value === "string" && value.length > 0);
  const access: Access = WRITE_TOOLS.has(tool) ? "write" : "read";
  return request({ agent, event, tool, access, paths: rawPaths.map((path) => resolveOne(path, cwd, home)), cwd, sessionId });
}
