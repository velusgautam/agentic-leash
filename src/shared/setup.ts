export type HelperState = "running" | "stopped" | "skipped";
export type ActionKind = "hook" | "helper" | "fda";
export type ActionState = "checking" | "ready" | "working" | "done" | "failed";

export interface SetupAgent {
  id: string;
  installed: boolean;
  enabled: boolean;
  hooks: boolean | null;
}

export interface SetupStatus {
  helper: HelperState;
  fda: boolean;
  agents: SetupAgent[];
  ready: boolean;
}

const HOOK_IDS = new Set(["claude-code", "cursor", "codex", "gemini", "antigravity", "hermes"]);

export function isHookAgent(id: string): id is "claude-code" | "cursor" | "codex" | "gemini" | "antigravity" | "hermes" {
  return HOOK_IDS.has(id);
}
const BANNER_IDS = new Set(["claude-code", "cursor", "codex", "gemini", "antigravity", "hermes"]);

export const HISTORY_AGENT: Record<string, string> = {
  "claude-code": "claude",
  cursor: "cursor-agent",
  codex: "codex",
  gemini: "gemini",
  antigravity: "antigravity",
  hermes: "hermes",
};

function turnedOn(agent: SetupAgent): boolean {
  return HOOK_IDS.has(agent.id) && agent.installed && agent.enabled;
}

export function setupReady(status: { helper: HelperState; fda: boolean; agents: SetupAgent[] }, onboarded = false): boolean {
  if (status.helper === "stopped" || !status.fda) return false;
  const active = status.agents.filter(turnedOn);
  if (active.length === 0 || active.some((agent) => agent.hooks === true)) return true;
  return onboarded;
}

export function rememberOnboarding(already: boolean, agents: SetupAgent[]): boolean {
  return already || agents.some((agent) => turnedOn(agent) && agent.hooks === true);
}

export function visibleAgent(agent: { installed: boolean; enabled: boolean }): boolean {
  return agent.installed && agent.enabled;
}

export function needsAgentBanner(agents: SetupAgent[]): boolean {
  return !agents.some((agent) => BANNER_IDS.has(agent.id) && agent.installed);
}

const LABELS: Record<ActionKind, Record<ActionState, string>> = {
  hook: { checking: "Checking…", ready: "Install", working: "Installing…", done: "Installed", failed: "Retry" },
  helper: { checking: "Checking…", ready: "Install", working: "Installing…", done: "Running", failed: "Retry" },
  fda: { checking: "Checking…", ready: "Open Full Disk Access", working: "Opening…", done: "Granted", failed: "Retry" },
};

export function actionLabel(kind: ActionKind, state: ActionState): string {
  return LABELS[kind][state];
}

export function actionState(input: { known: boolean; busy: boolean; failed: boolean; done: boolean }): ActionState {
  if (!input.known) return "checking";
  if (input.busy) return "working";
  if (input.failed && !input.done) return "failed";
  if (input.done) return "done";
  return "ready";
}

export function claudeSurface(exe: string): "Desktop" | "CLI" | null {
  if (exe.includes("/Claude.app/")) return "Desktop";
  const base = exe.split("/").pop() ?? "";
  if (base === "claude" || exe.includes("/claude-code")) return "CLI";
  return null;
}

export function desktopAppPresent(app: string, home: string, exists: (path: string) => boolean, platform = process.platform): boolean {
  const root = home.endsWith("/") || home.endsWith("\\") ? home.slice(0, -1) : home;
  if (platform === "darwin") {
    return exists(`/Applications/${app}.app`) || exists(`${root}/Applications/${app}.app`);
  }
  if (platform === "linux") {
    const lower = app.toLowerCase();
    return (
      exists(`/usr/share/applications/${lower}.desktop`) ||
      exists(`${root}/.local/share/applications/${lower}.desktop`) ||
      exists(`/opt/${app}/${lower}`) ||
      exists(`/opt/${app}`) ||
      exists(`/snap/bin/${lower}`)
    );
  }
  if (platform === "win32") {
    return (
      exists(`${root}\\AppData\\Local\\Programs\\${app.toLowerCase()}\\${app}.exe`) ||
      exists(`${root}\\AppData\\Local\\Programs\\${app}\\${app}.exe`) ||
      exists(`C:\\Program Files\\${app}\\${app}.exe`) ||
      exists(`C:\\Program Files (x86)\\${app}\\${app}.exe`)
    );
  }
  return false;
}

export function macAppPresent(app: string, home: string, exists: (path: string) => boolean): boolean {
  return desktopAppPresent(app, home, exists, "darwin");
}

export function setupProgress(status: { helper: HelperState; fda: boolean; agents: SetupAgent[] }): { done: number; total: number } {
  const active = status.agents.filter(turnedOn);
  const steps = [active.length === 0 || active.some((agent) => agent.hooks === true), status.helper !== "stopped", status.fda];
  return { done: steps.filter(Boolean).length, total: steps.length };
}
