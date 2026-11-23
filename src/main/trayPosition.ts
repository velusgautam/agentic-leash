import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const TRAY_AUTOSAVE_NAME = "com.agenticleash.tray";
export const DEFAULT_TRAY_PREFERRED_POSITION = 120;
const DEFAULT_BUNDLE_ID = "com.agenticleash.app";
const DEFAULTS_BIN = "/usr/bin/defaults";
const DEFAULTS_TIMEOUT_MS = 2000;

export interface TrayDefaultsRunner {
  read(domain: string, key: string): Promise<string | null>;
  writeFloat(domain: string, key: string, value: number): Promise<void>;
}

export interface TrayPositionOptions {
  platform?: string;
  bundleId?: string;
  position?: number;
  runner?: TrayDefaultsRunner;
}

function preferredPositionKey(): string {
  return `NSStatusItem Preferred Position ${TRAY_AUTOSAVE_NAME}`;
}

export function createDefaultsRunner(): TrayDefaultsRunner {
  return {
    async read(domain: string, key: string): Promise<string | null> {
      try {
        const { stdout } = await execFileAsync(DEFAULTS_BIN, ["read", domain, key], {
          timeout: DEFAULTS_TIMEOUT_MS,
        });
        const trimmed = stdout.trim();
        return trimmed.length > 0 ? trimmed : null;
      } catch {
        return null;
      }
    },
    async writeFloat(domain: string, key: string, value: number): Promise<void> {
      await execFileAsync(DEFAULTS_BIN, ["write", domain, key, "-float", String(value)], {
        timeout: DEFAULTS_TIMEOUT_MS,
      });
    },
  };
}

/**
 * Enables macOS NSStatusItem autosave so the tray icon keeps its menu bar
 * position across restarts. Best-effort: never throws.
 */
export function applyTrayAutosave(tray: { setAutosaveName?: (name: string) => void } | object): boolean {
  try {
    const candidate = tray as { setAutosaveName?: unknown };
    if (typeof candidate.setAutosaveName !== "function") return false;
    (candidate.setAutosaveName as (name: string) => void)(TRAY_AUTOSAVE_NAME);
    return true;
  } catch {
    return false;
  }
}

/**
 * On first launch on macOS, seeds NSStatusItem Preferred Position so the tray
 * icon starts on the right side of the menu bar (clear of the MacBook notch).
 * Never overwrites an existing user-configured position.
 */
export async function seedTrayPreferredPosition(opts?: TrayPositionOptions): Promise<boolean> {
  if ((opts?.platform ?? process.platform) !== "darwin") return false;
  const domain = opts?.bundleId ?? DEFAULT_BUNDLE_ID;
  const key = preferredPositionKey();
  const position = opts?.position ?? DEFAULT_TRAY_PREFERRED_POSITION;
  const runner = opts?.runner ?? createDefaultsRunner();
  try {
    const existing = await runner.read(domain, key);
    if (existing !== null) return false;
    await runner.writeFloat(domain, key, position);
    return true;
  } catch {
    return false;
  }
}

/**
 * Unconditionally writes NSStatusItem Preferred Position on macOS so a user
 * can re-pin the tray icon from Settings.
 */
export async function resetTrayPosition(opts?: TrayPositionOptions): Promise<boolean> {
  if ((opts?.platform ?? process.platform) !== "darwin") return false;
  const domain = opts?.bundleId ?? DEFAULT_BUNDLE_ID;
  const key = preferredPositionKey();
  const position = opts?.position ?? DEFAULT_TRAY_PREFERRED_POSITION;
  const runner = opts?.runner ?? createDefaultsRunner();
  try {
    await runner.writeFloat(domain, key, position);
    return true;
  } catch {
    return false;
  }
}
