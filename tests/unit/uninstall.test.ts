import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backupTargets, writeWithBackup, writtenBackups } from "../../src/main/backup";
import { mergeHermesConfig, removeHermesConfig } from "../../src/main/hermesHooks";
import { mergeAntigravityHooks, mergeClaudeHooks, mergeCodexHooks, mergeCursorHooks, mergeGeminiHooks, removeAntigravityHooks, removeClaudeHooks, removeCodexHooks, removeCursorHooks, removeGeminiHooks } from "../../src/main/hookInstall";
import { removeLeftovers, uninstallLeftovers } from "../../src/main/uninstall";

const COMMAND = "ELECTRON_RUN_AS_NODE=1 /app/leash leash-hook.js";

function seed(path: string, text = "x"): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

afterEach(() => vi.unstubAllEnvs());

function setup() {
  const root = mkdtempSync(join(tmpdir(), "al-uninstall-"));
  const home = join(root, "home");
  const claudeRoot = join(home, ".claude");
  const userData = join(home, "Library/Application Support/Agentic Leash");
  const systemHistory = join(root, "system-history");
  vi.stubEnv("AGENTIC_LEASH_HOME", home);
  return { root, home, claudeRoot, userData, systemHistory };
}

describe("backupTargets", () => {
  it("lists every file the app writes with a backup", () => {
    expect(backupTargets("/h", "/c")).toEqual([
      "/c/settings.json",
      "/h/.claude.json",
      "/h/.cursor/hooks.json",
      "/h/.cursor/cli-config.json",
      "/h/.cursor/mcp.json",
      "/h/.codex/hooks.json",
      "/h/.gemini/settings.json",
      "/h/.gemini/config/hooks.json",
      "/h/.gemini/config/mcp_config.json",
      "/h/.hermes/config.yaml",
    ]);
  });

  it("is reviewed whenever a writeWithBackup caller is added", () => {
    const out = execFileSync("grep", ["-rn", "writeWithBackup(", join(__dirname, "../../src/main")], { encoding: "utf8" });
    const callers = out.trim().split("\n").filter((line) => !line.includes("export function writeWithBackup"));
    expect(callers).toHaveLength(8);
  });
});

describe("uninstallLeftovers", () => {
  it("lists backups, hook scripts, launch agents, app data, and macOS app files", () => {
    const { home, claudeRoot, userData, systemHistory } = setup();
    const historyDir = join(home, "dev-history");
    const paths = uninstallLeftovers({ home, claudeRoot, userData, historyDir, systemHistory });
    expect(paths).not.toContain(historyDir);
    expect(paths).toEqual(expect.arrayContaining([
      join(home, ".hermes/agent-hooks/agentic-leash.sh"),
      join(home, ".hermes/agent-hooks"),
      join(home, "Library/LaunchAgents/com.agenticleash.sweep.plist"),
      join(home, "Library/LaunchAgents/com.agenticleash.app.plist"),
      join(home, ".agentic-leash"),
      userData,
      join(home, "Library/Logs/Agentic Leash"),
      join(home, "Library/Caches/com.agenticleash.app"),
      join(home, "Library/Caches/Agentic Leash"),
      join(home, "Library/Preferences/com.agenticleash.app.plist"),
      join(home, "Library/Saved Application State/com.agenticleash.app.savedState"),
      join(home, "Library/HTTPStorages/com.agenticleash.app"),
    ]));
    for (const target of backupTargets(home, claudeRoot)) expect(paths).not.toContain(target);
  });

  it("leaves the root-owned system history to the helper uninstall", () => {
    const { home, claudeRoot, userData, systemHistory } = setup();
    expect(uninstallLeftovers({ home, claudeRoot, userData, historyDir: systemHistory, systemHistory })).not.toContain(systemHistory);
  });

  it("keeps the Hermes agent-hooks dir when other hooks live there", () => {
    const { home, claudeRoot, userData, systemHistory } = setup();
    seed(join(home, ".hermes/agent-hooks/agentic-leash.sh"));
    seed(join(home, ".hermes/agent-hooks/other.sh"));
    const paths = uninstallLeftovers({ home, claudeRoot, userData, historyDir: systemHistory, systemHistory });
    expect(paths).toContain(join(home, ".hermes/agent-hooks/agentic-leash.sh"));
    expect(paths).not.toContain(join(home, ".hermes/agent-hooks"));
  });
});

describe("removeLeftovers", () => {
  it("removes every leftover and keeps agent configs with only our hooks stripped", () => {
    const { home, claudeRoot, userData, systemHistory } = setup();
    const historyDir = join(home, "dev-history");
    const hooks = { claude: join(claudeRoot, "settings.json"), cursor: join(home, ".cursor/hooks.json"), codex: join(home, ".codex/hooks.json"), gemini: join(home, ".gemini/settings.json"), antigravity: join(home, ".gemini/config/hooks.json") };
    const hermes = join(home, ".hermes/config.yaml");
    seed(hooks.claude, JSON.stringify(mergeClaudeHooks({ model: "opus" }, COMMAND)));
    seed(hooks.cursor, JSON.stringify(mergeCursorHooks({ version: 1 }, COMMAND)));
    seed(hooks.codex, JSON.stringify(mergeCodexHooks({ keep: true }, COMMAND)));
    seed(hooks.gemini, JSON.stringify(mergeGeminiHooks({ theme: "dark" }, COMMAND)));
    seed(hooks.antigravity, JSON.stringify(mergeAntigravityHooks({ custom: { PostToolUse: [] } }, COMMAND)));
    seed(hermes, mergeHermesConfig("model: x\n", join(home, ".hermes/agent-hooks/agentic-leash.sh")));
    for (const path of ["Library/LaunchAgents/com.agenticleash.sweep.plist", "Library/LaunchAgents/com.agenticleash.app.plist", ".agentic-leash/grants.db", ".hermes/agent-hooks/agentic-leash.sh", "Library/Logs/Agentic Leash/main.log", "Library/Caches/com.agenticleash.app/Cache.db", "Library/Caches/Agentic Leash/data", "Library/Preferences/com.agenticleash.app.plist", "Library/Saved Application State/com.agenticleash.app.savedState/data.data", "Library/HTTPStorages/com.agenticleash.app/httpstorages.sqlite", "dev-history/history.db"]) seed(join(home, path));
    seed(join(userData, "ui-state.json"));

    writeWithBackup(hooks.claude, JSON.stringify(removeClaudeHooks(JSON.parse(readFileSync(hooks.claude, "utf8")))));
    writeWithBackup(hooks.cursor, JSON.stringify(removeCursorHooks(JSON.parse(readFileSync(hooks.cursor, "utf8")))));
    writeWithBackup(hooks.codex, JSON.stringify(removeCodexHooks(JSON.parse(readFileSync(hooks.codex, "utf8")))));
    writeWithBackup(hooks.gemini, JSON.stringify(removeGeminiHooks(JSON.parse(readFileSync(hooks.gemini, "utf8")))));
    writeWithBackup(hooks.antigravity, JSON.stringify(removeAntigravityHooks(JSON.parse(readFileSync(hooks.antigravity, "utf8")))));
    writeWithBackup(hermes, removeHermesConfig(readFileSync(hermes, "utf8")));
    const paths = uninstallLeftovers({ home, claudeRoot, userData, historyDir, systemHistory });
    expect(paths).toContain(`${hooks.claude}.bak`);
    removeLeftovers(paths);

    for (const path of paths) expect(existsSync(path), path).toBe(false);
    expect(existsSync(historyDir)).toBe(false);
    expect(JSON.parse(readFileSync(hooks.claude, "utf8")).model).toBe("opus");
    expect(readFileSync(hooks.claude, "utf8")).not.toContain(COMMAND);
    expect(JSON.parse(readFileSync(hooks.cursor, "utf8")).version).toBe(1);
    expect(readFileSync(hooks.cursor, "utf8")).not.toContain(COMMAND);
    expect(JSON.parse(readFileSync(hooks.codex, "utf8")).keep).toBe(true);
    expect(readFileSync(hooks.codex, "utf8")).not.toContain(COMMAND);
    expect(JSON.parse(readFileSync(hooks.gemini, "utf8")).theme).toBe("dark");
    expect(readFileSync(hooks.gemini, "utf8")).not.toContain(COMMAND);
    expect(JSON.parse(readFileSync(hooks.antigravity, "utf8")).custom).toEqual({ PostToolUse: [] });
    expect(readFileSync(hooks.antigravity, "utf8")).not.toContain(COMMAND);
    expect(readFileSync(hermes, "utf8")).toBe("model: x\n");
    expect(existsSync(join(home, ".hermes"))).toBe(true);
  });

  it("only removes the files the app created in a custom history dir", () => {
    const { home, claudeRoot, userData, systemHistory } = setup();
    const historyDir = join(home, "work");
    const ours = ["history.db", "history.db-wal", "history.db-shm", "history.db-journal", "history.db.optimize-1-2", "history.db.optimize-1-2-wal", "history.db.backup-1-2", "helper.log", "helper.log.1"];
    for (const name of ours) seed(join(historyDir, name));
    seed(join(historyDir, "notes.txt"), "mine");
    seed(join(historyDir, "sub/keep.txt"), "mine");
    const paths = uninstallLeftovers({ home, claudeRoot, userData, historyDir, systemHistory });
    expect(paths).not.toContain(historyDir);
    removeLeftovers(paths);
    for (const name of ours) expect(existsSync(join(historyDir, name)), name).toBe(false);
    expect(readFileSync(join(historyDir, "notes.txt"), "utf8")).toBe("mine");
    expect(existsSync(join(historyDir, "sub/keep.txt"))).toBe(true);
  });

  it("keeps a folder that only looks like a history backup", () => {
    const { home, claudeRoot, userData, systemHistory } = setup();
    const historyDir = join(home, "work");
    seed(join(historyDir, "history.db.backup-foo/data"), "mine");
    seed(join(historyDir, "history.db"));
    removeLeftovers(uninstallLeftovers({ home, claudeRoot, userData, historyDir, systemHistory }));
    expect(readFileSync(join(historyDir, "history.db.backup-foo/data"), "utf8")).toBe("mine");
    expect(existsSync(join(historyDir, "history.db"))).toBe(false);
  });

  it("keeps an empty custom history dir", () => {
    const { home, claudeRoot, userData, systemHistory } = setup();
    const historyDir = join(home, "empty");
    mkdirSync(historyDir, { recursive: true });
    removeLeftovers(uninstallLeftovers({ home, claudeRoot, userData, historyDir, systemHistory }));
    expect(existsSync(historyDir)).toBe(true);
  });

  it("ignores a missing custom history dir", () => {
    const { home, claudeRoot, userData, systemHistory } = setup();
    expect(() => removeLeftovers(uninstallLeftovers({ home, claudeRoot, userData, historyDir: join(home, "nope"), systemHistory }))).not.toThrow();
  });

  it("only removes .bak files the app wrote", () => {
    const { home, claudeRoot, userData, systemHistory } = setup();
    const ours = join(home, ".cursor/hooks.json");
    const theirs = join(home, ".codex/hooks.json");
    seed(ours, "a");
    seed(theirs, "b");
    seed(`${theirs}.bak`, "user backup");
    writeWithBackup(ours, "c");
    expect(writtenBackups(home)).toEqual([`${ours}.bak`]);
    removeLeftovers(uninstallLeftovers({ home, claudeRoot, userData, historyDir: systemHistory, systemHistory }));
    expect(existsSync(`${ours}.bak`)).toBe(false);
    expect(readFileSync(`${theirs}.bak`, "utf8")).toBe("user backup");
  });

  it("ignores tampered backup entries", () => {
    const { home, claudeRoot, userData, systemHistory } = setup();
    const dir = join(home, "precious.bak");
    seed(join(dir, "file"));
    seed(join(home, "notes.txt"));
    seed(join(home, ".agentic-leash/backups.json"), JSON.stringify([dir, join(home, "notes.txt"), 7]));
    expect(writtenBackups(home)).toEqual([]);
    removeLeftovers(uninstallLeftovers({ home, claudeRoot, userData, historyDir: systemHistory, systemHistory }));
    expect(existsSync(join(dir, "file"))).toBe(true);
    expect(existsSync(join(home, "notes.txt"))).toBe(true);
  });

  it("keeps other files in a shared Hermes agent-hooks dir", () => {
    const { home, claudeRoot, userData, systemHistory } = setup();
    seed(join(home, ".hermes/agent-hooks/agentic-leash.sh"));
    seed(join(home, ".hermes/agent-hooks/other.sh"), "theirs");
    removeLeftovers(uninstallLeftovers({ home, claudeRoot, userData, historyDir: systemHistory, systemHistory }));
    expect(existsSync(join(home, ".hermes/agent-hooks/agentic-leash.sh"))).toBe(false);
    expect(readFileSync(join(home, ".hermes/agent-hooks/other.sh"), "utf8")).toBe("theirs");
  });
});
