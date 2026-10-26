import { describe, expect, it } from "vitest";
import { diagnosticsReport } from "../../src/shared/diagnostics";

const base = { claude: true, cursor: true, codex: true, gemini: true, antigravity: true, hermes: true, helperStatus: "running", lastSweep: null, hookP50Ms: null, hookP95Ms: null, lastDecision: null };

describe("diagnosticsReport", () => {
  it("lists each agent hook and only current failures", () => {
    const report = diagnosticsReport({ ...base, claude: false, helperStatus: "not installed", lastDecision: { ts: 1, agent: "cursor", tool: "Read", verdict: "pass", reason: null } });
    expect(report.hooks.map((hook) => [hook.label, hook.status])).toEqual([
      ["Claude", "missing"],
      ["Cursor", "installed"],
      ["Codex", "installed"],
      ["Gemini CLI", "installed"],
      ["Antigravity", "installed"],
      ["Hermes", "installed"],
    ]);
    expect(report.errors).toEqual(["Claude hook is not installed.", "History helper is not installed."]);
    expect(report.lastDecision?.verdict).toBe("pass");
  });

  it("reports no errors when the hooks are installed and the helper is running", () => {
    expect(diagnosticsReport(base).errors).toEqual([]);
  });
});
