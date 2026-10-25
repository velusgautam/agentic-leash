import { describe, expect, it, vi } from "vitest";
import { startUpdater, type UpdaterDriver } from "../../src/main/updater";
import {
  canCheckForUpdate,
  createInitialUpdateState,
  getAutoUpdateDisabledReason,
  getUpdateButtonTooltip,
  getUpdateReleaseUrl,
  reduceUpdateOnAvailable,
  reduceUpdateOnCheckFailure,
  reduceUpdateOnCheckStart,
  reduceUpdateOnDownloadComplete,
  reduceUpdateOnDownloadFailure,
  reduceUpdateOnDownloadProgress,
  reduceUpdateOnDownloadStart,
  reduceUpdateOnInstallFailure,
  reduceUpdateOnNoUpdate,
  resolveUpdateButtonAction,
  shouldBroadcastDownloadProgress,
} from "../../src/shared/updater";

function makeMockDriver() {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const driver: UpdaterDriver & { emit: (event: string, ...args: unknown[]) => void } = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checkForUpdates: vi.fn(async () => undefined),
    downloadUpdate: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(),
    on: (event, listener) => {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return driver;
    },
    emit: (event, ...args) => {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args);
      }
    },
  };
  return driver;
}

describe("updater state machine", () => {
  it("tracks check, availability, download progress, and install readiness", () => {
    let state = createInitialUpdateState("0.3.0");
    expect(state.enabled).toBe(true);
    expect(state.status).toBe("idle");
    expect(canCheckForUpdate(state)).toBe(true);

    state = reduceUpdateOnCheckStart(state, 100);
    expect(state.status).toBe("checking");
    expect(canCheckForUpdate(state)).toBe(false);

    state = reduceUpdateOnAvailable(state, "0.4.0", 200);
    expect(state.status).toBe("available");
    expect(state.availableVersion).toBe("0.4.0");
    expect(resolveUpdateButtonAction(state)).toBe("download");
    expect(getUpdateButtonTooltip(state)).toBe("Update 0.4.0 ready to download");

    state = reduceUpdateOnDownloadStart(state);
    expect(state.status).toBe("downloading");
    expect(state.downloadPercent).toBe(0);

    expect(shouldBroadcastDownloadProgress(state, 5)).toBe(false);
    expect(shouldBroadcastDownloadProgress(state, 12)).toBe(true);
    state = reduceUpdateOnDownloadProgress(state, 42.8);
    expect(getUpdateButtonTooltip(state)).toBe("Downloading update (42%)");

    state = reduceUpdateOnDownloadComplete(state, "0.4.0");
    expect(state.status).toBe("downloaded");
    expect(state.downloadedVersion).toBe("0.4.0");
    expect(resolveUpdateButtonAction(state)).toBe("install");
    expect(getUpdateButtonTooltip(state)).toBe("Update 0.4.0 ready to install");
  });

  it("preserves a downloaded update across subsequent checks and failures", () => {
    let state = createInitialUpdateState("0.3.0");
    state = reduceUpdateOnDownloadComplete(state, "0.4.0");
    state = reduceUpdateOnCheckStart(state, 300);
    expect(state.downloadedVersion).toBe("0.4.0");
    expect(state.downloadPercent).toBe(100);

    state = reduceUpdateOnCheckFailure(state, "Offline", 400);
    expect(state.status).toBe("downloaded");
    expect(resolveUpdateButtonAction(state)).toBe("install");

    state = reduceUpdateOnNoUpdate(state, 500);
    expect(state.status).toBe("downloaded");
    expect(state.availableVersion).toBe("0.4.0");
  });

  it("recovers cleanly from download and install errors", () => {
    let state = reduceUpdateOnAvailable(createInitialUpdateState("0.3.0"), "0.4.0", 100);
    state = reduceUpdateOnDownloadStart(state);
    state = reduceUpdateOnDownloadFailure(state, "Network dropped");
    expect(state.status).toBe("available");
    expect(state.canRetry).toBe(true);
    expect(resolveUpdateButtonAction(state)).toBe("download");

    state = reduceUpdateOnDownloadComplete(state, "0.4.0");
    state = reduceUpdateOnInstallFailure(state, "Permission denied");
    expect(state.status).toBe("downloaded");
    expect(state.errorContext).toBe("install");
    expect(resolveUpdateButtonAction(state)).toBe("install");
  });

  it("computes release URLs and disabled reasons", () => {
    expect(getUpdateReleaseUrl("0.4.0")).toBe("https://github.com/velusgautam/agentic-leash/releases/tag/v0.4.0");
    expect(getUpdateReleaseUrl("v0.4.0")).toBe("https://github.com/velusgautam/agentic-leash/releases/tag/v0.4.0");
    expect(getUpdateReleaseUrl(null)).toBeNull();

    expect(
      getAutoUpdateDisabledReason({
        isPackaged: false,
        platform: "darwin",
        disabledByEnv: false,
        hasUpdateFeedConfig: true,
      }),
    ).toContain("packaged builds");

    expect(
      getAutoUpdateDisabledReason({
        isPackaged: true,
        platform: "darwin",
        disabledByEnv: true,
        hasUpdateFeedConfig: true,
      }),
    ).toContain("AGENTIC_LEASH_DISABLE_AUTO_UPDATE");

    expect(
      getAutoUpdateDisabledReason({
        isPackaged: true,
        platform: "linux",
        disabledByEnv: false,
        hasUpdateFeedConfig: true,
      }),
    ).toContain("AppImage");
  });
});

describe("startUpdater controller", () => {
  it("checks for updates, notifies once per version, downloads, and calls prepareQuit before quitAndInstall", async () => {
    const driver = makeMockDriver();
    const broadcasts: [string, unknown][] = [];
    const notified: string[] = [];
    let quitPrepared = false;

    const controller = startUpdater({
      currentVersion: "0.3.0",
      isPackaged: true,
      resourcesPath: "/tmp",
      platform: "darwin",
      env: { AGENTIC_LEASH_MOCK_UPDATES: "1" },
      broadcast: (channel, payload) => broadcasts.push([channel, payload]),
      prepareQuit: () => {
        quitPrepared = true;
      },
      notifyAvailable: (version) => notified.push(version),
      driver,
      startupDelayMs: 60_000,
      pollIntervalMs: 60_000,
    });

    try {
      expect(driver.autoDownload).toBe(false);
      expect(driver.autoInstallOnAppQuit).toBe(false);

      driver.checkForUpdates = vi.fn(async () => {
        driver.emit("update-available", { version: "0.4.0" });
      });

      const checkResult = await controller.check();
      expect(checkResult.checked).toBe(true);
      expect(checkResult.state.status).toBe("available");
      expect(checkResult.state.availableVersion).toBe("0.4.0");
      expect(notified).toEqual(["0.4.0"]);

      // Second check for same version does not duplicate notification
      await controller.check();
      expect(notified).toEqual(["0.4.0"]);

      driver.downloadUpdate = vi.fn(async () => {
        driver.emit("download-progress", { percent: 55 });
        driver.emit("update-downloaded", { version: "0.4.0" });
      });

      const dlResult = await controller.download();
      expect(dlResult.accepted).toBe(true);
      expect(dlResult.completed).toBe(true);
      expect(dlResult.state.status).toBe("downloaded");

      const installResult = await controller.install();
      expect(installResult.accepted).toBe(true);
      expect(quitPrepared).toBe(true);
      expect(driver.quitAndInstall).toHaveBeenCalledWith(true, true);
      expect(broadcasts.length).toBeGreaterThan(0);
    } finally {
      controller.stop();
    }
  });
});
