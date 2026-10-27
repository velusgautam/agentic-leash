import { contextBridge, ipcRenderer } from "electron";
import type { LeashBridge } from "../shared/bridge";
import type { HistoryRow, PendingRequest, ThemeSource } from "../shared/types";
import type { UpdateState } from "../shared/updater";

const leash: LeashBridge = {
  platform: process.platform,
  appInfo: () => ipcRenderer.invoke("app:info"),
  getOpenAtLogin: () => ipcRenderer.invoke("login-item:get"),
  setOpenAtLogin: (enabled) => ipcRenderer.invoke("login-item:set", enabled),
  listAgents: () => ipcRenderer.invoke("agents:list"),
  listGrants: () => ipcRenderer.invoke("grants:list"),
  revokeGrant: (id) => ipcRenderer.invoke("grants:revoke", id),
  revokeAll: () => ipcRenderer.invoke("grants:revoke-all"),
  extendGrant: (id, seconds) => ipcRenderer.invoke("grants:extend", id, seconds),
  getApprovalStyle: () => ipcRenderer.invoke("approval-style:get"),
  setApprovalStyle: (style) => ipcRenderer.invoke("approval-style:set", style),
  listSuggestions: () => ipcRenderer.invoke("suggestions:list"),
  acceptSuggestion: (key) => ipcRenderer.invoke("suggestions:accept", key),
  dismissSuggestion: (key) => ipcRenderer.invoke("suggestions:dismiss", key),
  restoreWrite: (id) => ipcRenderer.invoke("history:restore", id),
  historySummary: (from) => ipcRenderer.invoke("history:summary", from),
  grantStatus: () => ipcRenderer.invoke("grants:status"),
  createGrant: (input) => ipcRenderer.invoke("grants:create", input),
  listAutoAllows: () => ipcRenderer.invoke("auto-allow:list"),
  setAutoAllow: (id, enabled) => ipcRenderer.invoke("auto-allow:set", id, enabled),
  listRules: () => ipcRenderer.invoke("rules:list"),
  createRule: (input) => ipcRenderer.invoke("rules:create", input),
  updateRule: (id, input) => ipcRenderer.invoke("rules:update", id, input),
  deleteRule: (id) => ipcRenderer.invoke("rules:delete", id),
  unlock: () => ipcRenderer.invoke("grants:unlock"),
  listDecisions: () => ipcRenderer.invoke("decisions:list"),
  insights: (days) => ipcRenderer.invoke("insights:get", days),
  listHistory: () => ipcRenderer.invoke("history:list"),
  queryHistory: (filter) => ipcRenderer.invoke("history:query", filter),
  historyRetention: () => ipcRenderer.invoke("history:retention:get"),
  setHistoryRetention: (which, days) => ipcRenderer.invoke("history:retention:set", which, days),
  historyCap: () => ipcRenderer.invoke("history:cap:get"),
  setHistoryCap: (gb) => ipcRenderer.invoke("history:cap:set", gb),
  historyStorage: () => ipcRenderer.invoke("history:storage:info"),
  purgeHistory: (mode, days) => ipcRenderer.invoke("history:purge:run", mode, days),
  storageWarning: () => ipcRenderer.invoke("history:warning:get"),
  dismissStorageWarning: (step) => ipcRenderer.invoke("history:warning:dismiss", step),
  listIgnored: () => ipcRenderer.invoke("ignored:list"),
  setIgnored: (id, enabled) => ipcRenderer.invoke("ignored:set", id, enabled),
  addIgnored: (prefix) => ipcRenderer.invoke("ignored:add", prefix),
  updateIgnored: (id, prefix) => ipcRenderer.invoke("ignored:update", id, prefix),
  deleteIgnored: (id) => ipcRenderer.invoke("ignored:delete", id),
  historyText: (id) => ipcRenderer.invoke("history:text", id),
  listPending: () => ipcRenderer.invoke("approval:list"),
  decidePending: (id, decision, ttlSeconds, scopePath, presetId) => ipcRenderer.invoke("approval:decide", id, decision, ttlSeconds, scopePath, presetId),
  undoDeny: (id) => ipcRenderer.invoke("approval:undo-deny", id),
  listBlocks: () => ipcRenderer.invoke("blocks:list"),
  forgetDenial: (key) => ipcRenderer.invoke("blocks:forget", key),
  forgetAllDenials: () => ipcRenderer.invoke("blocks:forget-all"),
  deleteNever: (id) => ipcRenderer.invoke("blocks:delete-never", id),
  releaseDecision: (id) => ipcRenderer.invoke("blocks:release-decision", id),
  approvalPrefs: () => ipcRenderer.invoke("approval-prefs:get"),
  setApprovalPrefs: (input) => ipcRenderer.invoke("approval-prefs:set", input),
  closeApproval: () => ipcRenderer.invoke("approval:close"),
  restartNeeded: () => ipcRenderer.invoke("runtime:restart-needed"),
  restartAgents: () => ipcRenderer.invoke("runtime:restart"),
  dismissRestart: () => ipcRenderer.invoke("runtime:dismiss-restart"),
  hooksInstalled: () => ipcRenderer.invoke("hooks:status"),
  installHooks: (agent) => ipcRenderer.invoke("hooks:install", agent),
  uninstallHooks: (agent) => ipcRenderer.invoke("hooks:uninstall", agent),
  setup: () => ipcRenderer.invoke("setup:get"),
  setAgentEnabled: (id, enabled) => ipcRenderer.invoke("agents:enabled", id, enabled),
  diagnostics: () => ipcRenderer.invoke("diagnostics:get"),
  getTheme: () => ipcRenderer.invoke("theme:get"),
  setTheme: (theme) => ipcRenderer.invoke("theme:set", theme),
  setGlass: (glass) => ipcRenderer.invoke("appearance:glass", glass),
  onTheme: (listener) => {
    const wrapped = (_event: unknown, theme: ThemeSource) => listener(theme);
    ipcRenderer.on("theme:changed", wrapped);
    return () => ipcRenderer.removeListener("theme:changed", wrapped);
  },
  onHistory: (listener) => {
    const wrapped = (_event: unknown, rows: HistoryRow[]) => listener(rows);
    ipcRenderer.on("history:changed", wrapped);
    return () => ipcRenderer.removeListener("history:changed", wrapped);
  },
  onPending: (listener) => {
    const wrapped = (_event: unknown, pending: PendingRequest[]) => listener(pending);
    ipcRenderer.on("pending:changed", wrapped);
    return () => ipcRenderer.removeListener("pending:changed", wrapped);
  },
  onAgents: (listener) => {
    const wrapped = () => listener();
    ipcRenderer.on("agents:changed", wrapped);
    return () => ipcRenderer.removeListener("agents:changed", wrapped);
  },
  onStorage: (listener) => {
    const wrapped = () => listener();
    ipcRenderer.on("storage:changed", wrapped);
    return () => ipcRenderer.removeListener("storage:changed", wrapped);
  },
  onGrantStatus: (listener) => {
    const wrapped = (_event: unknown, status: { count: number; lockdown: boolean }) => listener(status);
    ipcRenderer.on("grants:status-changed", wrapped);
    return () => ipcRenderer.removeListener("grants:status-changed", wrapped);
  },
  resetTcc: (service, bundleId) => ipcRenderer.invoke("tcc:reset", service, bundleId),
  removeMcp: (agent, name) => ipcRenderer.invoke("agents:remove-mcp", agent, name),
  scheduledRevokes: () => ipcRenderer.invoke("trust:scheduled"),
  revokeTrust: (path) => ipcRenderer.invoke("trust:revoke", path),
  scheduleTrust: (path, dueAt) => ipcRenderer.invoke("trust:schedule", path, dueAt),
  cancelTrust: (path) => ipcRenderer.invoke("trust:cancel", path),
  onboardingDone: () => ipcRenderer.invoke("onboarding:get"),
  setOnboarding: (done) => ipcRenderer.invoke("onboarding:set", done),
  installHelper: () => ipcRenderer.invoke("helper:install"),
  restartHelper: () => ipcRenderer.invoke("helper:restart"),
  uninstallApp: () => ipcRenderer.invoke("app:uninstall"),
  takeNav: () => ipcRenderer.invoke("nav:take"),
  onNavigate: (listener) => {
    const wrapped = () => listener();
    ipcRenderer.on("nav:open", wrapped);
    return () => ipcRenderer.removeListener("nav:open", wrapped);
  },
  fullDiskAccess: () => ipcRenderer.invoke("fda:status"),
  openFullDiskAccess: () => ipcRenderer.invoke("fda:open"),
  getUpdateState: () => ipcRenderer.invoke("update:get"),
  checkForUpdates: () => ipcRenderer.invoke("update:check"),
  downloadUpdate: () => ipcRenderer.invoke("update:download"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  onUpdateState: (listener) => {
    const wrapped = (_event: unknown, state: UpdateState) => listener(state);
    ipcRenderer.on("update:state", wrapped);
    return () => ipcRenderer.removeListener("update:state", wrapped);
  },
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
};

contextBridge.exposeInMainWorld("leash", leash);
