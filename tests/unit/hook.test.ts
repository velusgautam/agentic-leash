import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handlePayload } from "../../src/hook/handle";
import { normaliseHook } from "../../src/hook/normalise";
import { respond } from "../../src/hook/respond";
import { antigravityHooksInstalled, codexHooksInstalled, geminiHooksInstalled, mergeAntigravityHooks, mergeCodexHooks, mergeGeminiHooks, removeAntigravityHooks, removeCodexHooks, removeGeminiHooks } from "../../src/main/hookInstall";
import { openGrantsDb } from "../../src/shared/db";

const fixture = (name: string) => JSON.parse(readFileSync(join("tests/fixtures/hooks", name), "utf8"));

describe("normalise", () => {
  it("reads claude and cursor fixtures", () => {
    expect(normaliseHook(fixture("claude-preToolUse-read.json"), "claude").kind).toBe("request");
    const edit = normaliseHook(fixture("claude-preToolUse-edit.json"), "claude");
    expect(edit.kind === "request" && edit.request.access).toBe("write");
    const bash = normaliseHook(fixture("claude-preToolUse-bash.json"), "claude");
    expect(bash.kind === "request" && bash.request.paths.some((path) => path.endsWith("/Users/velu.gautam"))).toBe(true);
    expect(normaliseHook(fixture("cursor-preToolUse-read.json"), "cursor")).toEqual({ kind: "ignore" });
    expect(normaliseHook({ hook_event_name: "preToolUse", tool_name: "MCP:foo", tool_input: {} }, "cursor")).toEqual({ kind: "ignore" });
    expect(normaliseHook(fixture("cursor-preToolUse-write.json"), "cursor").kind).toBe("request");
    const read = normaliseHook(fixture("cursor-beforeReadFile.json"), "cursor");
    expect(read.kind === "request" && read.request.paths[0]).toContain("spike-results.md");
    expect(normaliseHook(fixture("cursor-ide-via-claude-settings-preToolUse-read.json"), "claude")).toEqual({ kind: "ignore" });
    const shell = normaliseHook(fixture("cursor-beforeShellExecution.json"), "cursor");
    expect(shell.kind === "request" && shell.request.command).toBe("ls spikes");
  });

  it("uses the cursor workspace root when cwd is empty", () => {
    const shell = normaliseHook({ hook_event_name: "beforeShellExecution", command: "ls /w/a/b", cwd: "", workspace_roots: ["/w/a"] }, "cursor");
    expect(shell.kind === "request" && shell.request.paths).toEqual(["/w/a", "/w/a/b"]);
  });

  it("gates cursor shell once, at beforeShellExecution", async () => {
    const raw = { hook_event_name: "preToolUse", tool_name: "Shell", tool_input: { command: "ls", cwd: "" }, cwd: "", workspace_roots: ["/w/a"] };
    expect(normaliseHook(raw, "cursor")).toEqual({ kind: "ignore" });
    const db = openGrantsDb(join("/tmp", `al-ignore-${Date.now()}.db`));
    const result = await handlePayload({ entry: "cursor", raw, db, now: Date.now(), home: "/tmp", ask: async () => "deny" });
    expect(JSON.parse(result.stdout).permission).toBe("allow");
    db.close();
  });
});

describe("codex hooks", () => {
  it("merges a Codex PreToolUse command and detects it", () => {
    const command = 'ELECTRON_RUN_AS_NODE=1 "/App" "/leash-hook.js" codex';
    const merged = mergeCodexHooks({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "other" }] }] } }, command);
    expect(codexHooksInstalled(merged, command)).toBe(true);
    expect(codexHooksInstalled(removeCodexHooks(merged), command)).toBe(false);
    const request = normaliseHook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls /tmp" }, cwd: "/tmp", turn_id: "t1" }, "codex");
    expect(request.kind === "request" && request.request.agent).toBe("codex");
    expect(JSON.parse(respond("codex", { kind: "deny", reason: "no" }).stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(respond("codex", "timeout")).toEqual({ stdout: "", exitCode: 0 });
  });
});

describe("gemini hooks", () => {
  it("merges a Gemini BeforeTool command and denies with decision", () => {
    const command = 'ELECTRON_RUN_AS_NODE=1 "/App" "/leash-hook.js" gemini';
    const merged = mergeGeminiHooks({ mcpServers: { local: {} } }, command);
    expect(merged.mcpServers).toEqual({ local: {} });
    expect(geminiHooksInstalled(merged, command)).toBe(true);
    expect(geminiHooksInstalled(removeGeminiHooks(merged), command)).toBe(false);
    const request = normaliseHook({
      hook_event_name: "BeforeTool",
      tool_name: "run_shell_command",
      tool_input: { command: "ls /tmp" },
      cwd: "/tmp",
    }, "gemini");
    expect(request.kind === "request" && request.request.agent).toBe("gemini");
    expect(request.kind === "request" && request.request.access).toBe("read");
    const rm = normaliseHook({ hook_event_name: "BeforeTool", tool_name: "run_shell_command", tool_input: { command: "rm -rf /tmp/x" }, cwd: "/tmp" }, "gemini");
    expect(rm.kind === "request" && rm.request.access).toBe("write");
    const read = normaliseHook({ tool_name: "read_file", tool_input: { file_path: "/tmp/a.txt" }, cwd: "/tmp" }, "gemini");
    expect(read.kind === "request" && read.request.access).toBe("read");
    expect(JSON.parse(respond("gemini", { kind: "deny", reason: "no" }).stdout)).toEqual({ decision: "deny", reason: "no" });
    expect(respond("gemini", "timeout")).toEqual({ stdout: "", exitCode: 0 });
  });
});

describe("antigravity hooks", () => {
  it("merges an Antigravity PreToolUse hook and responds with allow/deny/ask decisions", () => {
    const command = 'ELECTRON_RUN_AS_NODE=1 "/App" "/leash-hook.js" antigravity';
    const merged = mergeAntigravityHooks({ "lint-checker": { PostToolUse: [] } }, command);
    expect(merged["lint-checker"]).toEqual({ PostToolUse: [] });
    expect(antigravityHooksInstalled(merged, command)).toBe(true);
    const removed = removeAntigravityHooks(merged);
    expect(antigravityHooksInstalled(removed, command)).toBe(false);
    expect(removed["lint-checker"]).toEqual({ PostToolUse: [] });

    const cmdReq = normaliseHook({
      conversationId: "c1",
      workspacePaths: ["/tmp"],
      toolCall: { name: "run_command", args: { CommandLine: "ls /tmp" } },
    }, "antigravity");
    expect(cmdReq.kind === "request" && cmdReq.request.agent).toBe("antigravity");
    expect(cmdReq.kind === "request" && cmdReq.request.access).toBe("read");
    expect(cmdReq.kind === "request" && cmdReq.request.sessionId).toBe("c1");

    const rmReq = normaliseHook({
      workspacePaths: ["/tmp"],
      toolCall: { name: "run_command", args: { CommandLine: "rm -rf /tmp/x" } },
    }, "antigravity");
    expect(rmReq.kind === "request" && rmReq.request.access).toBe("write");

    const readReq = normaliseHook({
      workspacePaths: ["/tmp"],
      toolCall: { name: "read_file", args: { Path: "/tmp/a.txt" } },
    }, "antigravity");
    expect(readReq.kind === "request" && readReq.request.access).toBe("read");
    expect(readReq.kind === "request" && readReq.request.paths).toEqual(["/tmp/a.txt"]);

    const editReq = normaliseHook({
      workspacePaths: ["/tmp"],
      toolCall: { name: "edit_file", args: { Path: "/tmp/a.txt" } },
    }, "antigravity");
    expect(editReq.kind === "request" && editReq.request.access).toBe("write");
    expect(editReq.kind === "request" && editReq.request.paths).toEqual(["/tmp/a.txt"]);

    expect(JSON.parse(respond("antigravity", { kind: "pass" }).stdout)).toEqual({ decision: "allow" });
    expect(JSON.parse(respond("antigravity", { kind: "deny", reason: "no" }).stdout)).toEqual({ decision: "deny", reason: "no" });
    expect(JSON.parse(respond("antigravity", "timeout").stdout)).toEqual({ decision: "ask", reason: "Agentic Leash is not answering" });
  });
});

describe("hermes hooks", () => {
  it("treats a terminal call as a write and blocks on deny", () => {
    const request = normaliseHook({
      hook_event_name: "pre_tool_call",
      tool_name: "terminal",
      tool_input: { command: "ls /tmp" },
      cwd: "/tmp",
      session_id: "s1",
    }, "hermes");
    expect(request.kind === "request" && request.request.agent).toBe("hermes");
    expect(JSON.parse(respond("hermes", { kind: "deny", reason: "no" }).stdout)).toEqual({ decision: "block", reason: "no" });
    expect(JSON.parse(respond("hermes", "timeout").stdout)).toEqual({ action: "approve", message: "Agentic Leash is not answering" });
  });
});

describe("respond", () => {
  it("gives no opinion on pass and denies with a reason", () => {
    expect(respond("claude", { kind: "pass" })).toEqual({ stdout: "", exitCode: 0 });
    expect(JSON.parse(respond("claude", { kind: "deny", reason: "no" }).stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(JSON.parse(respond("cursor", { kind: "pass" }).stdout).permission).toBe("allow");
    expect(JSON.parse(respond("cursor", "timeout").stdout).permission).toBe("allow");
    expect(JSON.parse(respond("claude", "timeout").stdout).hookSpecificOutput.permissionDecision).toBe("ask");
  });
});

describe("handlePayload", () => {
  it("does not ask when lockdown already denies", async () => {
    const db = openGrantsDb(join("/tmp", `al-handle-${Date.now()}.db`));
    db.prepare("INSERT INTO settings (key, value) VALUES ('lockdown', '1')").run();
    let asked = false;
    const result = await handlePayload({
      entry: "cursor",
      raw: fixture("cursor-beforeReadFile.json"),
      db,
      now: Date.now(),
      home: "/tmp",
      ask: async () => {
        asked = true;
        return "allow";
      },
    });
    expect(asked).toBe(false);
    expect(JSON.parse(result.stdout).permission).toBe("deny");
    db.close();
  });
});
