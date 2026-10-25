import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeHooksBlocked, loadClaude, snapshotFromClaude } from "../../src/main/agents/claude";
import { readCursorAdmin, snapshotFromCursor } from "../../src/main/agents/cursor";
import { loadAntigravity, loadCodex, loadGemini, snapshotFromT3, tomlMcpNames } from "../../src/main/agents/others";
import { configGrantRows } from "../../src/main/agents/mirror";
import { DatabaseSync } from "node:sqlite";

describe("claude adapter", () => {
  it("blocks hooks for a company policy and a disabled setup", () => {
    expect(claudeHooksBlocked([{ allowManagedHooksOnly: true }], {})).toBe(true);
    expect(claudeHooksBlocked([{}], { disableAllHooks: true })).toBe(true);
    expect(claudeHooksBlocked([{}], {})).toBe(false);
  });

  it("shows rules mode and locked deny rules for the company fixture", () => {
    const root = join("tests/fixtures/configs/claude-company");
    const dir = mkdtempSync(join(tmpdir(), "al-claude-"));
    mkdirSync(join(dir, "empty"), { recursive: true });
    writeFileSync(join(dir, "remote-settings.json"), readFileSync(join(root, "remote-settings.json")));
    const snapshot = loadClaude(dir, join(dir, "missing.json"), join(dir, "empty"));
    expect(snapshot.note).toBe("Rules mode (fallback): company policy blocks hooks");
    expect(snapshot.folders.some((folder) => folder.locked && folder.path.includes(".env"))).toBe(true);
    expect(snapshot.mcpServers.some((server) => server.locked)).toBe(true);
  });

  it("shows hook mode for a personal account", () => {
    const snapshot = snapshotFromClaude({
      settings: { permissions: { additionalDirectories: ["/Users/me/Desktop"] } },
      settingsLocal: {},
      claudeJson: { projects: { "/Users/me/Work": { hasTrustDialogAccepted: true } } },
      managed: [],
      installed: true,
    });
    expect(snapshot.enforcement).toBe("hook");
    expect(snapshot.folders.map((folder) => folder.path)).toContain("/Users/me/Desktop");
  });
});

describe("other adapters", () => {
  it("nests enabled T3 providers", () => {
    const snapshot = snapshotFromT3({ providerInstances: { cursor: { enabled: true }, claudeAgent: { enabled: true }, codex: { enabled: false } } }, true);
    expect(snapshot.children.sort()).toEqual(["claude-code", "cursor"]);
  });

  it("reads locked cursor admin settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "al-vscdb-"));
    const db = new DatabaseSync(join(dir, "state.vscdb"));
    db.exec("CREATE TABLE ItemTable (key TEXT, value TEXT)");
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("autorun.cachedAdminSettings", JSON.stringify({ SANDBOXING_MODE_DISABLED: true }));
    db.close();
    const admin = readCursorAdmin(join(dir, "state.vscdb"));
    const snapshot = snapshotFromCursor({ cli: { permissions: { allow: ["Write(/Users/me/proj)"] }, sandbox: { mode: "disabled" } }, sandboxes: [], mcp: { mcpServers: { local: { command: "echo" } } }, admin, installed: true, workers: ["cursor-agent worker"] });
    expect(snapshot.enforcement).toBe("hook");
    expect(snapshot.network.some((rule) => rule.locked && rule.rule.includes("SANDBOXING_MODE_DISABLED"))).toBe(true);
    expect(snapshot.workers).toHaveLength(1);
    expect(configGrantRows([snapshot], "/Users/me", 1).map((row) => row.path)).toContain("/Users/me/proj");
  });

  it("detects codex and gemini without enforcing them", () => {
    expect(tomlMcpNames("[mcp_servers.pencil]\ncommand = \"x\"\n")).toEqual(["pencil"]);
    const dir = mkdtempSync(join(tmpdir(), "al-codex-"));
    writeFileSync(join(dir, "config.toml"), "[mcp_servers.pencil]\n");
    expect(loadCodex(join(dir, "config.toml")).enforcement).toBe("monitor-only");
    const gemini = mkdtempSync(join(tmpdir(), "al-gemini-"));
    writeFileSync(join(dir, "settings.json"), "{\"mcpServers\":{\"pencil\":{\"command\":\"p\"}}}");
    expect(loadGemini(dir).mcpServers[0]?.name).toBe("pencil");
    expect(loadGemini(gemini).installed).toBe(false);
    expect(loadAntigravity(gemini).installed).toBe(false);
    mkdirSync(join(gemini, "antigravity-cli"), { recursive: true });
    mkdirSync(join(gemini, "config"), { recursive: true });
    writeFileSync(join(gemini, "config/mcp_config.json"), "{\"mcpServers\":{\"supa\":{\"url\":\"https://mcp.example.com\"}}}");
    const agy = loadAntigravity(gemini);
    expect(agy.installed).toBe(true);
    expect(agy.id).toBe("antigravity");
    expect(agy.mcpServers[0]?.name).toBe("supa");
  });
});
