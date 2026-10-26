import { describe, expect, it } from "vitest";
import { decide } from "../../src/hook/decide";
import type { HookRequest } from "../../src/shared/types";

const opts = { now: 1_000, lockdown: false, protectedRoots: ["/secret"], home: "/Users/v", autoAllowOff: [] as string[] };
const req = (over: Partial<HookRequest>): HookRequest => ({ agent: "claude-code", event: "preToolUse", tool: "Read", access: "read", paths: ["/Users/v/proj/.claude/skills/review/SKILL.md"], cwd: "/Users/v/proj", ...over });

describe("automatic allows", () => {
  it("lets the owning agent read a skill folder without a grant", () => {
    expect(decide(req({}), [], opts).kind).toBe("pass");
    expect(decide(req({ paths: ["/Users/v/.claude/skills/review/SKILL.md"] }), [], opts).kind).toBe("pass");
    expect(decide(req({ agent: "cursor", paths: ["/Users/v/proj/.cursor/skills/a.md"] }), [], opts).kind).toBe("pass");
    expect(decide(req({ agent: "cursor", paths: ["/Users/v/.agents/skills/a.md"] }), [], opts).kind).toBe("pass");
    expect(decide(req({ agent: "codex" as HookRequest["agent"], paths: ["/Users/v/.codex/skills/a.md"] }), [], opts).kind).toBe("pass");
    expect(decide(req({ paths: ["/Users/v/.claude/plugins/a.md"] }), [], opts).kind).toBe("pass");
    expect(decide(req({ paths: ["/Users/v/.claude/commands/a.md"] }), [], opts).kind).toBe("pass");
    expect(decide(req({ agent: "cursor", paths: ["/Users/v/.cursor/skills-cursor/a.md"] }), [], opts).kind).toBe("pass");
  });

  it("still prompts for write, another agent, a turned-off rule, and a sensitive file", () => {
    expect(decide(req({ access: "write" }), [], opts).kind).toBe("prompt");
    expect(decide(req({ agent: "cursor" }), [], opts).kind).toBe("prompt");
    expect(decide(req({ paths: ["/Users/v/proj/.claude/skills-extra/a.md"] }), [], opts).kind).toBe("prompt");
    expect(decide(req({}), [], { ...opts, autoAllowOff: ["claude-skills"] }).kind).toBe("prompt");
    expect(decide(req({ paths: ["/Users/v/proj/.claude/skills/.env"] }), [], opts).kind).toBe("prompt");
  });

  it("still denies lockdown and protected files inside an automatic folder", () => {
    expect(decide(req({}), [], { ...opts, lockdown: true }).kind).toBe("deny");
    expect(decide(req({ paths: ["/secret/.claude/skills/a.md"] }), [], opts).kind).toBe("deny");
  });

  it("allows both read and write for folders configured with write: true", () => {
    const agy = (over: Partial<HookRequest>): HookRequest => ({
      agent: "antigravity",
      event: "PreToolUse",
      tool: "write_file",
      access: "write",
      paths: ["/Users/v/.gemini/antigravity-cli/cache/onboarding.json"],
      cwd: "/Users/v",
      ...over,
    });
    expect(decide(agy({ access: "read" }), [], opts).kind).toBe("pass");
    expect(decide(agy({ access: "write" }), [], opts).kind).toBe("pass");
    expect(decide(agy({ paths: ["/Users/v/.gemini/antigravity-cli/log/cli-1.log"] }), [], opts).kind).toBe("pass");
    expect(decide(agy({ paths: ["/Users/v/.gemini/antigravity-cli/crashes/dump.dmp"] }), [], opts).kind).toBe("pass");
    expect(decide(agy({ paths: ["/Users/v/.gemini/antigravity-cli/brain/sess/transcript.jsonl"] }), [], opts).kind).toBe("pass");
    expect(decide(agy({ agent: "cursor" }), [], opts).kind).toBe("prompt");
    expect(decide(agy({}), [], { ...opts, autoAllowOff: ["antigravity-cache"] }).kind).toBe("prompt");
  });
});
