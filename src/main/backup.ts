import { copyFileSync, existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { leashDir } from "../shared/constants";
import { readJson } from "./agents/fs";

function backupLog(home?: string): string {
  return join(leashDir(home), "backups.json");
}

function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

export function writtenBackups(home?: string): string[] {
  const list = readJson(backupLog(home));
  return Array.isArray(list) ? list.filter((path): path is string => typeof path === "string" && path.endsWith(".bak") && isFile(path)) : [];
}

export function writeWithBackup(path: string, text: string): void {
  const backup = `${path}.bak`;
  const backedUp = existsSync(path);
  if (backedUp) copyFileSync(path, backup);
  writeFileSync(path, text);
  if (!backedUp) return;
  try {
    const written = writtenBackups();
    if (written.includes(backup)) return;
    mkdirSync(leashDir(), { recursive: true });
    writeFileSync(backupLog(), JSON.stringify([...written, backup]));
  } catch {}
}

export function backupTargets(home: string, claudeRoot: string): string[] {
  return [join(claudeRoot, "settings.json"), ...[".claude.json", ".cursor/hooks.json", ".cursor/cli-config.json", ".cursor/mcp.json", ".codex/hooks.json", ".gemini/settings.json", ".gemini/config/hooks.json", ".gemini/config/mcp_config.json", ".hermes/config.yaml"].map((path) => join(home, path))];
}

export function readTextJson(path: string): unknown {
  return readJson(path);
}
