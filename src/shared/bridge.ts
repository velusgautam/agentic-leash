import type { ApprovalStyle } from "./approvalStyle";
import type { AutoAllow } from "./autoAllow";
import type { IgnoredRow } from "./ignored";
import type { Insights } from "./insights";
import type { SetupStatus } from "./setup";
import type { CleanupMode, HistoryStats, StorageWarning } from "./storage";
import type { Access, AgentId, AppInfo, AgentSnapshot, AllowRule, BlockRule, RememberedDenial, DecisionRow, Diagnostics, Grant, HistoryRow, HistorySummary, PendingRequest, PresetId, RuleSuggestion, ScheduledRevoke, ThemeSource } from "./types";
import type { UpdateActionResult, UpdateCheckResult, UpdateState } from "./updater";

export interface ApprovalPrefs {
  /** What locking or sleeping the Mac ends: personal-folder grants, or all timed grants. */
  lockEnds: "personal" | "all";
  endOfDayHour: number;
}

export interface OpenAtLoginState {
  enabled: boolean;
  available: boolean;
}

export interface HistoryStorageInfo {
  stats: HistoryStats | null;
  files: { label: string; path: string; bytes: number }[];
  freeBytes: number;
  requiredBytes: number;
}

export interface HistoryCleanupResult {
  beforeBytes: number;
  afterBytes: number;
  deleted: number | null;
}

export interface LeashBridge {
  platform: string;
  appInfo(): Promise<AppInfo>;
  getOpenAtLogin(): Promise<OpenAtLoginState>;
  setOpenAtLogin(enabled: boolean): Promise<OpenAtLoginState>;
  listAgents(): Promise<AgentSnapshot[]>;
  listGrants(): Promise<Grant[]>;
  revokeGrant(id: number): Promise<void>;
  revokeAll(): Promise<{ revoked: number }>;
  extendGrant(id: number, seconds: number): Promise<{ expiresAt: number | null }>;
  getApprovalStyle(): Promise<ApprovalStyle>;
  setApprovalStyle(style: ApprovalStyle): Promise<void>;
  listSuggestions(): Promise<RuleSuggestion[]>;
  acceptSuggestion(key: string): Promise<void>;
  dismissSuggestion(key: string): Promise<void>;
  restoreWrite(id: number): Promise<{ ok: true } | { ok: false; reason: string }>;
  historySummary(from: number): Promise<HistorySummary>;
  grantStatus(): Promise<{ count: number; lockdown: boolean }>;
  createGrant(input: { agent: AgentId | "*"; path: string; access: Access; ttlSeconds: number | null }): Promise<void>;
  listAutoAllows(): Promise<(AutoAllow & { enabled: boolean })[]>;
  setAutoAllow(id: string, enabled: boolean): Promise<(AutoAllow & { enabled: boolean })[]>;
  listRules(): Promise<AllowRule[]>;
  createRule(input: { kind: AllowRule["kind"]; agent: AllowRule["agent"]; value: string }): Promise<{ rules: AllowRule[]; error: string | null }>;
  updateRule(id: number, input: { kind: AllowRule["kind"]; agent: AllowRule["agent"]; value: string }): Promise<{ rules: AllowRule[]; error: string | null }>;
  deleteRule(id: number): Promise<AllowRule[]>;
  unlock(): Promise<void>;
  listDecisions(): Promise<DecisionRow[]>;
  insights(days: number): Promise<Insights>;
  listHistory(): Promise<HistoryRow[]>;
  queryHistory(filter: { from: number | null; to: number | null; agents: string[]; path: string; kind: string; sensitive: boolean; includeNoise?: boolean; offset: number; limit: number }): Promise<{ rows: HistoryRow[]; total: number }>;
  historyRetention(): Promise<{ main: number; noise: number }>;
  setHistoryRetention(which: "main" | "noise", days: number): Promise<{ main: number; noise: number }>;
  historyCap(): Promise<{ gb: number }>;
  setHistoryCap(gb: number): Promise<{ gb: number }>;
  historyStorage(): Promise<HistoryStorageInfo>;
  purgeHistory(mode: CleanupMode, days?: number): Promise<HistoryCleanupResult>;
  storageWarning(): Promise<{ warning: StorageWarning | null; capBytes: number }>;
  dismissStorageWarning(step: number): Promise<void>;
  listIgnored(): Promise<IgnoredRow[]>;
  setIgnored(id: number, enabled: boolean): Promise<IgnoredRow[]>;
  addIgnored(prefix: string): Promise<{ rows: IgnoredRow[]; added: boolean }>;
  deleteIgnored(id: number): Promise<IgnoredRow[]>;
  historyText(id: number): Promise<{ before: string | null; after: string | null }>;
  listPending(): Promise<PendingRequest[]>;
  /** `presetId` wins over `ttlSeconds`; the main process clamps it to what the request allows. */
  decidePending(id: string, decision: "allow" | "deny" | "never", ttlSeconds: number | null, scopePath?: string, presetId?: PresetId): Promise<void>;
  /** Removes the remembered denial and any Never rules made when answering `id`. */
  undoDeny(id: string): Promise<boolean>;
  listBlocks(): Promise<{ remembered: RememberedDenial[]; never: BlockRule[] }>;
  forgetDenial(key: string): Promise<void>;
  forgetAllDenials(): Promise<void>;
  deleteNever(id: number): Promise<void>;
  /** Drops denials and Never rules matching a decision log row, so the next try asks again. */
  releaseDecision(id: number): Promise<number>;
  approvalPrefs(): Promise<ApprovalPrefs>;
  setApprovalPrefs(input: Partial<ApprovalPrefs>): Promise<ApprovalPrefs>;
  closeApproval(): Promise<void>;
  restartNeeded(): Promise<{ name: string; kind: "gui" | "cli"; count: number }[]>;
  restartAgents(): Promise<void>;
  dismissRestart(): Promise<void>;
  hooksInstalled(): Promise<boolean>;
  installHooks(agent: "claude-code" | "cursor" | "codex" | "gemini" | "antigravity" | "hermes"): Promise<void>;
  uninstallHooks(agent: "claude-code" | "cursor" | "codex" | "gemini" | "antigravity" | "hermes"): Promise<void>;
  setup(): Promise<SetupStatus>;
  setAgentEnabled(id: AgentId, enabled: boolean): Promise<void>;
  diagnostics(): Promise<Diagnostics>;
  getTheme(): Promise<ThemeSource>;
  setTheme(theme: ThemeSource): Promise<ThemeSource>;
  setGlass(glass: number): Promise<void>;
  onTheme(listener: (theme: ThemeSource) => void): () => void;
  onHistory(listener: (rows: HistoryRow[]) => void): () => void;
  onPending(listener: (pending: PendingRequest[]) => void): () => void;
  onAgents(listener: () => void): () => void;
  onStorage(listener: () => void): () => void;
  onGrantStatus(listener: (status: { count: number; lockdown: boolean }) => void): () => void;
  resetTcc(service: string, bundleId: string): Promise<void>;
  removeMcp(agent: AgentId, name: string): Promise<void>;
  scheduledRevokes(): Promise<ScheduledRevoke[]>;
  revokeTrust(path: string): Promise<void>;
  scheduleTrust(path: string, dueAt: number): Promise<void>;
  cancelTrust(path: string): Promise<void>;
  onboardingDone(): Promise<boolean>;
  setOnboarding(done: boolean): Promise<void>;
  installHelper(): Promise<void>;
  uninstallApp(): Promise<void>;
  takeNav(): Promise<string | null>;
  onNavigate(listener: () => void): () => void;
  fullDiskAccess(): Promise<boolean>;
  openFullDiskAccess(): Promise<void>;
  getUpdateState(): Promise<UpdateState>;
  checkForUpdates(): Promise<UpdateCheckResult>;
  downloadUpdate(): Promise<UpdateActionResult>;
  installUpdate(): Promise<UpdateActionResult>;
  onUpdateState(listener: (state: UpdateState) => void): () => void;
  openExternal(url: string): Promise<void>;
}
