export type AgentId = "claude-code" | "cursor" | "t3-code" | "codex" | "gemini" | "antigravity" | "hermes";
export type Access = "read" | "write";
export type Enforcement = "hook" | "rules" | "monitor-only";
export type ThemeSource = "system" | "light" | "dark";

export interface Grant {
  id: number;
  agent: AgentId | "*";
  path: string;
  access: Access;
  source: "leash" | "config";
  command: string | null;
  createdAt: number;
  expiresAt: number | null;
  /** Set for "This session" grants: only requests from that agent session match. */
  sessionId?: string | null;
  /** Set for grants that stay alive while used and lapse after this many idle seconds. */
  idleSeconds?: number | null;
  lastUsedAt?: number | null;
}

export interface AllowRule {
  id: number;
  kind: "folder" | "command";
  agent: "claude-code" | "cursor" | "codex" | "gemini" | "antigravity" | "hermes" | "*";
  value: string;
  createdAt: number;
}

export interface ScheduledRevoke {
  path: string;
  dueAt: number;
}

export interface HookRequest {
  agent: "claude-code" | "cursor" | "codex" | "gemini" | "antigravity" | "hermes";
  event: string;
  tool: string;
  access: Access;
  paths: string[];
  cwd: string;
  url?: string;
  command?: string;
  sessionId?: string;
  /** This agent session read a secret recently, so network calls ask first. */
  afterSecret?: boolean;
}

export interface GodModeState {
  active: boolean;
  until: number | null;
  agent: AgentId | "*";
}

export type Verdict = { kind: "pass"; grantIds?: number[]; godMode?: boolean } | { kind: "deny"; reason: string } | { kind: "prompt" };

export interface DecideOptions {
  now: number;
  lockdown: boolean;
  protectedRoots: string[];
  home?: string;
  autoAllowOff?: string[];
  rules?: AllowRule[];
  afterSecret?: boolean;
  blocks?: BlockRule[];
  godModeUntil?: number;
  godModeAgent?: string;
}

/** A "Never" choice: this agent is always denied this path (and what's under it) or this exact command. */
export interface BlockRule {
  id: number;
  agent: AgentId | "*";
  kind: "path" | "command";
  value: string;
  createdAt: number;
}

/** A Deny the broker remembers for a while, so the same request isn't asked again. */
export interface RememberedDenial {
  key: string;
  agent: string;
  sessionId: string | null;
  label: string;
  until: number;
}

export interface HistoryEvent {
  ts: number;
  agent: AgentId | "unknown";
  pid: number;
  exe: string;
  kind: "read" | "write" | "create" | "delete" | "rename" | "exec" | "net";
  path: string;
  destPath?: string;
  sha256?: string;
  beforeBlob?: string;
  afterBlob?: string;
  sensitive: boolean;
  source: "eslogger" | "hook" | "net";
}

export interface AgentSnapshot {
  id: AgentId;
  name: string;
  installed: boolean;
  enforcement: Enforcement;
  note?: string;
  folders: { path: string; access: Access; source: string; locked: boolean }[];
  mcpServers: { name: string; url?: string; command?: string; source: string; locked: boolean }[];
  network: { rule: string; effect: "allow" | "deny"; source: string; locked: boolean }[];
  children: AgentId[];
  workers: string[];
  privacy: { service: string; client: string; authValue: number; bundleId: string; via?: string }[];
}

export interface DecisionRow {
  id: number;
  ts: number;
  agent: string;
  tool: string;
  paths: string;
  verdict: string;
  reason: string | null;
  grantId: number | null;
  durationMs: number | null;
  command: string | null;
  url: string | null;
}

export interface HistoryRow {
  id: number;
  ts: number;
  agent: string;
  exe: string;
  kind: string;
  path: string;
  destPath: string | null;
  sensitive: boolean;
  beforeText: string | null;
  afterText: string | null;
}

export interface PendingRequest {
  id: string;
  request: HookRequest;
  askedAt: number;
  policy?: RequestPolicy;
}

export type PresetId = "once" | "15m" | "session" | "1h" | "today" | "8h" | "repo" | "always";
export type RequestClass = "secret" | "startup" | "egress" | "personal" | "project" | "other";
export type RiskLevel = "low" | "medium" | "high";

export interface RequestPolicy {
  kind: RequestClass;
  /** Why the request is in this class, like "SSH keys" or "Documents". */
  label: string | null;
  presets: PresetId[];
  preset: PresetId;
  /** The git repo every path sits in, for "Always in repo". */
  repo: string | null;
  /** Folder chip picked on open, usually the git repo root. */
  scope: string | null;
  /** Grant the exact paths, never their parent folder. */
  exact: boolean;
  risk: RiskLevel;
  summary: string;
  reasons: string[];
}

export interface Diagnostics {
  hooks: { agent: string; label: string; status: "installed" | "missing" | "none" }[];
  helperStatus: string;
  lastSweep: string | null;
  hookP50Ms: number | null;
  hookP95Ms: number | null;
  lastDecision: { ts: number; agent: string; tool: string; verdict: string; reason: string | null } | null;
  errors: string[];
}

export interface RuleSuggestion { key: string; agent: string; path: string | null; command: string | null; access: Access; count: number; lastAt: number }
export interface HistorySummary { from: number; total: number; sensitive: number; blocked: number; agents: { agent: string; reads: number; writes: number; execs: number; net: number; other: number }[] }

export type BuildKind = "dev" | "local" | "release";

export interface AppInfo {
  version: string;
  build: BuildKind;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
}
