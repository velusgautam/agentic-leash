export type UpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "up-to-date"
  | "error";

export type UpdateErrorContext = "check" | "download" | "install" | null;

export interface UpdateState {
  enabled: boolean;
  status: UpdateStatus;
  currentVersion: string;
  availableVersion: string | null;
  downloadedVersion: string | null;
  downloadPercent: number | null;
  checkedAt: number | null;
  message: string | null;
  errorContext: UpdateErrorContext;
  canRetry: boolean;
}

export interface UpdateCheckResult {
  checked: boolean;
  state: UpdateState;
}

export interface UpdateActionResult {
  accepted: boolean;
  completed: boolean;
  state: UpdateState;
}

export type UpdateButtonAction = "download" | "install" | "none";

export function createInitialUpdateState(
  currentVersion: string,
  disabledReason: string | null = null,
): UpdateState {
  const enabled = disabledReason === null;
  return {
    enabled,
    status: enabled ? "idle" : "disabled",
    currentVersion,
    availableVersion: null,
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt: null,
    message: disabledReason,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceUpdateOnCheckStart(state: UpdateState, checkedAt: number): UpdateState {
  return {
    ...state,
    status: "checking",
    downloadPercent: state.downloadedVersion !== null ? 100 : null,
    checkedAt,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceUpdateOnCheckFailure(
  state: UpdateState,
  message: string,
  checkedAt: number,
): UpdateState {
  const hasDownloadedUpdate = state.downloadedVersion !== null;
  return {
    ...state,
    status: hasDownloadedUpdate ? "downloaded" : "error",
    downloadPercent: hasDownloadedUpdate ? 100 : null,
    checkedAt,
    message,
    errorContext: "check",
    canRetry: true,
  };
}

export function reduceUpdateOnAvailable(
  state: UpdateState,
  version: string,
  checkedAt: number,
): UpdateState {
  const sameDownloadedVersion = state.downloadedVersion === version;
  return {
    ...state,
    status: sameDownloadedVersion ? "downloaded" : "available",
    availableVersion: version,
    downloadedVersion: sameDownloadedVersion ? state.downloadedVersion : null,
    downloadPercent: sameDownloadedVersion ? 100 : null,
    checkedAt,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceUpdateOnNoUpdate(state: UpdateState, checkedAt: number): UpdateState {
  const hasDownloadedUpdate = state.downloadedVersion !== null;
  return {
    ...state,
    status: hasDownloadedUpdate ? "downloaded" : "up-to-date",
    availableVersion: hasDownloadedUpdate
      ? (state.availableVersion ?? state.downloadedVersion)
      : null,
    downloadedVersion: hasDownloadedUpdate ? state.downloadedVersion : null,
    downloadPercent: hasDownloadedUpdate ? 100 : null,
    checkedAt,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceUpdateOnDownloadStart(state: UpdateState): UpdateState {
  return {
    ...state,
    status: "downloading",
    downloadPercent: 0,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceUpdateOnDownloadProgress(
  state: UpdateState,
  percent: number,
): UpdateState {
  const clamped = Math.max(0, Math.min(100, percent));
  return {
    ...state,
    status: "downloading",
    downloadPercent: clamped,
    message: null,
    errorContext: null,
  };
}

export function reduceUpdateOnDownloadFailure(
  state: UpdateState,
  message: string,
): UpdateState {
  return {
    ...state,
    status: state.availableVersion ? "available" : "error",
    downloadPercent: null,
    message,
    errorContext: "download",
    canRetry: state.availableVersion !== null,
  };
}

export function reduceUpdateOnDownloadComplete(
  state: UpdateState,
  version: string,
): UpdateState {
  return {
    ...state,
    status: "downloaded",
    availableVersion: version,
    downloadedVersion: version,
    downloadPercent: 100,
    message: null,
    errorContext: null,
    canRetry: true,
  };
}

export function reduceUpdateOnInstallFailure(
  state: UpdateState,
  message: string,
): UpdateState {
  return {
    ...state,
    status: "downloaded",
    message,
    errorContext: "install",
    canRetry: true,
  };
}

export function shouldBroadcastDownloadProgress(
  state: UpdateState,
  nextPercent: number,
): boolean {
  const clamped = Math.max(0, Math.min(100, nextPercent));
  if (state.status !== "downloading") return true;
  const currentPercent = state.downloadPercent;
  if (currentPercent === null) return true;
  const previousStep = Math.floor(currentPercent / 10);
  const nextStep = Math.floor(clamped / 10);
  return nextStep !== previousStep || clamped === 100;
}

export function getAutoUpdateDisabledReason(args: {
  isPackaged: boolean;
  platform: string;
  appImage?: string;
  disabledByEnv: boolean;
  hasUpdateFeedConfig: boolean;
}): string | null {
  if (!args.isPackaged) {
    return "Automatic updates are only available in packaged builds.";
  }
  if (args.disabledByEnv) {
    return "Automatic updates are disabled by the AGENTIC_LEASH_DISABLE_AUTO_UPDATE environment variable.";
  }
  if (args.platform === "linux" && !args.appImage) {
    return "Automatic updates on Linux require running the packaged AppImage build.";
  }
  if (!args.hasUpdateFeedConfig) {
    return "Automatic updates are not configured for this build.";
  }
  return null;
}

export function resolveUpdateButtonAction(state: UpdateState): UpdateButtonAction {
  if (state.downloadedVersion) {
    if (state.status === "downloaded") return "install";
    if (
      state.status === "error" &&
      state.canRetry &&
      (state.errorContext === "install" || state.errorContext === null)
    ) {
      return "install";
    }
  }
  if (state.status === "available") return "download";
  if (
    state.status === "error" &&
    state.canRetry &&
    state.errorContext === "download" &&
    state.availableVersion !== null
  ) {
    return "download";
  }
  return "none";
}

export function getUpdateButtonTooltip(state: UpdateState): string {
  if (state.status === "available") {
    return `Update ${state.availableVersion ?? "available"} ready to download`;
  }
  if (state.status === "downloading") {
    const progress =
      typeof state.downloadPercent === "number" ? ` (${Math.floor(state.downloadPercent)}%)` : "";
    return `Downloading update${progress}`;
  }
  if (state.status === "downloaded") {
    return `Update ${state.downloadedVersion ?? state.availableVersion ?? "ready"} ready to install`;
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return state.message
        ? `Download failed: ${state.message}. Click to retry.`
        : `Download failed for ${state.availableVersion}. Click to retry.`;
    }
    if (state.errorContext === "install" && state.downloadedVersion) {
      return state.message
        ? `Install failed: ${state.message}. Click to retry.`
        : `Install failed for ${state.downloadedVersion}. Click to retry.`;
    }
    return state.message ?? "Update failed";
  }
  if (state.status === "checking") {
    return "Checking for updates…";
  }
  return "Update available";
}

export function getUpdateReleaseUrl(version: string | null): string | null {
  if (!version) return null;
  const clean = version.trim().replace(/^v/i, "");
  if (!clean) return null;
  return `https://github.com/velusgautam/agentic-leash/releases/tag/v${encodeURIComponent(clean)}`;
}

export function canCheckForUpdate(state: UpdateState | null): boolean {
  if (!state || !state.enabled) return false;
  return (
    state.status !== "checking" &&
    state.status !== "downloading" &&
    state.status !== "downloaded"
  );
}
