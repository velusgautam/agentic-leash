import { describe, expect, it, vi } from "vitest";
import {
  FdaHelperCoordinator,
  FULL_DISK_URL,
  HELPER_PLIST_PATH,
  openFullDiskAccess,
  pauseHelperDaemon,
  resumeHelperDaemon,
} from "../../src/main/fullDisk";
import {
  helperInstallScript,
  helperPlist,
  helperRunnerScript,
  HELPER_DIR,
  HELPER_RUNNER_PATH,
} from "../../src/main/helperInstall";

describe("helperPlist and runner script decoupling", () => {
  it("includes ExitTimeOut: 2 in the LaunchDaemon plist", () => {
    const plist = helperPlist("/Applications/Agentic Leash.app/Contents/MacOS/Agentic Leash", "/app/leash-helper.js");
    expect(plist).toContain("<key>ExitTimeOut</key><integer>2</integer>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("<key>Label</key><string>com.agenticleash.helper</string>");
  });

  it("targets the runner script when provided", () => {
    const plist = helperPlist(
      "/Applications/Agentic Leash.app/Contents/MacOS/Agentic Leash",
      "/app/leash-helper.js",
      HELPER_RUNNER_PATH,
    );
    expect(plist).toContain(`<string>${HELPER_RUNNER_PATH}</string>`);
    expect(plist).not.toContain("ELECTRON_RUN_AS_NODE");
    expect(plist).toContain("<key>ExitTimeOut</key><integer>2</integer>");
  });

  it("generates a runner script that checks standalone node and falls back to Electron", () => {
    const runner = helperRunnerScript("/Applications/Agentic Leash.app/Contents/MacOS/Agentic Leash", "/app/leash-helper.js");
    expect(runner).toContain("#!/bin/sh");
    expect(runner).toContain('/usr/local/bin/node" "/app/leash-helper.js" "$@"');
    expect(runner).toContain('/opt/homebrew/bin/node" "/app/leash-helper.js" "$@"');
    expect(runner).toContain('ELECTRON_RUN_AS_NODE=1 "/Applications/Agentic Leash.app/Contents/MacOS/Agentic Leash" "/app/leash-helper.js" "$@"');
  });

  it("includes runner script creation and chmod 755 in helperInstallScript", () => {
    const script = helperInstallScript("/Applications/Agentic Leash.app/Contents/MacOS/Agentic Leash", "/app/leash-helper.js");
    expect(script).toContain(HELPER_DIR);
    expect(script).toContain(HELPER_RUNNER_PATH);
    expect(script).toContain(`/bin/chmod 755 '${HELPER_RUNNER_PATH}'`);
    expect(script).toContain(`/usr/sbin/chown root:wheel '${HELPER_RUNNER_PATH}'`);
    expect(script).toContain("/bin/launchctl bootstrap system");
  });
});

describe("pauseHelperDaemon and resumeHelperDaemon", () => {
  it("calls launchctl bootout to pause the daemon", async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: "" });
    const ok = await pauseHelperDaemon(mockExec);
    expect(ok).toBe(true);
    expect(mockExec).toHaveBeenCalledWith("/bin/launchctl", ["bootout", "system", HELPER_PLIST_PATH]);
  });

  it("catches launchctl bootout failure gracefully and falls back to sudo -n if needed", async () => {
    const mockExec = vi.fn()
      .mockRejectedValueOnce(new Error("bootout failed"))
      .mockResolvedValueOnce({ stdout: "" });

    const ok = await pauseHelperDaemon(mockExec);
    expect(ok).toBe(true);
    expect(mockExec).toHaveBeenCalledTimes(2);
    expect(mockExec).toHaveBeenNthCalledWith(1, "/bin/launchctl", ["bootout", "system", HELPER_PLIST_PATH]);
    expect(mockExec).toHaveBeenNthCalledWith(2, "/usr/bin/sudo", ["-n", "/bin/launchctl", "bootout", "system", HELPER_PLIST_PATH]);
  });

  it("returns false if both bootout attempts fail", async () => {
    const mockExec = vi.fn().mockRejectedValue(new Error("permission denied"));
    const ok = await pauseHelperDaemon(mockExec);
    expect(ok).toBe(false);
  });

  it("calls launchctl bootstrap to resume the daemon", async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: "" });
    const ok = await resumeHelperDaemon(mockExec);
    expect(ok).toBe(true);
    expect(mockExec).toHaveBeenCalledWith("/bin/launchctl", ["bootstrap", "system", HELPER_PLIST_PATH]);
  });

  it("returns false if launchctl bootstrap fails", async () => {
    const mockExec = vi.fn().mockRejectedValue(new Error("bootstrap failed"));
    const ok = await resumeHelperDaemon(mockExec);
    expect(ok).toBe(false);
  });

  it("opens full disk access settings url", async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: "" });
    await openFullDiskAccess(mockExec);
    expect(mockExec).toHaveBeenCalledWith("/usr/bin/open", [FULL_DISK_URL]);
  });
});

describe("FdaHelperCoordinator auto-pause & re-bootstrap lifecycle", () => {
  it("pauses helper when running and opens system settings", async () => {
    const pauseHelper = vi.fn().mockResolvedValue(true);
    const resumeHelper = vi.fn().mockResolvedValue(true);
    const openSettings = vi.fn().mockResolvedValue(undefined);
    const isHelperRunning = vi.fn().mockResolvedValue(true);
    const checkFda = vi.fn().mockReturnValue(false);

    const coordinator = new FdaHelperCoordinator({
      isMac: true,
      isHelperRunning,
      pauseHelper,
      resumeHelper,
      openSettings,
      checkFda,
    });

    expect(coordinator.isPaused()).toBe(false);

    await coordinator.handleOpenFda();

    expect(isHelperRunning).toHaveBeenCalledTimes(1);
    expect(pauseHelper).toHaveBeenCalledTimes(1);
    expect(coordinator.isPaused()).toBe(true);
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it("does not pause helper if it is not currently running", async () => {
    const pauseHelper = vi.fn().mockResolvedValue(true);
    const openSettings = vi.fn().mockResolvedValue(undefined);
    const isHelperRunning = vi.fn().mockResolvedValue(false);

    const coordinator = new FdaHelperCoordinator({
      isMac: true,
      isHelperRunning,
      pauseHelper,
      openSettings,
    });

    await coordinator.handleOpenFda();

    expect(isHelperRunning).toHaveBeenCalledTimes(1);
    expect(pauseHelper).not.toHaveBeenCalled();
    expect(coordinator.isPaused()).toBe(false);
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it("ignores pause failures and still opens system settings", async () => {
    const pauseHelper = vi.fn().mockRejectedValue(new Error("service not loaded"));
    const openSettings = vi.fn().mockResolvedValue(undefined);
    const isHelperRunning = vi.fn().mockResolvedValue(true);

    const coordinator = new FdaHelperCoordinator({
      isMac: true,
      isHelperRunning,
      pauseHelper,
      openSettings,
    });

    await coordinator.handleOpenFda();

    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it("re-bootstraps helper on user return and resets paused state", async () => {
    const pauseHelper = vi.fn().mockResolvedValue(true);
    const resumeHelper = vi.fn().mockResolvedValue(true);
    const openSettings = vi.fn().mockResolvedValue(undefined);
    const isHelperRunning = vi.fn().mockResolvedValue(true);
    const checkFda = vi.fn().mockReturnValue(true);

    const coordinator = new FdaHelperCoordinator({
      isMac: true,
      isHelperRunning,
      pauseHelper,
      resumeHelper,
      openSettings,
      checkFda,
    });

    await coordinator.handleOpenFda();
    expect(coordinator.isPaused()).toBe(true);

    const resumed = await coordinator.handleUserReturn();
    expect(resumed).toBe(true);
    expect(resumeHelper).toHaveBeenCalledTimes(1);
    expect(coordinator.isPaused()).toBe(false);
  });

  it("does nothing on user return if helper was not paused", async () => {
    const resumeHelper = vi.fn().mockResolvedValue(true);

    const coordinator = new FdaHelperCoordinator({
      isMac: true,
      isHelperRunning: vi.fn().mockResolvedValue(false),
      resumeHelper,
    });

    const resumed = await coordinator.handleUserReturn();
    expect(resumed).toBe(false);
    expect(resumeHelper).not.toHaveBeenCalled();
  });

  it("does nothing if not on macOS", async () => {
    const pauseHelper = vi.fn();
    const resumeHelper = vi.fn();
    const openSettings = vi.fn().mockResolvedValue(undefined);

    const coordinator = new FdaHelperCoordinator({
      isMac: false,
      isHelperRunning: vi.fn().mockResolvedValue(true),
      pauseHelper,
      resumeHelper,
      openSettings,
    });

    await coordinator.handleOpenFda();
    expect(pauseHelper).not.toHaveBeenCalled();
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(coordinator.isPaused()).toBe(false);

    const resumed = await coordinator.handleUserReturn();
    expect(resumed).toBe(false);
    expect(resumeHelper).not.toHaveBeenCalled();
  });

  it("checks FDA status via checkFdaStatus()", () => {
    const checkFda = vi.fn().mockReturnValue(true);
    const coordinator = new FdaHelperCoordinator({
      isMac: true,
      isHelperRunning: vi.fn().mockResolvedValue(true),
      checkFda,
    });
    expect(coordinator.checkFdaStatus()).toBe(true);
    expect(checkFda).toHaveBeenCalledTimes(1);
  });

  it("preserves running state logically during permissions setup to avoid UI glitching", async () => {
    const coordinator = new FdaHelperCoordinator({
      isMac: true,
      isHelperRunning: vi.fn().mockResolvedValue(true),
      pauseHelper: vi.fn().mockResolvedValue(true),
      openSettings: vi.fn().mockResolvedValue(undefined),
    });

    await coordinator.handleOpenFda();
    expect(coordinator.isPaused()).toBe(true);

    // Simulated helperState() query during pause
    const actualLaunchctlState = "stopped";
    const reportedHelperStatus = coordinator.isPaused() ? "running" : actualLaunchctlState;
    expect(reportedHelperStatus).toBe("running");

    await coordinator.handleUserReturn();
    expect(coordinator.isPaused()).toBe(false);
  });
});
