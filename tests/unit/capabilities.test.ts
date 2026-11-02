import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteMcpServer,
  listMcpServers,
  parseCodexToml,
  saveMcpServer,
  serializeCodexToml,
  toggleMcpForAgent,
} from "../../src/main/capabilities/mcpManager";
import {
  closeAnalyticsDb,
  detectAndRecordSkillUsage,
  extractSkillFromRequest,
  getSkillAnalytics,
  recordSkillUsage,
} from "../../src/main/capabilities/skillsAnalytics";
import {
  deleteSkill,
  getSkillContent,
  isValidSkillId,
  listSkills,
  overrideSkillForAgent,
  resetSkillOverride,
  saveSkillContent,
  toggleSkillForAgent,
} from "../../src/main/capabilities/skillsManager";
import {
  extractRepoName,
  listPlugins,
  togglePluginForAgent,
  uninstallPlugin,
} from "../../src/main/capabilities/pluginsManager";
import {
  listCoreInstructions,
  saveCoreInstruction,
  unifyCoreInstructions,
} from "../../src/main/capabilities/instructionsManager";
import type { HookRequest, McpServerConfig } from "../../src/shared/types";

describe("Capabilities: McpManager", () => {
  let testHome: string;

  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), "al-cap-mcp-"));
  });

  afterEach(() => {
    try {
      rmSync(testHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("handles Codex TOML parsing and serialization", () => {
    const original = `
# Codex config
[other_section]
key = "val"

[mcp_servers.test-server]
command = "node"
args = ["server.js", "--port", "3000"]
url = "http://localhost:3000"

[mcp_servers.test-server.env]
API_KEY = "secret123"
`;
    const parsed = parseCodexToml(original);
    expect(parsed["test-server"]).toBeDefined();
    expect(parsed["test-server"]?.command).toBe("node");
    expect(parsed["test-server"]?.args).toEqual(["server.js", "--port", "3000"]);
    expect(parsed["test-server"]?.env?.API_KEY).toBe("secret123");

    // Serialize adding a new server
    const updated = serializeCodexToml(original, "new-server", {
      command: "python3",
      args: ["run.py"],
      url: "http://127.0.0.1:8000",
      env: { DEBUG: "1" },
    });
    const parsedUpdated = parseCodexToml(updated);
    expect(parsedUpdated["new-server"]?.command).toBe("python3");
    expect(parsedUpdated["new-server"]?.env?.DEBUG).toBe("1");

    // Multiline args parsing
    const multiline = `
[mcp_servers.multi-server]
command = "npx"
args = [
  "-y",
  "some-pkg",
  "--option",
  "value"
]
`;
    const parsedMulti = parseCodexToml(multiline);
    expect(parsedMulti["multi-server"]?.args).toEqual(["-y", "some-pkg", "--option", "value"]);

    // Serialize removing test-server
    const removed = serializeCodexToml(updated, "test-server", null);
    const parsedRemoved = parseCodexToml(removed);
    expect(parsedRemoved["test-server"]).toBeUndefined();
    expect(parsedRemoved["new-server"]).toBeDefined();
  });

  it("saves, lists, toggles, and deletes MCP servers across agents", () => {
    const server: McpServerConfig = {
      name: "fetch-mcp",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-fetch"],
      enabledAgents: ["claude-code", "codex", "cursor"],
    };

    saveMcpServer(server, testHome);

    // Verify written to Claude Code config
    const claudeJsonPath = join(testHome, ".claude.json");
    expect(existsSync(claudeJsonPath)).toBe(true);
    const claudeJson = JSON.parse(readFileSync(claudeJsonPath, "utf8"));
    expect(claudeJson.mcpServers["fetch-mcp"].command).toBe("npx");

    // Verify written to Cursor config
    const cursorJsonPath = join(testHome, ".cursor/mcp.json");
    expect(existsSync(cursorJsonPath)).toBe(true);
    const cursorJson = JSON.parse(readFileSync(cursorJsonPath, "utf8"));
    expect(cursorJson.mcpServers["fetch-mcp"]).toBeDefined();

    // Verify written to Codex TOML
    const codexTomlPath = join(testHome, ".codex/config.toml");
    expect(existsSync(codexTomlPath)).toBe(true);
    const codexContent = readFileSync(codexTomlPath, "utf8");
    expect(codexContent).toContain("[mcp_servers.fetch-mcp]");

    // Verify list
    const list = listMcpServers(testHome);
    expect(list.length).toBe(1);
    expect(list[0]?.name).toBe("fetch-mcp");
    expect(list[0]?.enabledAgents).toContain("claude-code");
    expect(list[0]?.enabledAgents).toContain("codex");
    expect(list[0]?.enabledAgents).toContain("cursor");
    expect(list[0]?.enabledAgents).not.toContain("antigravity");

    // Toggle for antigravity
    toggleMcpForAgent("fetch-mcp", "antigravity", true, testHome);
    const agyPath = join(testHome, ".gemini/config/mcp_config.json");
    expect(existsSync(agyPath)).toBe(true);
    const agyJson = JSON.parse(readFileSync(agyPath, "utf8"));
    expect(agyJson.mcpServers["fetch-mcp"]).toBeDefined();

    // Toggle off for claude-code
    toggleMcpForAgent("fetch-mcp", "claude-code", false, testHome);
    const claudeUpdated = JSON.parse(readFileSync(claudeJsonPath, "utf8"));
    expect(claudeUpdated.mcpServers["fetch-mcp"]).toBeUndefined();

    // Delete server
    deleteMcpServer("fetch-mcp", testHome);
    const listAfterDelete = listMcpServers(testHome);
    expect(listAfterDelete.length).toBe(0);
    const cursorAfterDelete = JSON.parse(readFileSync(cursorJsonPath, "utf8"));
    expect(cursorAfterDelete.mcpServers["fetch-mcp"]).toBeUndefined();
  });
});

describe("Capabilities: SkillsAnalytics", () => {
  let testHome: string;

  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), "al-cap-analytics-"));
  });

  afterEach(() => {
    closeAnalyticsDb(testHome);
    try {
      rmSync(testHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("records skill usage and queries analytics", () => {
    recordSkillUsage("code-review", "claude-code", testHome);
    recordSkillUsage("code-review", "claude-code", testHome);
    recordSkillUsage("code-review", "antigravity", testHome);
    recordSkillUsage("tdd", "cursor", testHome);

    const analytics = getSkillAnalytics(testHome);
    expect(analytics["code-review"]).toBeDefined();
    expect(analytics["code-review"]?.total).toBe(3);
    expect(analytics["code-review"]?.byAgent["claude-code"]).toBe(2);
    expect(analytics["code-review"]?.byAgent["antigravity"]).toBe(1);

    expect(analytics["tdd"]?.total).toBe(1);
    expect(analytics["tdd"]?.byAgent["cursor"]).toBe(1);
  });

  it("extracts skill from hook requests", () => {
    const req1: HookRequest = {
      agent: "claude-code",
      event: "PreToolUse",
      tool: "read_file",
      access: "read",
      paths: ["/home/user/.claude/skills/code-review/SKILL.md"],
      cwd: "/repo",
    };
    expect(extractSkillFromRequest(req1)).toBe("code-review");

    const req2: HookRequest = {
      agent: "antigravity",
      event: "PreToolUse",
      tool: "Skill",
      command: "tdd",
      access: "read",
      paths: [],
      cwd: "/repo",
    };
    expect(extractSkillFromRequest(req2)).toBe("tdd");

    detectAndRecordSkillUsage(req1, testHome);
    const analytics = getSkillAnalytics(testHome);
    expect(analytics["code-review"]?.total).toBe(1);
  });
});

describe("Capabilities: SkillsManager", () => {
  let testHome: string;

  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), "al-cap-skills-"));
  });

  afterEach(() => {
    try {
      rmSync(testHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("manages canonical skills, agent symlinks, overrides, and resets", () => {
    const skillContent = `---
name: unit-test-skill
description: Generates comprehensive unit tests
---
# Unit Test Skill
Instructions go here.
`;

    // Save canonical skill
    saveSkillContent("unit-test-skill", skillContent, undefined, testHome);
    const fetched = getSkillContent("unit-test-skill", undefined, testHome);
    expect(fetched).toBe(skillContent);

    // List skills
    const initialList = listSkills(testHome);
    expect(initialList.length).toBe(1);
    expect(initialList[0]?.id).toBe("unit-test-skill");
    expect(initialList[0]?.description).toBe("Generates comprehensive unit tests");
    expect(initialList[0]?.enabledAgents.length).toBe(0);

    // Toggle for Claude Code
    toggleSkillForAgent("unit-test-skill", "claude-code", true, testHome);
    const claudeSkillPath = join(testHome, ".claude/skills/unit-test-skill");
    expect(existsSync(claudeSkillPath)).toBe(true);
    expect(lstatSync(claudeSkillPath).isSymbolicLink()).toBe(true);

    const afterToggle = listSkills(testHome);
    expect(afterToggle[0]?.enabledAgents).toContain("claude-code");
    expect(afterToggle[0]?.isOverriddenFor?.length).toBe(0);

    // Override for Claude Code
    overrideSkillForAgent("unit-test-skill", "claude-code", testHome);
    const afterOverride = listSkills(testHome);
    expect(afterOverride[0]?.isOverriddenFor).toContain("claude-code");

    // Modify override variant
    const variantContent = skillContent + "\nClaude specific note.";
    saveSkillContent("unit-test-skill", variantContent, "claude-code", testHome);
    expect(getSkillContent("unit-test-skill", "claude-code", testHome)).toBe(variantContent);
    expect(getSkillContent("unit-test-skill", undefined, testHome)).toBe(skillContent);

    // Reset override
    resetSkillOverride("unit-test-skill", "claude-code", testHome);
    const afterReset = listSkills(testHome);
    expect(afterReset[0]?.isOverriddenFor).not.toContain("claude-code");
    expect(getSkillContent("unit-test-skill", "claude-code", testHome)).toBe(skillContent);

    // Delete skill
    const delResult = deleteSkill("unit-test-skill", testHome);
    expect(delResult.ok).toBe(true);
    expect(existsSync(claudeSkillPath)).toBe(false);
    expect(listSkills(testHome).length).toBe(0);
  });

  it("discovers plugin skills and protects them from deletion", () => {
    const pluginDir = join(testHome, ".gemini/config/plugins/test-plugin/skills/plugin-skill");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "SKILL.md"),
      `---
name: Plugin Skill
description: Bundled with plugin
---
# Content
`,
      "utf8",
    );

    const skills = listSkills(testHome);
    const found = skills.find((s) => s.id === "plugin-skill");
    expect(found).toBeDefined();
    expect(found?.isPlugin).toBe(true);
    expect(found?.pluginName).toBe("test-plugin");
    expect(found?.enabledAgents).toContain("antigravity");

    // Toggle plugin skill off/on for antigravity
    toggleSkillForAgent("plugin-skill", "antigravity", false, testHome);
    expect(listSkills(testHome).find((s) => s.id === "plugin-skill")?.enabledAgents).not.toContain("antigravity");

    toggleSkillForAgent("plugin-skill", "antigravity", true, testHome);
    expect(listSkills(testHome).find((s) => s.id === "plugin-skill")?.enabledAgents).toContain("antigravity");

    // Toggle plugin on/off for claude-code and verify skills' enabledAgents update
    togglePluginForAgent("test-plugin", "claude-code", true, testHome);
    expect(listSkills(testHome).find((s) => s.id === "plugin-skill")?.enabledAgents).toContain("claude-code");
    expect(listPlugins(testHome).find((p) => p.name === "test-plugin")?.enabledAgents).toContain("claude-code");

    togglePluginForAgent("test-plugin", "claude-code", false, testHome);
    expect(listSkills(testHome).find((s) => s.id === "plugin-skill")?.enabledAgents).not.toContain("claude-code");
    expect(listPlugins(testHome).find((p) => p.name === "test-plugin")?.enabledAgents).not.toContain("claude-code");

    // Try deleting plugin skill
    const del = deleteSkill("plugin-skill", testHome);
    expect(del.ok).toBe(false);
    expect(del.error).toContain("Plugin-bundled skills cannot be deleted");
  });

  it("validates skill IDs and backs up native agent skills on disable", () => {
    expect(isValidSkillId("normal-skill_1")).toBe(true);
    expect(isValidSkillId("../escape")).toBe(false);
    expect(isValidSkillId("foo/bar")).toBe(false);
    expect(isValidSkillId("")).toBe(false);

    // Rejects invalid IDs in delete/save
    expect(deleteSkill("../escape", testHome)).toEqual({ ok: false, error: "Invalid skill ID" });
    expect(() => saveSkillContent("../escape", "content", undefined, testHome)).toThrow();

    // Native skill directory installed directly in ~/.claude/skills
    const nativeDir = join(testHome, ".claude/skills/native-skill");
    mkdirSync(nativeDir, { recursive: true });
    writeFileSync(join(nativeDir, "SKILL.md"), "---\nname: Native\n---\n# Native Content\n", "utf8");

    // Can read content directly from native path
    expect(getSkillContent("native-skill", "claude-code", testHome)).toContain("# Native Content");

    // Disabling promotes to canonical rather than destroying permanently
    toggleSkillForAgent("native-skill", "claude-code", false, testHome);
    const canonicalPath = join(testHome, ".agentic-leash/skills/canonical/native-skill/SKILL.md");
    expect(existsSync(canonicalPath)).toBe(true);
    expect(readFileSync(canonicalPath, "utf8")).toContain("# Native Content");
  });
});

describe("Capabilities: PluginsManager", () => {
  let testHome: string;

  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), "al-cap-plugins-"));
  });

  afterEach(() => {
    try {
      rmSync(testHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("lists plugins with counts and toggles plugins for agents", async () => {
    const pluginDir = join(testHome, ".gemini/config/plugins/my-pack");
    mkdirSync(join(pluginDir, "skills/skill-a"), { recursive: true });
    writeFileSync(join(pluginDir, "skills/skill-a/SKILL.md"), "# Skill A\n", "utf8");

    mkdirSync(join(pluginDir, "rules"), { recursive: true });
    writeFileSync(join(pluginDir, "rules/rule-1.md"), "# Rule 1\n", "utf8");

    writeFileSync(
      join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "my-pack",
        version: "1.2.0",
        description: "A cool plugin pack",
        author: "Dev",
      }),
      "utf8",
    );

    const plugins = listPlugins(testHome);
    expect(plugins.length).toBe(1);
    expect(plugins[0]?.name).toBe("my-pack");
    expect(plugins[0]?.version).toBe("1.2.0");
    expect(plugins[0]?.skillsCount).toBe(1);
    expect(plugins[0]?.rulesCount).toBe(1);
    expect(plugins[0]?.enabledAgents).toContain("antigravity");

    // Toggle plugin off for antigravity
    togglePluginForAgent("my-pack", "antigravity", false, testHome);
    const pluginsAfterToggle = listPlugins(testHome);
    expect(pluginsAfterToggle[0]?.enabledAgents).not.toContain("antigravity");

    // Extract repo name helper
    expect(extractRepoName("https://github.com/foo/sample-plugin.git")).toBe("sample-plugin");
    expect(extractRepoName("git@github.com:bar/another-plugin")).toBe("another-plugin");

    // Uninstall plugin rejects unknown or traversal
    const badUninst = await uninstallPlugin("../escape", testHome);
    expect(badUninst.ok).toBe(false);

    // Uninstall plugin
    const uninst = await uninstallPlugin("my-pack", testHome);
    expect(uninst).toEqual({ ok: true });
    expect(existsSync(pluginDir)).toBe(false);
  });
});

describe("Capabilities: InstructionsManager", () => {
  let testHome: string;
  let testProject: string;

  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), "al-cap-inst-home-"));
    testProject = mkdtempSync(join(tmpdir(), "al-cap-inst-proj-"));
  });

  afterEach(() => {
    try {
      rmSync(testHome, { recursive: true, force: true });
      rmSync(testProject, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("lists, saves, and unifies instructions", () => {
    const list = listCoreInstructions(testProject, testHome);
    expect(list.length).toBeGreaterThan(0);

    const claudeGlobal = list.find((i) => i.scope === "global" && i.agentId === "claude-code");
    expect(claudeGlobal).toBeDefined();

    // Save instruction
    saveCoreInstruction({
      agentId: "claude-code",
      scope: "global",
      path: claudeGlobal!.path,
      content: "# Claude Rules\nAlways be concise.\n",
      isSymlink: false,
    });

    const updatedList = listCoreInstructions(testProject, testHome);
    const updatedClaude = updatedList.find((i) => i.scope === "global" && i.agentId === "claude-code");
    expect(updatedClaude?.content).toContain("Always be concise.");

    // Unify global instructions
    unifyCoreInstructions("global", undefined, testHome);

    const unifiedList = listCoreInstructions(testProject, testHome);
    const antigravityGlobal = unifiedList.find((i) => i.scope === "global" && i.agentId === "antigravity");
    expect(antigravityGlobal?.isSymlink).toBe(true);
    expect(antigravityGlobal?.content).toContain("Always be concise.");

    // Unify project instructions
    writeFileSync(join(testProject, "AGENTS.md"), "# Project Agent Rules\nProject-specific.\n", "utf8");
    unifyCoreInstructions("project", testProject, testHome);

    const projectClaude = join(testProject, "CLAUDE.md");
    expect(existsSync(projectClaude)).toBe(true);
    expect(lstatSync(projectClaude).isSymbolicLink()).toBe(true);
    expect(readFileSync(projectClaude, "utf8")).toContain("Project-specific.");
  });
});
