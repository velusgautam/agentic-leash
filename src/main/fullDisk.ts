import { closeSync, openSync, readSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(execFile);

// macOS 13+ pane id. There is no API that asks for Full Disk Access.
export const FULL_DISK_URL = "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles";
export const HELPER_PLIST_PATH = "/Library/LaunchDaemons/com.agenticleash.helper.plist";

/**
 * Accurately probes whether the current process has been granted macOS Full Disk Access.
 * On macOS, user TCC.db is often readable without FDA, leading to false positives.
 * Testing the system TCC database (/Library/Application Support/com.apple.TCC/TCC.db) reliably verifies true kTCCServiceSystemPolicyAllFiles.
 */
export function hasFullDiskAccess(probePath?: string): boolean {
  if (probePath) {
    let fd: number | undefined;
    try {
      fd = openSync(probePath, "r");
      readSync(fd, Buffer.alloc(1), 0, 1, 0);
      return true;
    } catch {
      return false;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  let fd: number | undefined;
  try {
    fd = openSync("/Library/Application Support/com.apple.TCC/TCC.db", "r");
    readSync(fd, Buffer.alloc(1), 0, 1, 0);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export type ExecFunction = (file: string, args: string[]) => Promise<{ stdout?: string; stderr?: string }>;

export async function openFullDiskAccess(
  execCmd: ExecFunction = (file, args) => execAsync(file, args),
): Promise<void> {
  await execCmd("/usr/bin/open", [FULL_DISK_URL]);
}

export async function pauseHelperDaemon(
  execCmd: ExecFunction = (file, args) => execAsync(file, args),
  plistPath: string = HELPER_PLIST_PATH,
): Promise<boolean> {
  try {
    await execCmd("/bin/launchctl", ["bootout", "system", plistPath]);
    return true;
  } catch {
    try {
      await execCmd("/usr/bin/sudo", ["-n", "/bin/launchctl", "bootout", "system", plistPath]);
      return true;
    } catch {
      return false;
    }
  }
}

export async function resumeHelperDaemon(
  execCmd: ExecFunction = (file, args) => execAsync(file, args),
  plistPath: string = HELPER_PLIST_PATH,
): Promise<boolean> {
  try {
    await execCmd("/bin/launchctl", ["bootstrap", "system", plistPath]);
    return true;
  } catch {
    try {
      await execCmd("/usr/bin/sudo", ["-n", "/bin/launchctl", "bootstrap", "system", plistPath]);
      return true;
    } catch {
      return false;
    }
  }
}

export interface FdaCoordinatorOptions {
  isMac?: boolean;
  tccDbPath?: string;
  isHelperRunning: () => Promise<boolean>;
  pauseHelper?: () => Promise<boolean>;
  resumeHelper?: () => Promise<boolean>;
  openSettings?: () => Promise<void>;
  checkFda?: () => boolean;
}

export class FdaHelperCoordinator {
  private paused = false;
  private isMac: boolean;
  private tccDbPath: string;
  private checkHelperRunning: () => Promise<boolean>;
  private pauseDaemon: () => Promise<boolean>;
  private resumeDaemon: () => Promise<boolean>;
  private openSettingsPane: () => Promise<void>;
  private checkAccess: () => boolean;

  constructor(options: FdaCoordinatorOptions) {
    this.isMac = options.isMac ?? (process.platform === "darwin");
    this.tccDbPath = options.tccDbPath ?? "";
    this.checkHelperRunning = options.isHelperRunning;
    this.pauseDaemon = options.pauseHelper ?? (() => pauseHelperDaemon());
    this.resumeDaemon = options.resumeHelper ?? (() => resumeHelperDaemon());
    this.openSettingsPane = options.openSettings ?? (() => openFullDiskAccess());
    this.checkAccess = options.checkFda ?? (() => (this.tccDbPath ? hasFullDiskAccess(this.tccDbPath) : hasFullDiskAccess()));
  }

  isPaused(): boolean {
    return this.paused;
  }

  async handleOpenFda(): Promise<void> {
    if (!this.isMac) {
      await this.openSettingsPane();
      return;
    }

    let running = false;
    try {
      running = await this.checkHelperRunning();
    } catch {
      running = false;
    }

    if (running) {
      try {
        await this.pauseDaemon();
        this.paused = true;
      } catch {
        /* ignore if not loaded */
      }
    }

    await this.openSettingsPane();
  }

  async handleUserReturn(): Promise<boolean> {
    if (!this.paused || !this.isMac) return false;

    try {
      await this.resumeDaemon();
    } catch {
      /* ignore */
    } finally {
      this.paused = false;
    }
    return true;
  }

  checkFdaStatus(): boolean {
    if (!this.isMac) return true;
    return this.checkAccess();
  }
}
