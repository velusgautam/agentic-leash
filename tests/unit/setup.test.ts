import { describe, expect, it } from "vitest";
import { actionLabel, actionState, claudeSurface, isHookAgent, macAppPresent, needsAgentBanner, rememberOnboarding, setupProgress, setupReady, visibleAgent } from "../../src/shared/setup";

const agent = (id: string, installed: boolean, enabled: boolean, hooks: boolean | null) => ({ id, installed, enabled, hooks });

describe("setup gate", () => {
  it("opens the app when the helper is running, Full Disk Access is granted, and every turned-on agent has hooks", () => {
    expect(setupReady({
      helper: "running",
      fda: true,
      agents: [agent("claude-code", true, true, true), agent("cursor", true, true, true)],
    })).toBe(true);
  });

  it("opens the app when one turned-on agent has hooks and another does not", () => {
    expect(setupReady({
      helper: "running",
      fda: true,
      agents: [agent("claude-code", true, true, true), agent("cursor", true, true, false)],
    })).toBe(true);
  });

  it("stays on setup when turned-on agents are installed and none have hooks", () => {
    expect(setupReady({
      helper: "running",
      fda: true,
      agents: [agent("claude-code", true, true, false)],
    })).toBe(false);
    expect(setupReady({
      helper: "running",
      fda: true,
      agents: [agent("claude-code", true, true, false), agent("cursor", true, true, false)],
    })).toBe(false);
  });

  it("stays in the app after onboarding when a turned-on agent has no hooks", () => {
    expect(setupReady({
      helper: "running",
      fda: true,
      agents: [agent("claude-code", true, false, false), agent("cursor", true, true, false)],
    }, true)).toBe(true);
  });

  it("still waits for the helper and Full Disk Access after onboarding", () => {
    const agents = [agent("claude-code", true, true, true)];
    expect(setupReady({ helper: "stopped", fda: true, agents }, true)).toBe(false);
    expect(setupReady({ helper: "running", fda: false, agents }, true)).toBe(false);
  });

  it("remembers onboarding once one turned-on agent has hooks", () => {
    expect(rememberOnboarding(false, [agent("claude-code", true, true, true), agent("cursor", true, true, false)])).toBe(true);
    expect(rememberOnboarding(false, [agent("claude-code", true, true, false)])).toBe(false);
    expect(rememberOnboarding(false, [agent("claude-code", true, false, true)])).toBe(false);
    expect(rememberOnboarding(true, [agent("cursor", true, true, false)])).toBe(true);
  });

  it("lets setup finish when no hook agent is installed, and when an installed agent is turned off", () => {
    expect(setupReady({ helper: "running", fda: true, agents: [] })).toBe(true);
    expect(setupReady({
      helper: "skipped",
      fda: true,
      agents: [agent("claude-code", true, false, false)],
    })).toBe(true);
  });

  it("waits for Hermes hooks when Hermes is installed and turned on", () => {
    expect(setupReady({
      helper: "running",
      fda: true,
      agents: [agent("hermes", true, true, false)],
    })).toBe(false);
  });

  it("waits for Gemini hooks when Gemini is installed and turned on", () => {
    expect(setupReady({
      helper: "running",
      fda: true,
      agents: [agent("gemini", true, true, false)],
    })).toBe(false);
  });

  it("waits for Antigravity hooks when Antigravity is installed and turned on", () => {
    expect(setupReady({
      helper: "running",
      fda: true,
      agents: [agent("antigravity", true, true, false)],
    })).toBe(false);
  });

  it("waits for Codex hooks when Codex is installed and turned on", () => {
    expect(setupReady({
      helper: "running",
      fda: true,
      agents: [agent("codex", true, true, false)],
    })).toBe(false);
  });

  it("blocks when the helper is stopped or Full Disk Access is missing", () => {
    expect(setupReady({ helper: "stopped", fda: true, agents: [] })).toBe(false);
    expect(setupReady({ helper: "running", fda: false, agents: [] })).toBe(false);
  });
});

describe("agent visibility", () => {
  it("shows an agent only when it is installed and turned on", () => {
    expect(visibleAgent({ installed: true, enabled: true })).toBe(true);
    expect(visibleAgent({ installed: true, enabled: false })).toBe(false);
    expect(visibleAgent({ installed: false, enabled: true })).toBe(false);
  });

  it("asks for an agent only when Claude, Cursor, Codex, Gemini, and Hermes are all absent", () => {
    expect(needsAgentBanner([agent("claude-code", false, true, null), agent("codex", false, true, null)])).toBe(true);
    expect(needsAgentBanner([agent("gemini", true, false, null)])).toBe(false);
  });
});

describe("setup buttons", () => {
  it("labels a hook row from the live check", () => {
    expect(actionState({ known: false, busy: false, failed: false, done: false })).toBe("checking");
    expect(actionLabel("hook", "checking")).toBe("Checking…");
    expect(actionLabel("hook", "ready")).toBe("Install");
    expect(actionLabel("hook", "working")).toBe("Installing…");
    expect(actionLabel("hook", "done")).toBe("Installed");
    expect(actionLabel("hook", "failed")).toBe("Retry");
    expect(actionLabel("helper", "done")).toBe("Running");
    expect(actionLabel("fda", "ready")).toBe("Open Full Disk Access");
    expect(actionLabel("fda", "done")).toBe("Granted");
    expect(actionState({ known: true, busy: false, failed: false, done: true })).toBe("done");
    expect(actionState({ known: true, busy: true, failed: false, done: false })).toBe("working");
    expect(actionState({ known: true, busy: false, failed: true, done: false })).toBe("failed");
  });
});

describe("claude surface", () => {
  it("reads Desktop and CLI from the executable path", () => {
    expect(claudeSurface("/Applications/Claude.app/Contents/MacOS/Claude")).toBe("Desktop");
    expect(claudeSurface("/usr/local/bin/claude")).toBe("CLI");
    expect(claudeSurface("/bin/cursor-agent")).toBe(null);
  });

  it("finds an app in /Applications or the home Applications folder", () => {
    const exists = (path: string) => path === "/Users/me/Applications/Claude.app";
    expect(macAppPresent("Claude", "/Users/me", exists)).toBe(true);
    expect(macAppPresent("Cursor", "/Users/me", exists)).toBe(false);
  });
});

describe("setup progress", () => {
  it("counts hooks, helper, and Full Disk Access", () => {
    const base = { helper: "stopped" as const, fda: false, agents: [agent("claude-code", true, true, false)] };
    expect(setupProgress(base)).toEqual({ done: 0, total: 3 });
    expect(setupProgress({ ...base, helper: "skipped", fda: true })).toEqual({ done: 2, total: 3 });
    expect(setupProgress({ helper: "running", fda: true, agents: [agent("claude-code", true, true, true)] })).toEqual({ done: 3, total: 3 });
    expect(setupProgress({ ...base, agents: [] }).done).toBe(1);
  });
});

describe("isHookAgent", () => {
  it("accepts the hook agents and rejects others", () => {
    for (const id of ["claude-code", "cursor", "codex", "gemini", "antigravity", "hermes"]) expect(isHookAgent(id)).toBe(true);
    expect(isHookAgent("copilot")).toBe(false);
    expect(isHookAgent("t3-code")).toBe(false);
  });
});
