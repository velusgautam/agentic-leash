import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { EsEvent } from "./proctree";

export interface RawLinuxEvent {
  time?: string;
  pid: number;
  ppid?: number;
  exe: string;
  type: "open" | "close_write" | "create" | "unlink" | "rename" | "exec" | "fork" | "exit";
  path?: string;
  destPath?: string;
  flags?: number;
  modified?: boolean;
}

export interface RawWindowsEvent {
  time?: string;
  pid: number;
  ppid?: number;
  image: string;
  type: "ProcessStart" | "ProcessStop" | "FileRead" | "FileWrite" | "FileCreate" | "FileDelete" | "FileRename";
  path?: string;
  destPath?: string;
  modified?: boolean;
}

/**
 * Normalizes a raw Linux kernel event (from fanotify + netlink or eBPF)
 * into the standard EsEvent schema consumed by ProcTree and classify().
 */
export function formatLinuxEvent(raw: RawLinuxEvent): EsEvent {
  const time = raw.time ?? new Date().toISOString();
  const process = {
    audit_token: { pid: raw.pid },
    ppid: raw.ppid,
    executable: { path: raw.exe },
  };

  const event: Record<string, unknown> = {};

  switch (raw.type) {
    case "open":
      // flags & 2 (O_WRONLY/O_RDWR) - if 0, it's read
      event.open = {
        file: { path: raw.path },
        fflag: raw.flags ?? 0,
      };
      break;
    case "close_write":
      event.close = {
        modified: true,
        target: { path: raw.path },
      };
      break;
    case "create":
      event.create = {
        destination: { existing_file: { path: raw.path } },
      };
      break;
    case "unlink":
      event.unlink = {
        target: { path: raw.path },
      };
      break;
    case "rename":
      event.rename = {
        source: { path: raw.path },
        destination: { existing_file: { path: raw.destPath } },
      };
      break;
    case "exec":
      event.exec = {
        target: {
          executable: { path: raw.path ?? raw.exe },
          audit_token: { pid: raw.pid },
          ppid: raw.ppid,
        },
      };
      break;
    case "fork":
      event.fork = {
        child: {
          audit_token: { pid: raw.pid },
          ppid: raw.ppid,
          executable: { path: raw.exe },
        },
      };
      break;
    case "exit":
      event.exit = {
        stat: 0,
      };
      break;
  }

  return { time, process, event };
}

/**
 * Normalizes a raw Windows ETW / Sysmon event into the standard EsEvent schema.
 */
export function formatWindowsEvent(raw: RawWindowsEvent): EsEvent {
  const time = raw.time ?? new Date().toISOString();
  // Standardize Windows path slashes for consistency if needed, but preserve drive letter
  const exe = raw.image.replace(/\\/g, "/");
  const path = raw.path;
  const destPath = raw.destPath;

  const process = {
    audit_token: { pid: raw.pid },
    ppid: raw.ppid,
    executable: { path: exe },
  };

  const event: Record<string, unknown> = {};

  switch (raw.type) {
    case "ProcessStart":
      event.exec = {
        target: {
          executable: { path: exe },
          audit_token: { pid: raw.pid },
          ppid: raw.ppid,
        },
      };
      break;
    case "ProcessStop":
      event.exit = {
        stat: 0,
      };
      break;
    case "FileRead":
      event.open = {
        file: { path },
        fflag: 0,
      };
      break;
    case "FileWrite":
      event.close = {
        modified: true,
        target: { path },
      };
      break;
    case "FileCreate":
      event.create = {
        destination: { existing_file: { path } },
      };
      break;
    case "FileDelete":
      event.unlink = {
        target: { path },
      };
      break;
    case "FileRename":
      event.rename = {
        source: { path },
        destination: { existing_file: { path: destPath } },
      };
      break;
  }

  return { time, process, event };
}

export interface SystemTracker {
  start(onLine: (line: string) => void, onError?: (err: Error) => void, onExit?: () => void): void;
  stop(): void;
}

export interface TrackerOptions {
  platform?: string;
  command?: string;
  events?: string[];
}

export const MAC_EVENTS = ["open", "close", "create", "unlink", "rename", "exec", "fork", "exit"];

export class EsloggerTracker implements SystemTracker {
  private child: ChildProcess | null = null;
  private rl: Interface | null = null;

  constructor(private readonly command = "/usr/bin/eslogger", private readonly events = MAC_EVENTS) {}

  start(onLine: (line: string) => void, onError?: (err: Error) => void, onExit?: () => void): void {
    this.child = spawn(this.command, this.events, { stdio: ["ignore", "pipe", "pipe"] });
    if (onError) {
      this.child.on("error", onError);
    }
    if (onExit) {
      this.child.on("exit", onExit);
    }
    if (this.child.stdout) {
      this.rl = createInterface({ input: this.child.stdout });
      this.rl.on("line", onLine);
    }
  }

  stop(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.child) {
      this.child.kill("SIGKILL");
      this.child = null;
    }
  }
}

export class LinuxTracker implements SystemTracker {
  private child: ChildProcess | null = null;
  private rl: Interface | null = null;

  constructor(private readonly command = "leash-tracker-linux") {}

  start(onLine: (line: string) => void, onError?: (err: Error) => void, onExit?: () => void): void {
    try {
      this.child = spawn(this.command, [], { stdio: ["ignore", "pipe", "pipe"] });
      if (onError) {
        this.child.on("error", onError);
      }
      if (onExit) {
        this.child.on("exit", onExit);
      }
      if (this.child.stdout) {
        this.rl = createInterface({ input: this.child.stdout });
        this.rl.on("line", onLine);
      }
    } catch (err) {
      if (onError && err instanceof Error) onError(err);
    }
  }

  stop(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.child) {
      this.child.kill("SIGTERM");
      this.child = null;
    }
  }
}

export class WindowsTracker implements SystemTracker {
  private child: ChildProcess | null = null;
  private rl: Interface | null = null;

  constructor(private readonly command = "leash-tracker-win.exe") {}

  start(onLine: (line: string) => void, onError?: (err: Error) => void, onExit?: () => void): void {
    try {
      this.child = spawn(this.command, [], { stdio: ["ignore", "pipe", "pipe"] });
      if (onError) {
        this.child.on("error", onError);
      }
      if (onExit) {
        this.child.on("exit", onExit);
      }
      if (this.child.stdout) {
        this.rl = createInterface({ input: this.child.stdout });
        this.rl.on("line", onLine);
      }
    } catch (err) {
      if (onError && err instanceof Error) onError(err);
    }
  }

  stop(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }
}

export function createTracker(options: TrackerOptions = {}): SystemTracker {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    return new EsloggerTracker(options.command, options.events ?? MAC_EVENTS);
  }
  if (platform === "linux") {
    return new LinuxTracker(options.command);
  }
  if (platform === "win32") {
    return new WindowsTracker(options.command);
  }
  return new EsloggerTracker(options.command, options.events);
}
