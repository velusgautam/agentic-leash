import { existsSync } from "node:fs";
import { join } from "node:path";
import { autoUpdater } from "electron-updater";
import {
  createInitialUpdateState,
  getAutoUpdateDisabledReason,
  reduceUpdateOnAvailable,
  reduceUpdateOnCheckFailure,
  reduceUpdateOnCheckStart,
  reduceUpdateOnDownloadComplete,
  reduceUpdateOnDownloadFailure,
  reduceUpdateOnDownloadProgress,
  reduceUpdateOnDownloadStart,
  reduceUpdateOnInstallFailure,
  reduceUpdateOnNoUpdate,
  shouldBroadcastDownloadProgress,
  type UpdateActionResult,
  type UpdateCheckResult,
  type UpdateState,
} from "../shared/updater";

export const AUTO_UPDATE_STARTUP_DELAY_MS = 15_000;
export const AUTO_UPDATE_POLL_INTERVAL_MS = 4 * 60 * 1000;

export interface UpdaterDriver {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface StartUpdaterOptions {
  currentVersion: string;
  isPackaged: boolean;
  resourcesPath: string;
  platform?: string;
  env?: NodeJS.ProcessEnv;
  broadcast: (channel: string, payload?: unknown) => void;
  prepareQuit: () => void;
  onStateChange?: (state: UpdateState) => void;
  notifyAvailable?: (version: string) => void;
  driver?: UpdaterDriver;
  startupDelayMs?: number;
  pollIntervalMs?: number;
}

export interface UpdaterController {
  getState(): UpdateState;
  check(): Promise<UpdateCheckResult>;
  download(): Promise<UpdateActionResult>;
  install(): Promise<UpdateActionResult>;
  stop(): void;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.split(/[\r\n]/, 1)[0]!.slice(0, 240);
  }
  if (typeof error === "string" && error.trim()) {
    return error.split(/[\r\n]/, 1)[0]!.slice(0, 240);
  }
  return fallback;
}

function extractVersion(info: unknown): string | null {
  if (info && typeof info === "object" && "version" in info) {
    const version = (info as { version?: unknown }).version;
    if (typeof version === "string" && version.trim()) return version.trim();
  }
  return null;
}

function extractPercent(progress: unknown): number | null {
  if (progress && typeof progress === "object" && "percent" in progress) {
    const percent = (progress as { percent?: unknown }).percent;
    if (typeof percent === "number" && Number.isFinite(percent)) return percent;
  }
  return null;
}

export function startUpdater(options: StartUpdaterOptions): UpdaterController {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const driver: UpdaterDriver = options.driver ?? (autoUpdater as unknown as UpdaterDriver);
  const hasUpdateFeedConfig =
    env.AGENTIC_LEASH_MOCK_UPDATES === "1" ||
    Boolean(options.resourcesPath && existsSync(join(options.resourcesPath, "app-update.yml")));

  const disabledReason = getAutoUpdateDisabledReason({
    isPackaged: options.isPackaged,
    platform,
    appImage: env.APPIMAGE,
    disabledByEnv: env.AGENTIC_LEASH_DISABLE_AUTO_UPDATE === "1",
    hasUpdateFeedConfig,
  });

  let state = createInitialUpdateState(options.currentVersion, disabledReason);
  let activeAction: "check" | "download" | "install" | null = null;
  const notifiedVersions = new Set<string>();
  let startupTimer: NodeJS.Timeout | null = null;
  let pollTimer: NodeJS.Timeout | null = null;

  const setState = (next: UpdateState) => {
    state = next;
    options.onStateChange?.(state);
    options.broadcast("update:state", state);
  };

  const check = async (): Promise<UpdateCheckResult> => {
    if (!state.enabled || activeAction !== null || state.status === "downloading") {
      return { checked: false, state };
    }
    activeAction = "check";
    setState(reduceUpdateOnCheckStart(state, Date.now()));
    try {
      await driver.checkForUpdates();
      return { checked: true, state };
    } catch (error) {
      setState(
        reduceUpdateOnCheckFailure(
          state,
          errorMessage(error, "Could not check for updates."),
          Date.now(),
        ),
      );
      return { checked: true, state };
    } finally {
      if (activeAction === "check") activeAction = null;
    }
  };

  const download = async (): Promise<UpdateActionResult> => {
    const canDownload =
      state.status === "available" ||
      (state.status === "error" && state.errorContext === "download" && state.availableVersion !== null);
    if (!state.enabled || !canDownload || activeAction !== null) {
      return { accepted: false, completed: false, state };
    }
    activeAction = "download";
    setState(reduceUpdateOnDownloadStart(state));
    try {
      await driver.downloadUpdate();
      if (state.status === "downloading" && state.availableVersion) {
        setState(reduceUpdateOnDownloadComplete(state, state.availableVersion));
      }
      return { accepted: true, completed: state.status === "downloaded", state };
    } catch (error) {
      setState(
        reduceUpdateOnDownloadFailure(
          state,
          errorMessage(error, "Could not download the update."),
        ),
      );
      return { accepted: true, completed: false, state };
    } finally {
      if (activeAction === "download") activeAction = null;
    }
  };

  const install = async (): Promise<UpdateActionResult> => {
    const canInstall =
      state.downloadedVersion !== null &&
      (state.status === "downloaded" ||
        (state.status === "error" && (state.errorContext === "install" || state.errorContext === null)));
    if (!state.enabled || !canInstall || activeAction !== null) {
      return { accepted: false, completed: false, state };
    }
    activeAction = "install";
    try {
      options.prepareQuit();
      driver.quitAndInstall(true, true);
      return { accepted: true, completed: true, state };
    } catch (error) {
      setState(
        reduceUpdateOnInstallFailure(
          state,
          errorMessage(error, "Could not install the update."),
        ),
      );
      return { accepted: true, completed: false, state };
    } finally {
      if (activeAction === "install") activeAction = null;
    }
  };

  if (state.enabled) {
    driver.autoDownload = false;
    driver.autoInstallOnAppQuit = false;

    driver.on("update-available", (info) => {
      const version = extractVersion(info);
      if (!version) return;
      setState(reduceUpdateOnAvailable(state, version, Date.now()));
      if (!notifiedVersions.has(version)) {
        notifiedVersions.add(version);
        options.notifyAvailable?.(version);
      }
    });

    driver.on("update-not-available", () => {
      setState(reduceUpdateOnNoUpdate(state, Date.now()));
    });

    driver.on("download-progress", (progress) => {
      const percent = extractPercent(progress);
      if (percent === null) return;
      if (shouldBroadcastDownloadProgress(state, percent) || state.message !== null) {
        setState(reduceUpdateOnDownloadProgress(state, percent));
      } else {
        state = reduceUpdateOnDownloadProgress(state, percent);
      }
    });

    driver.on("update-downloaded", (info) => {
      const version = extractVersion(info) ?? state.availableVersion;
      if (!version) return;
      setState(reduceUpdateOnDownloadComplete(state, version));
    });

    driver.on("before-quit-for-update", () => {
      options.prepareQuit();
    });

    driver.on("error", (error) => {
      const msg = errorMessage(error, "Automatic update error.");
      if (activeAction === "download") {
        setState(reduceUpdateOnDownloadFailure(state, msg));
      } else if (activeAction === "install") {
        setState(reduceUpdateOnInstallFailure(state, msg));
      } else if (activeAction === null) {
        setState(reduceUpdateOnCheckFailure(state, msg, Date.now()));
      }
    });

    const startupDelay = options.startupDelayMs ?? AUTO_UPDATE_STARTUP_DELAY_MS;
    const pollInterval = options.pollIntervalMs ?? AUTO_UPDATE_POLL_INTERVAL_MS;

    startupTimer = setTimeout(() => {
      void check();
    }, startupDelay);
    startupTimer.unref?.();

    pollTimer = setInterval(() => {
      void check();
    }, pollInterval);
    pollTimer.unref?.();
  }

  return {
    getState: () => state,
    check,
    download,
    install,
    stop: () => {
      if (startupTimer) clearTimeout(startupTimer);
      if (pollTimer) clearInterval(pollTimer);
      startupTimer = null;
      pollTimer = null;
    },
  };
}
