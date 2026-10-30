import { homedir } from "node:os";
import { join } from "node:path";

const START = "# agentic-leash:start";
const END = "# agentic-leash:end";

export function hermesScript(execPath: string, scriptPath: string): string {
  return `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${JSON.stringify(execPath)} ${JSON.stringify(scriptPath)} hermes\n`;
}

export function hermesCmd(execPath: string, scriptPath: string): string {
  return `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${execPath}" "${scriptPath}" hermes\r\n`;
}

export function hermesHookScript(home = homedir(), platform = process.platform): string {
  const ext = platform === "win32" ? ".cmd" : ".sh";
  return join(home, ".hermes", "agent-hooks", `agentic-leash${ext}`);
}

function block(scriptPath: string): string {
  return [
    START,
    "hooks:",
    "  pre_tool_call:",
    "    - matcher: \".*\"",
    `      command: ${JSON.stringify(scriptPath)}`,
    "      timeout: 150",
    "      fail_closed: true",
    END,
  ].join("\n");
}

export function mergeHermesConfig(text: string, scriptPath: string): string {
  const next = block(scriptPath);
  if (text.includes(START)) return text.replace(/# agentic-leash:start[\s\S]*?# agentic-leash:end/, next);
  if (/^hooks:/m.test(text)) throw new Error("Hermes config already has a hooks block. Remove it, or add the Agentic Leash command under hooks.pre_tool_call, then install again.");
  return `${text.trimEnd()}\n\n${next}\n`;
}

export function removeHermesConfig(text: string): string {
  return text.replace(/\n*# agentic-leash:start[\s\S]*?# agentic-leash:end\n?/, "\n").trimEnd() + "\n";
}

export function hermesHooksInstalled(text: string, scriptPath: string): boolean {
  return text.includes(START) && text.includes(scriptPath);
}
