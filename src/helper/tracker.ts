import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

export { collapseRecursiveReads } from "./historyDb";

export interface SystemTracker {
  start(onLine: (line: string) => void, onError?: (err: Error) => void, onExit?: () => void): void;
  stop(): void;
}

export interface TrackerOptions {
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
    if (this.child.stderr) {
      let errBuf = "";
      this.child.stderr.on("data", (chunk) => {
        errBuf += chunk.toString();
      });
      this.child.on("exit", (code) => {
        if (code !== 0 && code !== null && onError && errBuf.trim()) {
          onError(new Error(`${this.command} exited with code ${code}: ${errBuf.trim()}`));
        }
        if (onExit) {
          onExit();
        }
      });
    } else if (onExit) {
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

export function createTracker(options: TrackerOptions = {}): SystemTracker {
  return new EsloggerTracker(options.command, options.events ?? MAC_EVENTS);
}
