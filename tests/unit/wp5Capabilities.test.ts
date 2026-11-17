import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getGlobalInstructionTargets,
  listCoreInstructions,
  unifyCoreInstructions,
} from "../../src/main/capabilities/instructionsManager";
import {
  agentMcpPath,
  deleteMcpServer,
  filterMcpServersByAgent,
  listMcpServers,
  saveMcpServer,
  toggleMcpForAgent,
} from "../../src/main/capabilities/mcpManager";
import {
  filterPluginsByAgent,
  getPluginDirs,
  isPluginEnabledForAgent,
  listPlugins,
  togglePluginForAgent,
  uninstallPlugin,
} from "../../src/main/capabilities/pluginsManager";
import {
  closeAnalyticsDb,
  detectAndRecordSkillUsage,
  extractSkillFromRequest,
  recordSkillUsage,
} from "../../src/main/capabilities/skillsAnalytics";
import {
  AGENT_SKILL_PATHS,
  filterSkillsByAgent,
  getSkillContent,
  getSkillUsageCount,
  listSkills,
  overrideSkillForAgent,
  resetSkillOverride,
  saveSkillContent,
  toggleSkillForAgent,
} from "../../src/main/capabilities/skillsManager";
import type { HookRequest } from "../../src/shared/types";

describe("WP5: Hermes skills & MCP support", () => {
  let testHome: string;

  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), "al-wp5-hermes-"));
  });

  afterEach(() => {
    closeAnalyticsDb(testHome);
    try {
      rmSync(testHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("discovers, toggles, overrides, and resets skills in ~/.hermes/skills", () => {
    expect(AGENT_SKILL_PATHS.hermes?.(testHome)).toBe(join(testHome, ".hermes/skills"));

    // Native Hermes skill installed directly in ~/.hermes/skills
    const hermesNativeDir = join(testHome, ".hermes/skills/hermes-native");
    mkdirSync(hermesNativeDir, { recursive: true });
    writeFileSync(
      join(hermesNativeDir, "SKILL.md"),
      "---\nname: Hermes Native\ndescription: Native Hermes skill\n---\n# Hermes Native\n",
      "utf8",
    );

    // Canonical skill toggled for Hermes
    saveSkillContent(
      "shared-skill",
      "---\nname: Shared Skill\ndescription: Shared across agents\n---\n# Shared\n",
      undefined,
      testHome,
    );
    toggleSkillForAgent("shared-skill", "hermes", true, testHome);

    const hermesLink = join(testHome, ".hermes/skills/shared-skill");
    expect(existsSync(hermesLink)).toBe(true);
    expect(lstatSync(hermesLink).isSymbolicLink()).toBe(true);

    const skills = listSkills(testHome);
    const nativeItem = skills.find((s) => s.id === "hermes-native");
    const sharedItem = skills.find((s) => s.id === "shared-skill");
    expect(nativeItem?.enabledAgents).toContain("hermes");
    expect(sharedItem?.enabledAgents).toContain("hermes");

    // Override & reset for Hermes
    overrideSkillForAgent("shared-skill", "hermes", testHome);
    expect(listSkills(testHome).find((s) => s.id === "shared-skill")?.isOverriddenFor).toContain("hermes");

    saveSkillContent("shared-skill", "# Hermes Override\n", "hermes", testHome);
    expect(getSkillContent("shared-skill", "hermes", testHome)).toContain("# Hermes Override");

    resetSkillOverride("shared-skill", "hermes", testHome);
    expect(listSkills(testHome).find((s) => s.id === "shared-skill")?.isOverriddenFor).not.toContain("hermes");

    // Toggle off
    toggleSkillForAgent("shared-skill", "hermes", false, testHome);
    expect(existsSync(hermesLink)).toBe(false);
    expect(listSkills(testHome).find((s) => s.id === "shared-skill")?.enabledAgents).not.toContain("hermes");
  });

  it("discovers, saves, toggles, filters, and deletes MCP servers in ~/.hermes/mcp.json", () => {
    expect(agentMcpPath("hermes", testHome)).toBe(join(testHome, ".hermes/mcp.json"));

    // Pre-existing Hermes MCP server in ~/.hermes/mcp.json
    const hermesMcpFile = join(testHome, ".hermes/mcp.json");
    mkdirSync(join(testHome, ".hermes"), { recursive: true });
    writeFileSync(
      hermesMcpFile,
      JSON.stringify({
        mcpServers: {
          "hermes-only": { command: "uvx", args: ["mcp-hermes"] },
        },
      }),
      "utf8",
    );

    saveMcpServer(
      {
        name: "shared-mcp",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-memory"],
        enabledAgents: ["claude-code", "hermes"],
      },
      testHome,
    );

    const parsedHermes = JSON.parse(readFileSync(hermesMcpFile, "utf8"));
    expect(parsedHermes.mcpServers["shared-mcp"]?.command).toBe("npx");
    expect(parsedHermes.mcpServers["hermes-only"]?.command).toBe("uvx");

    const servers = listMcpServers(testHome);
    expect(servers.find((s) => s.name === "hermes-only")?.enabledAgents).toEqual(["hermes"]);
    expect(servers.find((s) => s.name === "shared-mcp")?.enabledAgents).toEqual(
      expect.arrayContaining(["claude-code", "hermes"]),
    );

    // Filter by agent
    const hermesFiltered = filterMcpServersByAgent(servers, "hermes");
    expect(hermesFiltered.map((s) => s.name)).toEqual(["hermes-only", "shared-mcp"]);
    const cursorFiltered = filterMcpServersByAgent(servers, "cursor");
    expect(cursorFiltered).toHaveLength(0);
    expect(filterMcpServersByAgent(servers, "all")).toHaveLength(2);

    // Toggle off for Hermes
    toggleMcpForAgent("shared-mcp", "hermes", false, testHome);
    const updatedHermes = JSON.parse(readFileSync(hermesMcpFile, "utf8"));
    expect(updatedHermes.mcpServers["shared-mcp"]).toBeUndefined();
    expect(listMcpServers(testHome).find((s) => s.name === "shared-mcp")?.enabledAgents).not.toContain("hermes");

    // Toggle back on for Hermes
    toggleMcpForAgent("shared-mcp", "hermes", true, testHome);
    expect(listMcpServers(testHome).find((s) => s.name === "shared-mcp")?.enabledAgents).toContain("hermes");

    // Delete removes from Hermes config too
    deleteMcpServer("shared-mcp", testHome);
    const afterDelete = JSON.parse(readFileSync(hermesMcpFile, "utf8"));
    expect(afterDelete.mcpServers["shared-mcp"]).toBeUndefined();
  });
});

describe("WP5: Multi-agent plugin discovery & filtering", () => {
  let testHome: string;

  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), "al-wp5-plugins-"));
  });

  afterEach(() => {
    try {
      rmSync(testHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("discovers plugins across Claude, Cursor, Codex, Hermes, and Gemini directories with source metadata", async () => {
    const dirs = getPluginDirs(testHome);
    expect(dirs).toEqual(
      expect.arrayContaining([
        join(testHome, ".gemini/config/plugins"),
        join(testHome, ".gemini/plugins"),
        join(testHome, ".claude/plugins"),
        join(testHome, ".cursor/plugins"),
        join(testHome, ".codex/plugins"),
        join(testHome, ".hermes/plugins"),
      ]),
    );

    // 1. Claude plugin inside nested cache/<registry>/<name>/<version>/
    const claudeNested = join(testHome, ".claude/plugins/cache/acme-registry/claude-auth/1.0.0");
    mkdirSync(join(claudeNested, ".claude-plugin"), { recursive: true });
    mkdirSync(join(claudeNested, "skills/auth-flow"), { recursive: true });
    writeFileSync(
      join(claudeNested, ".claude-plugin/plugin.json"),
      JSON.stringify({ name: "claude-auth", version: "1.0.0", description: "Auth plugin" }),
      "utf8",
    );
    writeFileSync(join(claudeNested, "skills/auth-flow/SKILL.md"), "---\nname: Auth Flow\n---\n", "utf8");

    // 2. Cursor direct plugin
    const cursorPlugin = join(testHome, ".cursor/plugins/cursor-lint");
    mkdirSync(join(cursorPlugin, "skills/lint-rule"), { recursive: true });
    writeFileSync(join(cursorPlugin, "plugin.json"), JSON.stringify({ name: "cursor-lint" }), "utf8");
    writeFileSync(join(cursorPlugin, "skills/lint-rule/SKILL.md"), "---\nname: Lint Rule\n---\n", "utf8");

    // 3. Codex direct plugin
    const codexPlugin = join(testHome, ".codex/plugins/codex-kit");
    mkdirSync(codexPlugin, { recursive: true });
    writeFileSync(join(codexPlugin, "plugin.json"), JSON.stringify({ name: "codex-kit" }), "utf8");

    // 4. Hermes direct plugin
    const hermesPlugin = join(testHome, ".hermes/plugins/hermes-tools");
    mkdirSync(join(hermesPlugin, "skills/hermes-helper"), { recursive: true });
    writeFileSync(join(hermesPlugin, "plugin.json"), JSON.stringify({ name: "hermes-tools" }), "utf8");
    writeFileSync(join(hermesPlugin, "skills/hermes-helper/SKILL.md"), "---\nname: Hermes Helper\n---\n", "utf8");

    // 5. Antigravity plugin
    const agyPlugin = join(testHome, ".gemini/config/plugins/agy-pack");
    mkdirSync(join(agyPlugin, "skills/agy-skill"), { recursive: true });
    writeFileSync(join(agyPlugin, "skills/agy-skill/SKILL.md"), "---\nname: Agy Skill\n---\n", "utf8");

    const plugins = listPlugins(testHome);
    // "cache" container folder must not appear as a bogus plugin
    expect(plugins.find((p) => p.name === "cache")).toBeUndefined();
    expect(plugins).toHaveLength(5);

    const claudeItem = plugins.find((p) => p.name === "claude-auth");
    expect(claudeItem?.sourceAgent).toBe("claude-code");
    expect(claudeItem?.agents).toContain("claude-code");
    expect(claudeItem?.enabledAgents).toContain("claude-code");
    expect(claudeItem?.enabledAgents).not.toContain("antigravity");

    expect(plugins.find((p) => p.name === "cursor-lint")?.sourceAgent).toBe("cursor");
    expect(plugins.find((p) => p.name === "codex-kit")?.sourceAgent).toBe("codex");
    expect(plugins.find((p) => p.name === "hermes-tools")?.sourceAgent).toBe("hermes");
    expect(plugins.find((p) => p.name === "agy-pack")?.sourceAgent).toBe("antigravity");

    // Plugin skills also reflect their respective source agent rather than defaulting to antigravity
    const skills = listSkills(testHome);
    const authSkill = skills.find((s) => s.id === "auth-flow");
    expect(authSkill?.enabledAgents).toContain("claude-code");
    expect(authSkill?.enabledAgents).not.toContain("antigravity");

    // Filtering by agent
    expect(filterPluginsByAgent(plugins, "claude-code").map((p) => p.name)).toEqual(["claude-auth"]);
    expect(filterPluginsByAgent(plugins, "cursor").map((p) => p.name)).toEqual(["cursor-lint"]);
    expect(filterPluginsByAgent(plugins, "codex").map((p) => p.name)).toEqual(["codex-kit"]);
    expect(filterPluginsByAgent(plugins, "hermes").map((p) => p.name)).toEqual(["hermes-tools"]);
    expect(filterPluginsByAgent(plugins, "antigravity").map((p) => p.name)).toEqual(["agy-pack"]);

    // Enable claude-auth for hermes too and verify filtering picks it up
    togglePluginForAgent("claude-auth", "hermes", true, testHome);
    expect(isPluginEnabledForAgent("claude-auth", "hermes", testHome)).toBe(true);
    const updatedPlugins = listPlugins(testHome);
    expect(filterPluginsByAgent(updatedPlugins, "hermes").map((p) => p.name)).toEqual([
      "claude-auth",
      "hermes-tools",
    ]);

    // Toggle claude-auth off for claude-code: enabledAgents drops claude-code, while sourceAgent still keeps it discoverable under Claude filter
    togglePluginForAgent("claude-auth", "claude-code", false, testHome);
    const afterDisable = listPlugins(testHome);
    const claudeDisabled = afterDisable.find((p) => p.name === "claude-auth");
    expect(claudeDisabled?.enabledAgents).not.toContain("claude-code");
    expect(filterPluginsByAgent(afterDisable, "claude-code").map((p) => p.name)).toEqual(["claude-auth"]);

    // Uninstall works for non-gemini plugin directories
    const uninst = await uninstallPlugin("cursor-lint", testHome);
    expect(uninst).toEqual({ ok: true });
    expect(existsSync(cursorPlugin)).toBe(false);
  });
});

describe("WP5: Per-agent skill usage breakdown, filtering, and instruction targets", () => {
  let testHome: string;

  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), "al-wp5-usage-"));
  });

  afterEach(() => {
    closeAnalyticsDb(testHome);
    try {
      rmSync(testHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("tracks per-agent skill usage and filters skills & usage counts by selected agent", () => {
    saveSkillContent("refactor", "---\nname: Refactor\n---\n# Refactor\n", undefined, testHome);
    saveSkillContent("debug", "---\nname: Debug\n---\n# Debug\n", undefined, testHome);

    toggleSkillForAgent("refactor", "claude-code", true, testHome);
    toggleSkillForAgent("refactor", "hermes", true, testHome);
    toggleSkillForAgent("debug", "cursor", true, testHome);

    recordSkillUsage("refactor", "claude-code", testHome);
    recordSkillUsage("refactor", "claude-code", testHome);
    recordSkillUsage("refactor", "hermes", testHome);
    recordSkillUsage("debug", "cursor", testHome);

    const hermesReq: HookRequest = {
      agent: "hermes",
      event: "PreToolUse",
      tool: "skill_view",
      command: "refactor",
      access: "read",
      paths: [],
      cwd: "/repo",
    };
    expect(extractSkillFromRequest(hermesReq)).toBe("refactor");
    detectAndRecordSkillUsage(hermesReq, testHome);

    const skills = listSkills(testHome);
    const refactor = skills.find((s) => s.id === "refactor")!;
    const debug = skills.find((s) => s.id === "debug")!;

    expect(refactor.usageCount).toBe(4);
    expect(refactor.usageByAgent).toEqual({ "claude-code": 2, hermes: 2 });

    // Overall vs per-agent usage counts
    expect(getSkillUsageCount(refactor, "all")).toBe(4);
    expect(getSkillUsageCount(refactor, "claude-code")).toBe(2);
    expect(getSkillUsageCount(refactor, "hermes")).toBe(2);
    expect(getSkillUsageCount(refactor, "cursor")).toBe(0);
    expect(getSkillUsageCount(debug, "cursor")).toBe(1);

    // Filtering skills by agent
    expect(filterSkillsByAgent(skills, "all").map((s) => s.id)).toEqual(["debug", "refactor"]);
    expect(filterSkillsByAgent(skills, "claude-code").map((s) => s.id)).toEqual(["refactor"]);
    expect(filterSkillsByAgent(skills, "hermes").map((s) => s.id)).toEqual(["refactor"]);
    expect(filterSkillsByAgent(skills, "cursor").map((s) => s.id)).toEqual(["debug"]);
    expect(filterSkillsByAgent(skills, "codex")).toEqual([]);
  });

  it("includes cursor, codex, and hermes global instruction targets and unifies them", () => {
    const targets = getGlobalInstructionTargets(testHome);
    expect(targets.map((t) => t.agentId)).toEqual(
      expect.arrayContaining(["claude-code", "antigravity", "cursor", "codex", "gemini", "hermes", "all"]),
    );

    expect(targets.find((t) => t.agentId === "cursor")?.path).toBe(join(testHome, ".cursor/rules/AGENTS.md"));
    expect(targets.find((t) => t.agentId === "codex")?.path).toBe(join(testHome, ".codex/AGENTS.md"));
    expect(targets.find((t) => t.agentId === "hermes")?.path).toBe(join(testHome, ".hermes/AGENTS.md"));

    unifyCoreInstructions("global", undefined, testHome);
    const items = listCoreInstructions(undefined, testHome);
    for (const agentId of ["cursor", "codex", "hermes"] as const) {
      const item = items.find((i) => i.scope === "global" && i.agentId === agentId);
      expect(item?.isSymlink).toBe(true);
      expect(item?.content).toContain("Shared instructions");
    }
  });
});
