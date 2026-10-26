export interface DiagnosticHook {
  agent: string;
  label: string;
  status: "installed" | "missing" | "none";
}

export interface DiagnosticDecision {
  ts: number;
  agent: string;
  tool: string;
  verdict: string;
  reason: string | null;
}

export interface DiagnosticReport {
  hooks: DiagnosticHook[];
  helperStatus: string;
  lastSweep: string | null;
  hookP50Ms: number | null;
  hookP95Ms: number | null;
  lastDecision: DiagnosticDecision | null;
  errors: string[];
}

export function diagnosticsReport(input: {
  claude: boolean;
  cursor: boolean;
  codex: boolean;
  gemini: boolean;
  antigravity: boolean;
  hermes: boolean;
  helperStatus: string;
  lastSweep: string | null;
  hookP50Ms: number | null;
  hookP95Ms: number | null;
  lastDecision: DiagnosticDecision | null;
}): DiagnosticReport {
  const hooks: DiagnosticHook[] = [
    { agent: "claude-code", label: "Claude", status: input.claude ? "installed" : "missing" },
    { agent: "cursor", label: "Cursor", status: input.cursor ? "installed" : "missing" },
    { agent: "codex", label: "Codex", status: input.codex ? "installed" : "missing" },
    { agent: "gemini", label: "Gemini CLI", status: input.gemini ? "installed" : "missing" },
    { agent: "antigravity", label: "Antigravity", status: input.antigravity ? "installed" : "missing" },
    { agent: "hermes", label: "Hermes", status: input.hermes ? "installed" : "missing" },
  ];
  const errors = [
    ...hooks.filter((hook) => hook.status === "missing").map((hook) => `${hook.label} hook is not installed.`),
    ...(input.helperStatus === "running" ? [] : [`History helper is ${input.helperStatus}.`]),
  ];
  return { hooks, helperStatus: input.helperStatus, lastSweep: input.lastSweep, hookP50Ms: input.hookP50Ms, hookP95Ms: input.hookP95Ms, lastDecision: input.lastDecision, errors };
}
