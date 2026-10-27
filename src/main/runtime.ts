import { execFile } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statfsSync, statSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { app, BrowserWindow, globalShortcut, ipcMain, nativeTheme } from "electron";
import { DEFAULT_TTL_S, grantsDbPath, HISTORY_DIR, homeDir, isClaudeBinary, IS_MAC, leashDir, POPUP_TIMEOUT_S, protectedRoots, socketPath, TCC_CLIENTS } from "../shared/constants";
import { diagnosticsReport } from "../shared/diagnostics";
import { addBlock, cancelScheduled, collapseGrantDupes, createRule, deleteBlocks, listBlocks, decisionDurations, decisionsSince, deleteGrant, deleteGrants, deleteRule, extendGrant, countBlocked, getSetting, listApprovals, listDecisions, listGrants, listRules, listScheduled, openGrantsDb, recordApproval, scheduleRevoke, setSetting, updateRule, upsertCommandGrant, upsertGrant } from "../shared/db";
import { historyEvent, historyStorageBytes, historyText, listHistory, openHistoryDb, optimizeHistory, queryHistory, readHistoryStats, summarizeHistory, type HistoryFilter } from "../helper/historyDb";
import { purgeCommand } from "../helper/leash-helper";
import { checkRestore } from "../shared/restore";
import { parseApprovalStyle, type ApprovalStyle } from "../shared/approvalStyle";
import { suggestRules, SUGGEST_WINDOW_MS } from "../shared/suggestions";
import type { Access, AgentId, AgentSnapshot, HistoryRow, PendingRequest, PresetId, ThemeSource } from "../shared/types";
import { loadClaude } from "./agents/claude";
import { cursorWatchPaths, cursorWorkers, loadCursor } from "./agents/cursor";
import { mirrorConfigGrants } from "./agents/mirror";
import { antigravityPresent, loadAntigravity, loadCodex, loadGemini, loadHermes, loadT3 } from "./agents/others";
import { Broker } from "./broker";
import type { TrayStatus } from "./menus";
import { antigravityHooksInstalled, claudeHooksInstalled, codexHooksInstalled, cursorHooksInstalled, geminiHooksInstalled, mergeAntigravityHooks, mergeClaudeHooks, mergeCodexHooks, mergeCursorHooks, mergeGeminiHooks, removeAntigravityHooks, removeClaudeHooks, removeCodexHooks, removeCursorHooks, removeGeminiHooks } from "./hookInstall";
import { readJson } from "./agents/fs";
import { hermesHooksInstalled, hermesScript, mergeHermesConfig, removeHermesConfig } from "./hermesHooks";
import { writeWithBackup } from "./backup";
import { applyDueClaudeTrust, revokeClaudeTrust } from "./claudeTrust";
import { revokeStoredGrant } from "./revokeConfig";
import { AUTO_ALLOWS, parseAutoAllowOff } from "../shared/autoAllow";
import { addIgnored, deleteIgnored, listIgnored, setIgnoredEnabled, updateIgnored } from "../shared/ignored";
import { MAIN_RETENTION_DAYS, NOISE_RETENTION_DAYS, parseRetentionDays, retentionDays } from "../shared/retention";
import { CAP_DEFAULT_GB, CLEANUP_MODES, parseCapGb, rearmDismissed, storageWarning, type CleanupMode, type HistoryStats } from "../shared/storage";
import type { HistoryCleanupResult } from "../shared/bridge";
import { coveredPending } from "../hook/decide";
import { clampPreset, guardedKind, isPresetId, presetById, presetFromSeconds, requestPolicy, todayExpiry } from "../shared/policy";
import { END_OF_DAY_HOUR } from "../shared/presets";
import { buildInsights } from "../shared/insights";
import { grantRoot, parentFolders } from "../shared/parents";
import { helperInstallScript, helperMaintenanceScript, helperUninstallScript, installSweepAgent, isHelperRestartNeeded, parseLaunchdPid, readHelperMeta, sweepServiceTarget } from "./helperInstall";
import { LOGIN_AGENT_LABEL } from "./loginItem";
import { publishClaudeRules } from "./rulesMode";
import { guiQuitScript, parsePs, percentiles, restartTargets } from "./system";
import { readUiState, writeUiState } from "./uiState";
import { removeLeftovers, uninstallLeftovers } from "./uninstall";
import { FULL_DISK_URL, hasFullDiskAccess } from "./fullDisk";
import { macAppPresent, rememberOnboarding, setupReady, type HelperState, type SetupAgent, type SetupStatus } from "../shared/setup";
import { readTcc } from "./tcc";
import { historySig } from "../shared/historySig";
import { hasUnresolved, isUnder, secretLabel } from "../shared/paths";
import { personalKind, startupKind } from "../shared/sensitive";

const exec = promisify(execFile);
const SENSITIVE_NOTIFY_MS = 10 * 60 * 1000;
const UNDO_MS = 6000;
const MANUAL_GUARDED_MAX_S = 15 * 60;
const pendingRestart = new Set<AgentId>();

function claudeRoot(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homeDir(), ".claude");
}

type HookAgent = "claude-code" | "cursor" | "codex" | "gemini" | "antigravity" | "hermes";

function hookPath(agent: HookAgent, home: string): string {
  if (agent === "cursor") return join(home, ".cursor/hooks.json");
  if (agent === "codex") return join(home, ".codex/hooks.json");
  if (agent === "gemini") return join(home, ".gemini/settings.json");
  if (agent === "antigravity") return join(home, ".gemini/config/hooks.json");
  return join(claudeRoot(), "settings.json");
}

function writeHookFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeWithBackup(path, `${JSON.stringify(value, null, 2)}\n`);
}

function hookScript(): string {
  return app.isPackaged ? join(process.resourcesPath, "app.asar.unpacked/out/main/leash-hook.js") : join(app.getAppPath(), "out/main/leash-hook.js");
}

function hookCommand(kind: "claude" | "cursor" | "codex" | "gemini" | "antigravity"): string {
  return `ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${hookScript()}" ${kind}`;
}

async function ensureSweepAgent(): Promise<void> {
  const script = hookScript();
  if (!IS_MAC || !existsSync(script)) return;
  const plist = installSweepAgent(process.execPath, script);
  const uid = process.getuid?.();
  if (uid === undefined) return;
  await exec("/bin/launchctl", ["bootout", sweepServiceTarget(uid)]).catch(() => undefined);
  await exec("/bin/launchctl", ["bootstrap", `gui/${uid}`, plist]).catch(() => undefined);
}

async function psText(): Promise<string> {
  if (process.platform === "win32") return "";
  try {
    return (await exec("ps", ["-axo", "pid,ppid,args"])).stdout;
  } catch {
    return "";
  }
}

function pathBytes(path: string): number {
  try {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return 0;
    return stat.isDirectory() ? readdirSync(path).reduce((total, name) => total + pathBytes(join(path, name)), 0) : stat.size;
  } catch {
    return 0;
  }
}

async function psLines(): Promise<string[]> {
  return (await psText()).split("\n");
}

const cursorStateDb = () => join(app.getPath("appData"), "Cursor/User/globalStorage/state.vscdb");

const broadcast = (channel: string, payload?: unknown) => {
  for (const window of BrowserWindow.getAllWindows()) if (!window.webContents.isDestroyed()) window.webContents.send(channel, payload);
};

export function startRuntime(options: { userData: string; openApproval: () => void; closeApproval: () => void; setPending: (count: number) => void; notify: (title: string, body: string) => void; finishUninstall: () => void; disableLoginItem: () => void; onStatus?: (status: { count: number; lockdown: boolean }) => void; onAlert?: () => void; notifyPending?: (item: PendingRequest, decide: (decision: "allow" | "deny") => void) => (() => void) | void }): { revokeAll: () => { revoked: number }; unlock: () => void; onLock: () => void; trayStatus: () => TrayStatus; endGrant: (id: number) => void; endTemporary: (agent?: string) => void } {
  const db = openGrantsDb(grantsDbPath());
  collapseGrantDupes(db);
  const home = homeDir();
  const historyPath = join(process.env.AGENTIC_LEASH_HISTORY_DIR || HISTORY_DIR, "history.db");
  const checkHelperUpdate = async (): Promise<void> => {
    if (!IS_MAC) return;
    const scriptPath = hookScript().replace("leash-hook.js", "leash-helper.js");
    if (!existsSync(scriptPath)) return;
    const scriptMtime = statSync(scriptPath).mtimeMs;
    const meta = readHelperMeta(historyPath);

    let runningPid: number | null = null;
    try {
      const { stdout } = await exec("/bin/launchctl", ["print", "system/com.agenticleash.helper"]);
      if (stdout.includes("state = running")) {
        runningPid = parseLaunchdPid(stdout);
      }
    } catch {
      /* not running */
    }

    let pidStartedAt: number | null = null;
    if (runningPid !== null && (meta.pid !== runningPid || meta.startedAt === null)) {
      try {
        const { stdout } = await exec("/bin/ps", ["-p", runningPid.toString(), "-o", "lstart="]);
        const parsed = Date.parse(stdout.trim());
        if (Number.isFinite(parsed)) pidStartedAt = parsed;
      } catch {
        /* ps error */
      }
    }

    if (isHelperRestartNeeded({ scriptMtime, meta, runningPid, pidStartedAt })) {
      const now = Date.now();
      const last = Number(getSetting(db, "helper_restart_requested", "0"));
      if (now - last > 5000) {
        setSetting(db, "helper_restart_requested", now.toString());
      }
    }
  };
  void checkHelperUpdate();
  let snapshots: AgentSnapshot[] = [];
  let history: HistoryRow[] = [];
  let historySeen = readUiState(options.userData).historySeen ?? 0;
  let historyPaused = false;
  let uninstalling = false;
  const timeouts = new Map<string, NodeJS.Timeout>();

  // The nearest folder holding `.git`, never the home folder or `/`. Cached for the run; repos rarely move.
  const repoRoots = new Map<string, string | null>();
  const repoRoot = (path: string): string | null => {
    const start = statSync(path, { throwIfNoEntry: false })?.isDirectory() ? path : dirname(path);
    const seen: string[] = [];
    let found: string | null = null;
    for (let dir = start; dir !== home && dir !== dirname(dir); dir = dirname(dir)) {
      const cached = repoRoots.get(dir);
      if (cached !== undefined) {
        found = cached;
        break;
      }
      seen.push(dir);
      if (existsSync(join(dir, ".git"))) {
        found = dir;
        break;
      }
    }
    for (const dir of seen) repoRoots.set(dir, found);
    return found;
  };
  const withPolicy = (item: PendingRequest): PendingRequest => ({ ...item, policy: requestPolicy(item.request, home, repoRoot) });
  const pendingView = () => broker.list().map(withPolicy);

  const notified = new Map<string, (() => void) | void>();
  const broker = new Broker((raw) => {
    const pending = raw.map(withPolicy);
    options.setPending(pending.length);
    broadcast("pending:changed", pending);
    const style = parseApprovalStyle(getSetting(db, "approval_style", "popup"));
    // Quiet mode still opens the popup for anything high risk.
    const quietly = (item: PendingRequest) => style === "notification" || (style === "quiet" && item.policy?.risk !== "high");
    // After a Deny the popup stays up briefly so Undo is reachable.
    if (!pending.length) {
      const wait = lastDenyAt + UNDO_MS - Date.now();
      if (wait > 0) setTimeout(() => broker.list().length || options.closeApproval(), wait);
      else options.closeApproval();
    }
    else if (pending.some((item) => !quietly(item))) options.openApproval();
    for (const [id, timer] of timeouts) {
      if (pending.some((item) => item.id === id)) continue;
      clearTimeout(timer);
      timeouts.delete(id);
    }
    for (const item of pending) {
      if (timeouts.has(item.id)) continue;
      timeouts.set(item.id, setTimeout(() => broker.decide(item.id, { decision: "timeout" }), POPUP_TIMEOUT_S * 1000));
    }
    for (const [id, cleanup] of notified) {
      if (pending.some((item) => item.id === id)) continue;
      notified.delete(id);
      cleanup?.();
    }
    for (const item of pending) {
      if (notified.has(item.id)) continue;
      if (!quietly(item)) {
        notified.set(item.id, undefined);
        continue;
      }
      notified.set(item.id, options.notifyPending?.(item, (decision) => decideApproval(item.id, decision, null, undefined, item.policy?.preset ?? "once")));
    }
  });
  try {
    broker.listen(socketPath());
  } catch {
    /* socket stays down; hooks fall back */
  }

  const scan = async () => {
    if (uninstalling) return;
    repoRoots.clear();
    const workers = cursorWorkers(await psLines());
    snapshots = [
      loadClaude(claudeRoot(), join(home, ".claude.json")),
      loadCursor(join(home, ".cursor"), cursorStateDb(), workers),
      loadT3(join(home, ".t3/userdata/settings.json")),
      loadCodex(join(home, ".codex/config.toml")),
      loadGemini(join(home, ".gemini")),
      loadAntigravity(join(home, ".gemini")),
      loadHermes(join(home, ".hermes")),
    ];
    for (const [id, appName] of [["claude-code", "Claude"], ["cursor", "Cursor"], ["antigravity", "Antigravity"]] as const) {
      const snapshot = snapshots.find((item) => item.id === id);
      if (snapshot && macAppPresent(appName, home, existsSync)) snapshot.installed = true;
    }
    const privacy = IS_MAC ? readTcc(join(homedir(), "Library/Application Support/com.apple.TCC/TCC.db")) : [];
    for (const snapshot of snapshots) {
      const bundles = new Set(TCC_CLIENTS.filter((client) => client.agent === snapshot.id).map((client) => client.bundleId));
      snapshot.privacy = privacy.filter((row) => bundles.has(row.bundleId) || (snapshot.id === "claude-code" && isClaudeBinary(row.client)));
    }
    mirrorConfigGrants(db, snapshots, home, Date.now());
    const claude = snapshots.find((snapshot) => snapshot.id === "claude-code");
    publishClaudeRules(db, join(claudeRoot(), "settings.json"), home, claude?.enforcement === "rules");
    broadcast("agents:changed");
  };

  const claudeJson = () => join(home, ".claude.json");
  void scan().catch((error) => console.error(error));

  let timer: NodeJS.Timeout | null = null;
  const rescan = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void scan().catch((error) => console.error(error)), 300);
  };
  for (const path of [claudeRoot(), join(home, ".claude.json"), ...cursorWatchPaths(join(home, ".cursor"), cursorStateDb()), join(home, ".t3/userdata/settings.json")]) {
    try {
      watch(path, rescan);
    } catch {
      /* missing config files are normal */
    }
  }
  setInterval(() => {
    if (applyDueClaudeTrust(db, claudeJson(), Date.now()).length) rescan();
  }, 30_000);

  let lastStatsSig = "";
  const notifiedPaths = new Map<string, number>();
  let lastAlert: TrayStatus["alert"] = null;
  const pollHistory = () => {
    if (uninstalling || historyPaused) return;
    try {
      const historyDb = openHistoryDb(historyPath, true);
      const rows = listHistory(historyDb, 0, 300);
      const stats = readHistoryStats(historyDb);
      historyDb.close();
      const changed = historySig(rows) !== historySig(history);
      history = rows;
      if (changed) broadcast("history:changed", rows);
      const statsSig = stats ? JSON.stringify([stats.usedBytes, stats.capBytes, stats.hardCap, stats.prunedAt, stats.prunedRows]) : "";
      if (statsSig !== lastStatsSig) {
        lastStatsSig = statsSig;
        broadcast("storage:changed");
      }
      const now = Date.now();
      for (const row of rows) {
        if (!row.sensitive || row.id <= historySeen) continue;
        if (!lastAlert || row.ts > lastAlert.ts) {
          lastAlert = { agent: row.agent, path: row.path, verb: row.kind === "read" ? "read" : "changed", ts: row.ts };
          options.onAlert?.();
        }
        // npm reading ~/.npmrc on every run should not ping every time.
        const key = `${row.agent}\0${row.path}`;
        if ((notifiedPaths.get(key) ?? 0) > now - SENSITIVE_NOTIFY_MS) continue;
        notifiedPaths.set(key, now);
        const label = secretLabel(row.path, home) ?? startupKind(row.path, home) ?? "Sensitive path";
        options.notify(label, `${row.agent} ${row.kind === "read" ? "read" : "changed"} ${row.path}`);
      }
      const max = rows.reduce((id, row) => Math.max(id, row.id), historySeen);
      if (max !== historySeen) {
        historySeen = max;
        writeUiState(options.userData, { ...readUiState(options.userData), historySeen });
      }
    } catch {
      if (history.length) broadcast("history:changed", []);
      history = [];
    }
  };
  pollHistory();
  setInterval(pollHistory, 500);

  const allow = (paths: string[], agent: AgentId | "*", access: Access, ttlSeconds: number | null, exact = false, session?: { sessionId: string | null }) => {
    const expiresAt = ttlSeconds === null ? null : Date.now() + ttlSeconds * 1000;
    const roots: string[] = [];
    for (const path of paths.filter((item) => !hasUnresolved([item]))) {
      const root = grantRoot(path, exact, (item) => statSync(item, { throwIfNoEntry: false })?.isDirectory() ?? false);
      if (root) {
        upsertGrant(db, { agent, path: root, access, source: "leash", createdAt: Date.now(), expiresAt, sessionId: session?.sessionId ?? null, idleSeconds: session ? ttlSeconds : null });
        roots.push(root);
      }
    }
    const claude = snapshots.find((snapshot) => snapshot.id === "claude-code");
    publishClaudeRules(db, join(claudeRoot(), "settings.json"), home, claude?.enforcement === "rules");
    return roots;
  };

  const withHistory = <T,>(read: (historyDb: ReturnType<typeof openHistoryDb>) => T): T => {
    if (historyPaused) throw new Error("History is being optimized.");
    const historyDb = openHistoryDb(historyPath, true);
    try {
      return read(historyDb);
    } finally {
      historyDb.close();
    }
  };
  const grantStatus = () => ({ count: listGrants(db).length, lockdown: getSetting(db, "lockdown", "0") === "1" });
  const publishStatus = () => {
    const status = grantStatus();
    broadcast("grants:status-changed", status);
    options.onStatus?.(status);
  };
  const revokeAll = () => {
    const grants = listGrants(db);
    for (const grant of grants) revokeStoredGrant(home, grant);
    deleteGrants(db, "source = ? OR source = ?", "leash", "config");
    setSetting(db, "lockdown", "1");
    publishClaudeRules(db, join(claudeRoot(), "settings.json"), home, snapshots.find((snapshot) => snapshot.id === "claude-code")?.enforcement === "rules");
    rescan();
    publishStatus();
    return { revoked: grants.length };
  };
  const unlock = () => {
    setSetting(db, "lockdown", "0");
    publishClaudeRules(db, join(claudeRoot(), "settings.json"), home, snapshots.find((snapshot) => snapshot.id === "claude-code")?.enforcement === "rules");
    publishStatus();
  };

  ipcMain.handle("agents:list", () => snapshots);
  ipcMain.handle("grants:list", () => listGrants(db));
  ipcMain.handle("grants:status", () => grantStatus());
  const endGrant = (id: number) => {
    const grant = listGrants(db).find((item) => item.id === id);
    if (grant) revokeStoredGrant(home, grant);
    deleteGrant(db, id);
    rescan();
    publishStatus();
  };
  ipcMain.handle("grants:revoke", (_event, id: number) => endGrant(id));
  // The softer step before lockdown: timed and session grants end, Always and Always in repo stay.
  const endTemporary = (agent?: string) => {
    const ended = listGrants(db).filter((grant) => grant.source === "leash" && grant.expiresAt !== null && (!agent || grant.agent === agent));
    for (const grant of ended) deleteGrant(db, grant.id);
    if (!ended.length) return;
    publishClaudeRules(db, join(claudeRoot(), "settings.json"), home, snapshots.find((snapshot) => snapshot.id === "claude-code")?.enforcement === "rules");
    publishStatus();
  };
  const trayStatus = (): TrayStatus => {
    const now = Date.now();
    const live = listGrants(db).filter((grant) => grant.source === "leash" && (grant.expiresAt === null || grant.expiresAt > now));
    const midnight = new Date(now).setHours(0, 0, 0, 0);
    const today = buildInsights({ decisions: decisionsSince(db, midnight), grants: [], alerts: [], now, days: 1, home });
    return {
      grants: live.map((grant) => ({ id: grant.id, agent: grant.agent, label: grant.command ?? grant.path, expiresAt: grant.expiresAt, session: Boolean(grant.idleSeconds) })),
      alert: lastAlert,
      today: { prompts: today.promptsToday, auto: today.days[0]?.auto ?? 0, blocked: today.blocked },
    };
  };
  ipcMain.handle("grants:revoke-all", () => revokeAll());
  ipcMain.handle("grants:create", (_event, input: { agent: AgentId | "*"; path: string; access: Access; ttlSeconds: number | null }) => {
    // A manual grant gets the same limits as the popup: secrets and personal folders are time-boxed.
    const agent = input.agent === "*" || input.agent === "t3-code" ? "claude-code" : input.agent;
    const policy = requestPolicy({ agent, event: "manual", tool: "Grant", access: input.access, paths: [input.path], cwd: input.path }, home, repoRoot);
    let ttl = input.ttlSeconds;
    if (policy.kind === "secret" || policy.kind === "startup" || policy.kind === "personal") {
      // A grant made deliberately on the Access page may last up to 15 minutes here.
      const max = MANUAL_GUARDED_MAX_S;
      ttl = ttl === null ? max : Math.min(ttl, max);
    }
    allow([input.path], input.agent, input.access, ttl, true);
    publishStatus();
  });
  ipcMain.handle("grants:extend", (_event, id: number, seconds: number) => {
    if (!Number.isInteger(id) || !Number.isFinite(seconds) || seconds <= 0) return { expiresAt: null };
    // Secret, startup and personal grants stay short; extending would undo that.
    const grant = listGrants(db).find((item) => item.id === id);
    if (grant && grant.command == null && (guardedKind(grant.path, grant.access, home) || (personalKind(grant.path, home) && !repoRoot(grant.path)))) return { expiresAt: null };
    const expiresAt = extendGrant(db, id, seconds, Date.now());
    if (expiresAt !== null) {
      rescan();
      publishStatus();
    }
    return { expiresAt };
  });
  const dismissedSuggestions = (): string[] => {
    try {
      const parsed = JSON.parse(getSetting(db, "suggestions:dismissed", "[]"));
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  };
  const currentSuggestions = () => suggestRules(listApprovals(db, Date.now() - SUGGEST_WINDOW_MS), listGrants(db), dismissedSuggestions(), Date.now());
  ipcMain.handle("suggestions:list", () => currentSuggestions());
  ipcMain.handle("suggestions:accept", (_event, key: string) => {
    const item = currentSuggestions().find((suggestion) => suggestion.key === key);
    if (!item) return;
    if (item.command) upsertCommandGrant(db, { agent: item.agent, command: item.command, createdAt: Date.now(), expiresAt: null });
    else if (item.path) allow([item.path], item.agent as AgentId | "*", item.access, null, true);
    publishStatus();
  });
  ipcMain.handle("suggestions:dismiss", (_event, key: string) => {
    if (typeof key !== "string") return;
    setSetting(db, "suggestions:dismissed", JSON.stringify([...dismissedSuggestions().filter((item) => item !== key), key].slice(-200)));
    publishStatus();
  });
  ipcMain.handle("approval-style:get", () => parseApprovalStyle(getSetting(db, "approval_style", "popup")));
  ipcMain.handle("approval-style:set", (_event, style: ApprovalStyle) => setSetting(db, "approval_style", parseApprovalStyle(style)));
  ipcMain.handle("grants:unlock", () => unlock());
  const autoAllowRows = () => {
    const off = new Set(parseAutoAllowOff(getSetting(db, "auto_allow_off", "[]")));
    return AUTO_ALLOWS.map((rule) => ({ ...rule, enabled: !off.has(rule.id) }));
  };
  ipcMain.handle("auto-allow:list", () => autoAllowRows());
  ipcMain.handle("auto-allow:set", (_event, id: string, enabled: boolean) => {
    if (!AUTO_ALLOWS.some((rule) => rule.id === id) || typeof enabled !== "boolean") return autoAllowRows();
    const off = new Set(parseAutoAllowOff(getSetting(db, "auto_allow_off", "[]")));
    if (enabled) off.delete(id);
    else off.add(id);
    setSetting(db, "auto_allow_off", JSON.stringify([...off]));
    return autoAllowRows();
  });
  const releaseCovered = () => {
    const options = {
      now: Date.now(),
      lockdown: getSetting(db, "lockdown", "0") === "1",
      protectedRoots: protectedRoots(home),
      home,
      autoAllowOff: parseAutoAllowOff(getSetting(db, "auto_allow_off", "[]")),
      rules: listRules(db),
    };
    for (const coveredId of coveredPending(broker.list(), listGrants(db), options)) {
      const timeout = timeouts.get(coveredId);
      if (timeout) clearTimeout(timeout);
      timeouts.delete(coveredId);
      broker.decide(coveredId, { decision: "allow" });
    }
  };
  ipcMain.handle("rules:list", () => listRules(db));
  ipcMain.handle("rules:create", (_event, input: { kind: unknown; agent: unknown; value: unknown }) => {
    const result = createRule(db, input, home, Date.now());
    if (!result.error) {
      publishClaudeRules(db, join(claudeRoot(), "settings.json"), home, snapshots.find((snapshot) => snapshot.id === "claude-code")?.enforcement === "rules");
      releaseCovered();
    }
    return result;
  });
  ipcMain.handle("rules:update", (_event, id: number, input: { kind: unknown; agent: unknown; value: unknown }) => {
    const result = updateRule(db, id, input, home, Date.now());
    if (!result.error) {
      publishClaudeRules(db, join(claudeRoot(), "settings.json"), home, snapshots.find((snapshot) => snapshot.id === "claude-code")?.enforcement === "rules");
      releaseCovered();
    }
    return result;
  });
  ipcMain.handle("rules:delete", (_event, id: number) => {
    const rules = deleteRule(db, id);
    publishClaudeRules(db, join(claudeRoot(), "settings.json"), home, snapshots.find((snapshot) => snapshot.id === "claude-code")?.enforcement === "rules");
    releaseCovered();
    return rules;
  });
  ipcMain.handle("decisions:list", () => listDecisions(db));
  ipcMain.handle("insights:get", (_event, days: number) => {
    const span = Number.isInteger(days) && days >= 1 && days <= 90 ? days : 7;
    const now = Date.now();
    const since = now - span * 24 * 60 * 60 * 1000;
    let alerts: HistoryRow[] = [];
    try {
      alerts = withHistory((historyDb) => queryHistory(historyDb, { from: since, to: null, agents: [], path: "", kind: "", sensitive: true, offset: 0, limit: 12 }).rows);
    } catch {
      /* history paused or missing; the rest still renders */
    }
    return buildInsights({ decisions: decisionsSince(db, since), grants: listGrants(db), alerts, now, days: span, home });
  });
  ipcMain.handle("history:list", () => history);
  ipcMain.handle("history:query", (_event, filter: HistoryFilter) => withHistory((historyDb) => queryHistory(historyDb, filter)));
  const retentionState = () => ({
    main: retentionDays(getSetting(db, "history_days", ""), MAIN_RETENTION_DAYS),
    noise: retentionDays(getSetting(db, "noise_days", ""), NOISE_RETENTION_DAYS),
  });
  ipcMain.handle("history:retention:get", () => retentionState());
  ipcMain.handle("history:retention:set", (_event, which: "main" | "noise", days: number) => {
    const parsed = which === "main" || which === "noise" ? parseRetentionDays(String(days)) : null;
    if (parsed === null) return retentionState();
    setSetting(db, which === "main" ? "history_days" : "noise_days", String(parsed));
    return retentionState();
  });
  const capGb = () => parseCapGb(getSetting(db, "history_cap_gb", "")) ?? CAP_DEFAULT_GB;
  ipcMain.handle("history:cap:get", () => ({ gb: capGb() }));
  ipcMain.handle("history:cap:set", (_event, gb: number) => {
    const parsed = parseCapGb(String(gb));
    if (parsed !== null) setSetting(db, "history_cap_gb", String(parsed));
    broadcast("storage:changed");
    return { gb: capGb() };
  });
  const historyStats = () => withHistory((historyDb) => readHistoryStats(historyDb));
  const storageInfo = () => {
    const historyDir = dirname(historyPath);
    const logPath = join(historyDir, "helper.log");
    const sizeBytes = historyStorageBytes(historyPath);
    const disk = existsSync(historyDir) ? statfsSync(historyDir) : null;
    let stats: HistoryStats | null = null;
    try {
      stats = existsSync(historyPath) ? historyStats() : null;
    } catch {
      stats = null;
    }
    return {
      stats,
      files: [
        { label: "History database", path: historyPath, bytes: sizeBytes },
        { label: "Helper log", path: logPath, bytes: pathBytes(logPath) + pathBytes(`${logPath}.1`) },
        { label: "Grants and settings", path: grantsDbPath(), bytes: historyStorageBytes(grantsDbPath()) },
        { label: "App data", path: options.userData, bytes: pathBytes(options.userData) },
      ],
      freeBytes: disk ? disk.bavail * disk.bsize : 0,
      requiredBytes: sizeBytes + 64 * 1024 * 1024,
    };
  };
  ipcMain.handle("history:storage:info", () => storageInfo());
  ipcMain.handle("history:warning:get", () => {
    try {
      const stats = historyStats();
      const state = readUiState(options.userData);
      const stored = state.storageWarningDismissed ?? 0;
      const dismissed = rearmDismissed(stats, stored);
      if (dismissed !== stored) writeUiState(options.userData, { ...state, storageWarningDismissed: dismissed });
      return { warning: storageWarning(stats, dismissed), capBytes: stats?.capBytes ?? 0 };
    } catch {
      return { warning: null, capBytes: 0 };
    }
  });
  ipcMain.handle("history:warning:dismiss", (_event, step: number) => {
    if (!Number.isInteger(step) || step >= 100) return;
    const state = readUiState(options.userData);
    writeUiState(options.userData, { ...state, storageWarningDismissed: Math.max(state.storageWarningDismissed ?? 0, step) });
    broadcast("storage:changed");
  });
  let optimizingHistory = false;
  ipcMain.handle("history:purge:run", async (_event, mode: CleanupMode, days?: number) => {
    if (!CLEANUP_MODES.includes(mode)) throw new Error("Unknown history cleanup.");
    const keepDays = mode === "older" ? parseRetentionDays(String(days)) : null;
    if (mode === "older" && keepDays === null) throw new Error("Pick from 5 to 365 days.");
    if (optimizingHistory) throw new Error("History cleanup is already running.");
    const info = storageInfo();
    if (!existsSync(historyPath)) throw new Error("There is no history database to clean up.");
    if (mode !== "all" && info.freeBytes < info.requiredBytes) throw new Error("Not enough free disk space to clean up history safely.");
    optimizingHistory = true;
    historyPaused = true;
    try {
      let result: HistoryCleanupResult;
      if (IS_MAC && app.isPackaged) {
        const helperScript = hookScript().replace("leash-hook.js", "leash-helper.js");
        const args = mode === "compact" ? ["--optimize", historyPath] : ["--purge", mode, historyPath, ...(keepDays === null ? [] : [String(keepDays)])];
        const { stdout } = await exec("/usr/bin/osascript", ["-e", helperMaintenanceScript(process.execPath, helperScript, args)]);
        let deleted: number | null = null;
        try {
          deleted = (JSON.parse(stdout.trim().split("\n").pop() ?? "") as { deleted?: number | null }).deleted ?? null;
        } catch {
          deleted = null;
        }
        result = { beforeBytes: info.files[0]!.bytes, afterBytes: historyStorageBytes(historyPath), deleted };
      } else {
        result = mode === "compact" ? { ...optimizeHistory(historyPath), deleted: null } : purgeCommand(mode, historyPath, keepDays === null ? undefined : String(keepDays));
      }
      return result;
    } finally {
      historyPaused = false;
      optimizingHistory = false;
      pollHistory();
      broadcast("storage:changed");
    }
  });
  ipcMain.handle("ignored:list", () => listIgnored(db));
  ipcMain.handle("ignored:set", (_event, id: number, enabled: boolean) => {
    if (!Number.isInteger(id) || typeof enabled !== "boolean") return listIgnored(db);
    setIgnoredEnabled(db, id, enabled);
    return listIgnored(db);
  });
  ipcMain.handle("ignored:add", (_event, prefix: string) => {
    const added = typeof prefix === "string" && addIgnored(db, prefix) !== null;
    return { rows: listIgnored(db), added };
  });
  ipcMain.handle("ignored:update", (_event, id: number, prefix: string) => {
    const updated = Number.isInteger(id) && typeof prefix === "string" && updateIgnored(db, id, prefix) !== null;
    return { rows: listIgnored(db), updated };
  });
  ipcMain.handle("ignored:delete", (_event, id: number) => {
    if (Number.isInteger(id)) deleteIgnored(db, id);
    return listIgnored(db);
  });
  ipcMain.handle("history:text", (_event, id: number) => withHistory((historyDb) => historyText(historyDb, id)));
  ipcMain.handle("history:summary", (_event, from: number) => {
    const since = Number.isFinite(from) ? from : 0;
    return { ...withHistory((historyDb) => summarizeHistory(historyDb, since)), blocked: countBlocked(db, since) };
  });
  ipcMain.handle("history:restore", (_event, id: number) => {
    if (!Number.isInteger(id)) return { ok: false, reason: "That history entry is gone." };
    const { event, text } = withHistory((historyDb) => ({ event: historyEvent(historyDb, id), text: historyText(historyDb, id) }));
    if (!event) return { ok: false, reason: "That history entry is gone." };
    let current: string | null = null;
    try {
      current = readFileSync(event.path, "utf8");
    } catch {
      /* missing or unreadable */
    }
    const check = checkRestore({ kind: event.kind, path: event.path, before: text.before, after: text.after, current, home, protectedRoots: protectedRoots(home) });
    if (!check.ok || text.before === null) return check.ok ? { ok: false, reason: "There is no earlier version to restore." } : check;
    try {
      const mode = statSync(event.path).mode & 0o777;
      writeFileSync(event.path, text.before, { mode });
      chmodSync(event.path, mode);
    } catch {
      return { ok: false, reason: "The file could not be written." };
    }
    return { ok: true };
  });
  ipcMain.handle("approval:list", () => pendingView());
  ipcMain.handle("approval:close", () => options.closeApproval());
  // Never rules made when answering a request, kept briefly so Undo can remove them.
  const neverById = new Map<string, number[]>();
  let lastDenyAt = 0;
  const endOfDayHour = () => {
    const hour = Number(getSetting(db, "end_of_day_hour", String(END_OF_DAY_HOUR)));
    return Number.isInteger(hour) && hour >= 12 && hour <= 23 ? hour : END_OF_DAY_HOUR;
  };
  const decideApproval = (id: string, decision: "allow" | "deny" | "never", ttlSeconds: number | null, scopePath?: string, presetId?: PresetId) => {
    const raw = broker.list().find((item) => item.id === id);
    const pending = raw ? withPolicy(raw) : undefined;
    const timeout = timeouts.get(id);
    if (timeout) clearTimeout(timeout);
    if (decision !== "allow") {
      if (decision === "never" && pending) {
        const { agent, command, paths } = pending.request;
        const scope = typeof scopePath === "string" && parentFolders(paths).includes(scopePath) ? scopePath : undefined;
        const blocks = command?.trim() ? [{ kind: "command" as const, value: command.trim() }] : (scope ? [scope] : paths).map((value) => ({ kind: "path" as const, value }));
        const ids = blocks.map((block) => addBlock(db, { agent, ...block }, Date.now()));
        neverById.set(id, ids);
        if (neverById.size > 50) neverById.delete(neverById.keys().next().value!);
      }
      lastDenyAt = Date.now();
      broker.decide(id, { decision: "deny" });
      publishStatus();
      return;
    }
    // The renderer picks a choice, but the policy here has the last word on how long it lasts.
    const wanted = presetId && isPresetId(presetId) ? presetId : presetFromSeconds(ttlSeconds === undefined ? DEFAULT_TTL_S : ttlSeconds);
    const preset = pending?.policy ? presetById(clampPreset(pending.policy, wanted)) : presetById(wanted);
    const now = Date.now();
    const ttl = preset.id === "today" ? Math.round((todayExpiry(now, endOfDayHour()) - now) / 1000) : preset.id === "repo" ? null : preset.seconds;
    // "Once" lets this call through and writes nothing.
    if (pending && preset.id !== "once" && !hasUnresolved(pending.request.paths)) {
      const { agent, access } = pending.request;
      const policy = pending.policy;
      const exact = policy?.exact ?? false;
      if (preset.id === "repo" && policy?.repo) {
        // "Always in repo" is a forever write grant on the repo root; guarded files inside still ask.
        allow([policy.repo], agent, "write", null, true);
      } else {
        const scope = !exact && typeof scopePath === "string" && parentFolders(pending.request.paths).includes(scopePath) ? scopePath : undefined;
        const session = preset.id === "session" ? { sessionId: pending.request.sessionId ?? null } : undefined;
        const targets = scope ? [scope] : exact ? pending.request.paths.filter((path) => guardedKind(path, access, home)) : pending.request.paths;
        const roots = allow(targets, agent, access, ttl, Boolean(scope) || exact, session);
        // Only plain timed approvals count toward "make it Always" suggestions.
        const suggestible = !session && preset.id !== "today" && policy?.kind !== "secret" && policy?.kind !== "startup" && policy?.kind !== "personal";
        if (suggestible) for (const path of roots) recordApproval(db, { ts: now, agent, path, command: null, access, ttlSeconds: ttl });
        const command = pending.request.command?.trim() ?? "";
        if (command && !exact) {
          upsertCommandGrant(db, { agent, command, createdAt: now, expiresAt: ttl === null ? null : now + ttl * 1000 });
          if (suggestible) recordApproval(db, { ts: now, agent, path: null, command, access, ttlSeconds: ttl });
        }
      }
    }
    broker.decide(id, { decision: "allow", ttlSeconds: ttl ?? undefined, ...(preset.id === "once" ? { once: true as const } : {}) });
    releaseCovered();
    publishStatus();
  };
  ipcMain.handle("approval:decide", (_event, id: string, decision: "allow" | "deny" | "never", ttlSeconds: number | null, scopePath?: string, presetId?: PresetId) =>
    decideApproval(id, decision, ttlSeconds, scopePath, presetId),
  );
  const lockEnds = () => (getSetting(db, "lock_ends", "personal") === "all" ? "all" : "personal");
  // Locking or sleeping the Mac ends temporary access: personal folders only by default, or everything timed.
  const onLock = () => {
    const mode = lockEnds();
    const ended = listGrants(db).filter(
      (grant) => grant.source === "leash" && grant.expiresAt !== null && (mode === "all" || (grant.command == null && personalKind(grant.path, home) !== null && repoRoot(grant.path) === null)),
    );
    if (!ended.length) return;
    for (const grant of ended) deleteGrant(db, grant.id);
    publishClaudeRules(db, join(claudeRoot(), "settings.json"), home, snapshots.find((snapshot) => snapshot.id === "claude-code")?.enforcement === "rules");
    publishStatus();
  };
  ipcMain.handle("approval-prefs:get", () => ({ lockEnds: lockEnds(), endOfDayHour: endOfDayHour() }));
  ipcMain.handle("approval-prefs:set", (_event, input: { lockEnds?: unknown; endOfDayHour?: unknown }) => {
    if (input.lockEnds === "all" || input.lockEnds === "personal") setSetting(db, "lock_ends", input.lockEnds);
    if (Number.isInteger(input.endOfDayHour) && (input.endOfDayHour as number) >= 12 && (input.endOfDayHour as number) <= 23) setSetting(db, "end_of_day_hour", String(input.endOfDayHour));
    return { lockEnds: lockEnds(), endOfDayHour: endOfDayHour() };
  });
  // Undo for a Deny or Never just made: the agent's next try asks again.
  ipcMain.handle("approval:undo-deny", (_event, id: string) => {
    if (typeof id !== "string") return false;
    const forgot = broker.undoDenial(id);
    const removed = deleteBlocks(db, neverById.get(id) ?? []);
    neverById.delete(id);
    publishStatus();
    return forgot || removed > 0;
  });
  ipcMain.handle("blocks:list", () => ({ remembered: broker.listDenials(), never: listBlocks(db) }));
  ipcMain.handle("blocks:forget", (_event, key: string) => {
    if (typeof key === "string") broker.forgetDenial(key);
    publishStatus();
  });
  ipcMain.handle("blocks:forget-all", () => {
    broker.forgetDenials();
    publishStatus();
  });
  ipcMain.handle("blocks:delete-never", (_event, id: number) => {
    if (Number.isInteger(id)) deleteBlocks(db, [id]);
    publishStatus();
  });
  // "Ask again" from the decision log: drop remembered denials and Never rules that match that row.
  ipcMain.handle("blocks:release-decision", (_event, decisionId: number) => {
    const row = listDecisions(db, 500).find((item) => item.id === decisionId);
    if (!row) return 0;
    let paths: string[] = [];
    try {
      paths = JSON.parse(row.paths) as string[];
    } catch {
      paths = [];
    }
    const command = row.command?.trim() || null;
    const forgot = broker.forgetMatching(row.agent, command, paths);
    const never = listBlocks(db).filter((block) => (block.agent === "*" || block.agent === row.agent) && (block.kind === "command" ? block.value === command : paths.some((path) => isUnder(path, block.value))));
    const removed = deleteBlocks(db, never.map((block) => block.id));
    publishStatus();
    return forgot + removed;
  });
  // Agents that aren't running read the new config on their next start, so they drop out here.
  const staleTargets = async () => {
    if (!pendingRestart.size) return [];
    const targets = restartTargets(parsePs(await psText())).filter((target) => pendingRestart.has(target.agent));
    for (const agent of pendingRestart) if (!targets.some((target) => target.agent === agent)) pendingRestart.delete(agent);
    return targets;
  };
  ipcMain.handle("runtime:restart-needed", async () => {
    const targets = await staleTargets();
    const byName = new Map<string, { name: string; kind: "gui" | "cli"; count: number }>();
    for (const target of targets) {
      const entry = byName.get(target.name) ?? { name: target.name, kind: target.kind, count: 0 };
      entry.count += 1;
      byName.set(target.name, entry);
    }
    return [...byName.values()];
  });
  ipcMain.handle("runtime:restart", async () => {
    const targets = await staleTargets();
    const quit = new Set<string>();
    for (const target of targets) {
      try {
        if (IS_MAC && target.kind === "gui" && target.bundleId) {
          if (!quit.has(target.bundleId)) await exec("/usr/bin/osascript", ["-e", guiQuitScript(target.bundleId)]);
          quit.add(target.bundleId);
        } else process.kill(target.pid, "SIGTERM");
      } catch {
        /* already exited, or the app refused to quit */
      }
    }
    pendingRestart.clear();
  });
  ipcMain.handle("runtime:dismiss-restart", () => pendingRestart.clear());
  const agentInstalled = (id: AgentId): boolean => {
    if (id === "claude-code") return existsSync(claudeRoot()) || macAppPresent("Claude", home, existsSync);
    if (id === "cursor") return existsSync(join(home, ".cursor")) || macAppPresent("Cursor", home, existsSync);
    if (id === "codex") return existsSync(join(home, ".codex/config.toml"));
    if (id === "gemini") return existsSync(join(home, ".gemini/settings.json")) || existsSync(join(home, ".gemini/trustedFolders.json"));
    if (id === "antigravity") return antigravityPresent(join(home, ".gemini")) || macAppPresent("Antigravity", home, existsSync);
    if (id === "hermes") return existsSync(join(home, ".hermes"));
    return false;
  };
  const hookRows = (): SetupAgent[] => {
    const disabled = new Set(readUiState(options.userData).disabledAgents ?? []);
    const hooks: Record<string, boolean | null> = {
      "claude-code": claudeHooksInstalled(readJson(hookPath("claude-code", home)), hookCommand("claude")),
      cursor: cursorHooksInstalled(readJson(hookPath("cursor", home)), hookCommand("cursor")),
      codex: codexHooksInstalled(readJson(hookPath("codex", home)), hookCommand("codex")),
      gemini: geminiHooksInstalled(readJson(hookPath("gemini", home)), hookCommand("gemini")),
      antigravity: antigravityHooksInstalled(readJson(hookPath("antigravity", home)), hookCommand("antigravity")),
      hermes: hermesHooksInstalled(existsSync(join(home, ".hermes/config.yaml")) ? readFileSync(join(home, ".hermes/config.yaml"), "utf8") : "", join(home, ".hermes/agent-hooks/agentic-leash.sh")),
    };
    return (["claude-code", "cursor", "codex", "gemini", "antigravity", "hermes"] as const).map((id) => ({
      id,
      installed: agentInstalled(id),
      enabled: !disabled.has(id),
      hooks: hooks[id] ?? null,
    }));
  };
  const helperState = async (): Promise<HelperState> => {
    if (!app.isPackaged) return "skipped";
    if (!IS_MAC) return "stopped";
    void checkHelperUpdate();
    try {
      const { stdout } = await exec("/bin/launchctl", ["print", "system/com.agenticleash.helper"]);
      return stdout.includes("state = running") ? "running" : "stopped";
    } catch {
      return "stopped";
    }
  };
  const currentSetup = async (): Promise<SetupStatus> => {
    if (process.env.AGENTIC_LEASH_SKIP_SETUP) return { helper: "skipped", fda: true, agents: hookRows(), ready: true };
    const helper = await helperState();
    const fda = !IS_MAC || helper === "skipped" || hasFullDiskAccess(join(homedir(), "Library/Application Support/com.apple.TCC/TCC.db"));
    const agents = hookRows();
    const state = readUiState(options.userData);
    const onboarded = rememberOnboarding(Boolean(state.onboarded), agents);
    if (onboarded && !state.onboarded) writeUiState(options.userData, { ...state, onboarded: true });
    return { helper, fda, agents, ready: setupReady({ helper, fda, agents }, onboarded) };
  };
  const installHermes = () => {
    const scriptPath = join(home, ".hermes/agent-hooks/agentic-leash.sh");
    mkdirSync(dirname(scriptPath), { recursive: true });
    writeFileSync(scriptPath, hermesScript(process.execPath, hookScript()));
    chmodSync(scriptPath, 0o755);
    const config = join(home, ".hermes/config.yaml");
    const text = existsSync(config) ? readFileSync(config, "utf8") : "";
    mkdirSync(dirname(config), { recursive: true });
    writeWithBackup(config, mergeHermesConfig(text, scriptPath));
  };
  const uninstallHermes = () => {
    const config = join(home, ".hermes/config.yaml");
    if (existsSync(config)) writeWithBackup(config, removeHermesConfig(readFileSync(config, "utf8")));
    const scriptPath = join(home, ".hermes/agent-hooks/agentic-leash.sh");
    if (existsSync(scriptPath)) rmSync(scriptPath);
  };
  const installAgent = (agent: HookAgent) => {
    if (agent === "hermes") {
      installHermes();
      pendingRestart.add("hermes");
      return;
    }
    const path = hookPath(agent, home);
    const kind = agent === "claude-code" ? "claude" : agent;
    const command = hookCommand(kind);
    const existing = readJson(path);
    const next = agent === "cursor" ? mergeCursorHooks(existing, command) : agent === "codex" ? mergeCodexHooks(existing, command) : agent === "gemini" ? mergeGeminiHooks(existing, command) : agent === "antigravity" ? mergeAntigravityHooks(existing, command) : mergeClaudeHooks(existing, command);
    writeHookFile(path, next);
    pendingRestart.add(agent);
  };
  const uninstallAgent = (agent: HookAgent) => {
    if (agent === "hermes") {
      uninstallHermes();
      pendingRestart.add("hermes");
      return;
    }
    const path = hookPath(agent, home);
    if (!existsSync(path)) return;
    const existing = readJson(path);
    const next = agent === "cursor" ? removeCursorHooks(existing) : agent === "codex" ? removeCodexHooks(existing) : agent === "gemini" ? removeGeminiHooks(existing) : agent === "antigravity" ? removeAntigravityHooks(existing) : removeClaudeHooks(existing);
    writeHookFile(path, next);
    pendingRestart.add(agent);
  };
  ipcMain.handle("hooks:status", () => hookRows().every((agent) => agent.hooks !== false));
  ipcMain.handle("hooks:install", (_event, agent: HookAgent) => {
    if (agent !== "claude-code" && agent !== "cursor" && agent !== "codex" && agent !== "gemini" && agent !== "antigravity" && agent !== "hermes") return;
    installAgent(agent);
  });
  ipcMain.handle("hooks:uninstall", (_event, agent: HookAgent) => {
    if (agent !== "claude-code" && agent !== "cursor" && agent !== "codex" && agent !== "gemini" && agent !== "antigravity" && agent !== "hermes") return;
    uninstallAgent(agent);
  });
  ipcMain.handle("setup:get", () => currentSetup());
  ipcMain.handle("agents:enabled", (_event, id: AgentId, enabled: boolean) => {
    const state = readUiState(options.userData);
    const disabled = new Set(state.disabledAgents ?? []);
    if (enabled) disabled.delete(id);
    else disabled.add(id);
    writeUiState(options.userData, { ...state, disabledAgents: [...disabled] });
    if (!enabled && (id === "claude-code" || id === "cursor" || id === "codex" || id === "gemini" || id === "antigravity" || id === "hermes")) uninstallAgent(id);
  });
  ipcMain.handle("diagnostics:get", async () => {
    const stats = percentiles(decisionDurations(db));
    let helperStatus = IS_MAC ? "not installed" : "unsupported on this OS";
    if (IS_MAC) try {
      void checkHelperUpdate();
      const { stdout } = await exec("/bin/launchctl", ["print", "system/com.agenticleash.helper"]);
      helperStatus = stdout.includes("state = running") ? "running" : stdout.split("\n")[0] || "installed";
    } catch {
      helperStatus = "not installed";
    }
    const last = listDecisions(db, 1)[0];
    return diagnosticsReport({
      claude: claudeHooksInstalled(readJson(join(claudeRoot(), "settings.json")), hookCommand("claude")),
      cursor: cursorHooksInstalled(readJson(join(home, ".cursor/hooks.json")), hookCommand("cursor")),
      codex: codexHooksInstalled(readJson(join(home, ".codex/hooks.json")), hookCommand("codex")),
      gemini: geminiHooksInstalled(readJson(join(home, ".gemini/settings.json")), hookCommand("gemini")),
      antigravity: antigravityHooksInstalled(readJson(join(home, ".gemini/config/hooks.json")), hookCommand("antigravity")),
      hermes: hermesHooksInstalled(existsSync(join(home, ".hermes/config.yaml")) ? readFileSync(join(home, ".hermes/config.yaml"), "utf8") : "", join(home, ".hermes/agent-hooks/agentic-leash.sh")),
      helperStatus,
      lastSweep: getSetting(db, "last_sweep", "") || null,
      hookP50Ms: stats.p50,
      hookP95Ms: stats.p95,
      lastDecision: last ? { ts: last.ts, agent: last.agent, tool: last.tool, verdict: last.verdict, reason: last.reason } : null,
    });
  });
  ipcMain.handle("theme:get", () => readUiState(options.userData).theme ?? "system");
  ipcMain.handle("theme:set", (_event, theme: ThemeSource) => {
    writeUiState(options.userData, { ...readUiState(options.userData), theme });
    nativeTheme.themeSource = theme;
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send("theme:changed", theme);
    return theme;
  });
  ipcMain.handle("fda:status", () => IS_MAC && hasFullDiskAccess(join(homedir(), "Library/Application Support/com.apple.TCC/TCC.db")));
  ipcMain.handle("fda:open", () => (IS_MAC ? exec("/usr/bin/open", [FULL_DISK_URL]) : undefined));
  ipcMain.handle("tcc:reset", async (_event, service: string, bundleId: string) => {
    if (!IS_MAC) return;
    await exec("/usr/bin/tccutil", ["reset", service.replace(/^kTCCService/, ""), bundleId]);
    scan();
  });
  ipcMain.handle("trust:scheduled", () => listScheduled(db));
  ipcMain.handle("trust:revoke", (_event, path: string) => {
    revokeClaudeTrust(claudeJson(), path);
    cancelScheduled(db, path);
    rescan();
  });
  ipcMain.handle("trust:schedule", (_event, path: string, dueAt: number) => {
    if (typeof path !== "string" || !path.startsWith("/") || !Number.isFinite(dueAt) || dueAt <= Date.now()) return;
    scheduleRevoke(db, path, dueAt);
  });
  ipcMain.handle("trust:cancel", (_event, path: string) => cancelScheduled(db, path));
  ipcMain.handle("agents:remove-mcp", (_event, agent: AgentId, name: string) => {
    const files: Partial<Record<AgentId, string>> = { "claude-code": claudeJson(), cursor: join(home, ".cursor/mcp.json"), gemini: join(home, ".gemini/settings.json"), antigravity: join(home, ".gemini/config/mcp_config.json") };
    const path = files[agent];
    if (!path || typeof name !== "string") return;
    type Servers = { mcpServers?: Record<string, unknown> };
    const json = readJson(path) as Servers & { projects?: Record<string, Servers> };
    const scopes = [json, ...Object.values(json.projects ?? {})].filter((scope) => scope.mcpServers && name in scope.mcpServers);
    if (!scopes.length) return;
    for (const scope of scopes) delete scope.mcpServers![name];
    writeWithBackup(path, `${JSON.stringify(json, null, 2)}\n`);
    pendingRestart.add(agent);
    rescan();
  });
  ipcMain.handle("onboarding:get", () => Boolean(readUiState(options.userData).onboarded));
  ipcMain.handle("onboarding:set", (_event, done: boolean) => {
    writeUiState(options.userData, { ...readUiState(options.userData), onboarded: done });
  });
  ipcMain.handle("helper:install", async () => {
    if (!IS_MAC) throw new Error("The activity helper is macOS-only.");
    await exec("/usr/bin/osascript", ["-e", helperInstallScript(process.execPath, hookScript().replace("leash-hook.js", "leash-helper.js"))]);
  });
  ipcMain.handle("helper:restart", async () => {
    if (!IS_MAC) throw new Error("The activity helper is macOS-only.");
    const scriptPath = hookScript().replace("leash-hook.js", "leash-helper.js");
    let initialPid: number | null = null;
    try {
      const { stdout } = await exec("/bin/launchctl", ["print", "system/com.agenticleash.helper"]);
      if (stdout.includes("state = running")) {
        initialPid = parseLaunchdPid(stdout);
      }
    } catch {
      /* not running */
    }

    setSetting(db, "helper_restart_requested", Date.now().toString());

    let restarted = false;
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        const { stdout } = await exec("/bin/launchctl", ["print", "system/com.agenticleash.helper"]);
        if (stdout.includes("state = running")) {
          const currentPid = parseLaunchdPid(stdout);
          if (initialPid !== null && currentPid !== null && currentPid !== initialPid) {
            restarted = true;
            break;
          }
          if (initialPid === null && currentPid !== null) {
            restarted = true;
            break;
          }
        }
      } catch {
        /* launchctl print failed */
      }
    }

    if (!restarted) {
      await exec("/usr/bin/osascript", ["-e", helperInstallScript(process.execPath, scriptPath)]);
    }
  });
  ipcMain.handle("app:uninstall", async () => {
    if (IS_MAC && app.isPackaged) await exec("/usr/bin/osascript", ["-e", helperUninstallScript()]);
    uninstalling = true;
    for (const agent of ["claude-code", "cursor", "codex", "gemini", "antigravity", "hermes"] as const) uninstallAgent(agent);
    publishClaudeRules(db, join(claudeRoot(), "settings.json"), home, false);
    if (IS_MAC) {
      const uid = process.getuid?.();
      if (uid !== undefined) {
        await exec("/bin/launchctl", ["bootout", sweepServiceTarget(uid)]).catch(() => undefined);
        await exec("/bin/launchctl", ["bootout", `gui/${uid}/${LOGIN_AGENT_LABEL}`]).catch(() => undefined);
      }
    } else options.disableLoginItem();
    removeLeftovers(uninstallLeftovers({ home, claudeRoot: claudeRoot(), userData: options.userData, historyDir: dirname(historyPath), systemHistory: HISTORY_DIR }));
    options.finishUninstall();
  });

  try {
    globalShortcut.register(IS_MAC ? "Control+Alt+Command+L" : "Control+Alt+Shift+L", () => {
      const { revoked } = revokeAll();
      options.notify("Lockdown is on", `Revoked ${revoked} grants. Agent tool calls are blocked until you end lockdown.`);
    });
  } catch {
    /* shortcut already owned */
  }
  void ensureSweepAgent();
  nativeTheme.themeSource = readUiState(options.userData).theme ?? "system";
  publishStatus();
  return { revokeAll, unlock, onLock, trayStatus, endGrant, endTemporary };
}

export function leashDataDir(): string {
  return leashDir();
}
