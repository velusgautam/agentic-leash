import { CLAUDE_MATCHER, HOOK_TIMEOUT_S } from "../shared/constants";

type CursorHooks = { version?: number; hooks?: Record<string, { command?: string; timeout?: number; failClosed?: boolean }[]> };
type ClaudeHook = { type?: string; command?: string; timeout?: number };
type ClaudeSettings = { hooks?: { PreToolUse?: { matcher?: string; hooks?: ClaudeHook[] }[] } };

const CURSOR_EVENTS = ["preToolUse", "beforeReadFile", "beforeShellExecution", "beforeMCPExecution"];

function isOurs(command: string | undefined, marker: string): boolean {
  return Boolean(command?.includes(marker));
}

export function mergeCursorHooks(existing: unknown, command: string): CursorHooks {
  const file = (existing && typeof existing === "object" ? existing : {}) as CursorHooks;
  const hooks = { ...(file.hooks ?? {}) };
  for (const event of CURSOR_EVENTS) {
    const kept = (hooks[event] ?? []).filter((entry) => !isOurs(entry.command, "leash-hook"));
    hooks[event] = [...kept, { command, timeout: HOOK_TIMEOUT_S, failClosed: true }];
  }
  return { ...file, version: file.version ?? 1, hooks };
}

export function removeCursorHooks(existing: unknown): CursorHooks {
  const file = (existing && typeof existing === "object" ? existing : {}) as CursorHooks;
  const hooks: CursorHooks["hooks"] = {};
  for (const [event, entries] of Object.entries(file.hooks ?? {})) hooks[event] = entries.filter((entry) => !isOurs(entry.command, "leash-hook"));
  return { ...file, hooks };
}

export function mergeClaudeHooks(existing: unknown, command: string): ClaudeSettings {
  const file = (existing && typeof existing === "object" ? existing : {}) as ClaudeSettings;
  const groups = (file.hooks?.PreToolUse ?? []).map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !isOurs(hook.command, "leash-hook")) }));
  const ours = { matcher: CLAUDE_MATCHER, hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_S }] };
  return { ...file, hooks: { ...file.hooks, PreToolUse: [...groups.filter((group) => (group.hooks ?? []).length > 0), ours] } };
}

export function removeClaudeHooks(existing: unknown): ClaudeSettings {
  const file = (existing && typeof existing === "object" ? existing : {}) as ClaudeSettings;
  const groups = (file.hooks?.PreToolUse ?? [])
    .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !isOurs(hook.command, "leash-hook")) }))
    .filter((group) => (group.hooks ?? []).length > 0);
  return { ...file, hooks: { ...file.hooks, PreToolUse: groups } };
}

export function cursorHooksInstalled(file: unknown, command: string): boolean {
  const hooks = ((file ?? {}) as CursorHooks).hooks ?? {};
  return CURSOR_EVENTS.every((event) => (hooks[event] ?? []).some((entry) => entry.command === command && entry.failClosed === true));
}

export function claudeHooksInstalled(file: unknown, command: string): boolean {
  const groups = ((file ?? {}) as ClaudeSettings).hooks?.PreToolUse ?? [];
  return groups.some((group) => (group.hooks ?? []).some((hook) => hook.command === command));
}

type CodexFile = { hooks?: { PreToolUse?: { matcher?: string; hooks?: ClaudeHook[] }[] } };

export function mergeCodexHooks(existing: unknown, command: string): CodexFile {
  const file = (existing && typeof existing === "object" ? existing : {}) as CodexFile;
  const groups = (file.hooks?.PreToolUse ?? []).map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !isOurs(hook.command, "leash-hook")) }));
  const ours = { matcher: ".*", hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_S }] };
  return { ...file, hooks: { ...file.hooks, PreToolUse: [...groups.filter((group) => (group.hooks ?? []).length > 0), ours] } };
}

export function removeCodexHooks(existing: unknown): CodexFile {
  const file = (existing && typeof existing === "object" ? existing : {}) as CodexFile;
  const groups = (file.hooks?.PreToolUse ?? [])
    .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !isOurs(hook.command, "leash-hook")) }))
    .filter((group) => (group.hooks ?? []).length > 0);
  return { ...file, hooks: { ...file.hooks, PreToolUse: groups } };
}

export function codexHooksInstalled(file: unknown, command: string): boolean {
  const groups = ((file ?? {}) as CodexFile).hooks?.PreToolUse ?? [];
  return groups.some((group) => (group.hooks ?? []).some((hook) => hook.command === command));
}

type GeminiHook = { type?: string; name?: string; command?: string; timeout?: number };
type GeminiFile = { hooks?: { BeforeTool?: { matcher?: string; hooks?: GeminiHook[] }[] } } & Record<string, unknown>;

function geminiGroups(file: GeminiFile): { matcher?: string; hooks?: GeminiHook[] }[] {
  return (file.hooks?.BeforeTool ?? []).map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !isOurs(hook.command, "leash-hook")) }));
}

export function mergeGeminiHooks(existing: unknown, command: string): GeminiFile {
  const file = (existing && typeof existing === "object" ? existing : {}) as GeminiFile;
  const ours = { matcher: ".*", hooks: [{ type: "command", name: "agentic-leash", command, timeout: 150000 }] };
  return { ...file, hooks: { ...file.hooks, BeforeTool: [...geminiGroups(file).filter((group) => (group.hooks ?? []).length > 0), ours] } };
}

export function removeGeminiHooks(existing: unknown): GeminiFile {
  const file = (existing && typeof existing === "object" ? existing : {}) as GeminiFile;
  return { ...file, hooks: { ...file.hooks, BeforeTool: geminiGroups(file).filter((group) => (group.hooks ?? []).length > 0) } };
}

export function geminiHooksInstalled(file: unknown, command: string): boolean {
  const groups = ((file ?? {}) as GeminiFile).hooks?.BeforeTool ?? [];
  return groups.some((group) => (group.hooks ?? []).some((hook) => hook.command === command));
}

type AntigravityHookGroup = { matcher?: string; hooks?: { type?: string; command?: string; timeout?: number }[] };
type AntigravityNamedHook = { enabled?: boolean; PreToolUse?: AntigravityHookGroup[] } & Record<string, unknown>;
type AntigravityHooksFile = Record<string, AntigravityNamedHook>;

function stripAntigravityHooks(existing: unknown): AntigravityHooksFile {
  const file = (existing && typeof existing === "object" ? existing : {}) as AntigravityHooksFile;
  const out: AntigravityHooksFile = {};
  for (const [name, entry] of Object.entries(file)) {
    if (!entry || typeof entry !== "object") continue;
    const groups = (entry.PreToolUse ?? [])
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !isOurs(hook.command, "leash-hook")) }))
      .filter((group) => (group.hooks ?? []).length > 0);
    if (name === "agentic-leash" && groups.length === 0 && Object.keys(entry).every((key) => key === "PreToolUse" || key === "enabled")) {
      continue;
    }
    out[name] = Array.isArray(entry.PreToolUse) ? { ...entry, PreToolUse: groups } : { ...entry };
  }
  return out;
}

export function mergeAntigravityHooks(existing: unknown, command: string): AntigravityHooksFile {
  const cleaned = stripAntigravityHooks(existing);
  const prev = cleaned["agentic-leash"];
  const ours: AntigravityHookGroup = { matcher: "*", hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_S }] };
  return {
    ...cleaned,
    "agentic-leash": {
      ...prev,
      ...(prev?.enabled === false ? { enabled: true } : {}),
      PreToolUse: [...(prev?.PreToolUse ?? []), ours],
    },
  };
}

export function removeAntigravityHooks(existing: unknown): AntigravityHooksFile {
  return stripAntigravityHooks(existing);
}

export function antigravityHooksInstalled(file: unknown, command: string): boolean {
  const hooksFile = (file && typeof file === "object" ? file : {}) as AntigravityHooksFile;
  return Object.values(hooksFile).some(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      entry.enabled !== false &&
      (entry.PreToolUse ?? []).some((group) => (group.hooks ?? []).some((hook) => hook.command === command)),
  );
}
