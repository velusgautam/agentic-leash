import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { APP_NAME, leashDir } from "../shared/constants";
import { writtenBackups } from "./backup";
import { sweepAgentPath } from "./helperInstall";
import { LOGIN_AGENT_LABEL, loginAgentPath } from "./loginItem";

export type LeftoverOptions = { home: string; claudeRoot: string; userData: string; historyDir: string; systemHistory: string };

const ownHistoryFile = (name: string) => /^(history\.db(-wal|-shm|-journal|\.(optimize|backup)-\d+-\d+(-wal|-shm|-journal)?)?|helper\.log(\.1)?)$/.test(name);

function historyFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir);
  const ours = names.filter(ownHistoryFile);
  return [...ours.map((name) => join(dir, name)), ...(ours.length && ours.length === names.length ? [dir] : [])];
}

export function uninstallLeftoversForPlatform(options: LeftoverOptions & { platform?: string }): string[] {
  const platform = options.platform ?? process.platform;
  const home = options.home;
  const hermesHooks = join(home, ".hermes/agent-hooks");
  const hermesShared = existsSync(hermesHooks) && readdirSync(hermesHooks).some((name) => !name.startsWith("agentic-leash."));

  const common = [
    ...writtenBackups(home),
    join(hermesHooks, platform === "win32" ? "agentic-leash.cmd" : "agentic-leash.sh"),
    ...(hermesShared ? [] : [hermesHooks]),
    leashDir(home),
    options.userData,
    ...(options.historyDir === options.systemHistory ? [] : historyFiles(options.historyDir)),
  ];

  if (platform === "darwin") {
    const library = (path: string) => join(home, "Library", path);
    return [
      ...common,
      sweepAgentPath(home),
      loginAgentPath(home),
      library(`Logs/${APP_NAME}`),
      library(`Caches/${LOGIN_AGENT_LABEL}`),
      library(`Caches/${APP_NAME}`),
      library(`Preferences/${LOGIN_AGENT_LABEL}.plist`),
      library(`Saved Application State/${LOGIN_AGENT_LABEL}.savedState`),
      library(`HTTPStorages/${LOGIN_AGENT_LABEL}`),
    ];
  }

  if (platform === "linux") {
    return [
      ...common,
      join(home, ".config", "autostart", "agentic-leash.desktop"),
      join(home, ".config", "agentic-leash"),
      join(home, ".cache", "agentic-leash"),
      join(home, ".local", "share", "agentic-leash"),
    ];
  }

  if (platform === "win32") {
    const base = home.replace(/\//g, "\\");
    return [
      ...common,
      `${base}\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\agentic-leash.cmd`,
      `${base}\\AppData\\Roaming\\AgenticLeash`,
      `${base}\\AppData\\Local\\AgenticLeash`,
      `${base}\\AppData\\Local\\Programs\\AgenticLeash`,
    ];
  }

  return common;
}

export function uninstallLeftovers(options: LeftoverOptions): string[] {
  return uninstallLeftoversForPlatform(options);
}

export function removeLeftovers(paths: string[]): void {
  for (const path of paths) rmSync(path, { recursive: true, force: true });
}
