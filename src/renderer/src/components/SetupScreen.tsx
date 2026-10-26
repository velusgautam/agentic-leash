import { setupProgress, type SetupAgent } from "../../../shared/setup";
import { FullDiskControl } from "~/components/FullDiskControl";
import { LeashMark } from "~/components/Icons";
import { PageContainer, SettingsRow, SettingsSection } from "~/components/settings";
import { SetupButton } from "~/components/SetupButton";
import { Button } from "~/components/ui/button";
import { useSetup } from "~/components/useSetup";

const HOOKS: Record<string, { title: string; id: "claude-code" | "cursor" | "codex" | "gemini" | "antigravity" | "hermes" }> = {
  "claude-code": { title: "Claude hooks", id: "claude-code" },
  cursor: { title: "Cursor hooks", id: "cursor" },
  codex: { title: "Codex hooks", id: "codex" },
  gemini: { title: "Gemini CLI hooks", id: "gemini" },
  antigravity: { title: "Antigravity hooks", id: "antigravity" },
  hermes: { title: "Hermes hooks", id: "hermes" },
};

function HookRows({ agents }: { agents: SetupAgent[] }) {
  const { run } = useSetup();
  const rows = agents.filter((agent) => agent.hooks !== null && agent.installed && agent.enabled);
  if (!rows.length) return <SettingsRow title="Hooks" description="Hooks let Agentic Leash ask you before an agent reads or writes outside the folders you've allowed. Claude, Cursor, Codex, Gemini, Antigravity, and Hermes are not on this Mac yet. This step can wait." />;
  return rows.map((agent) => {
    const hook = HOOKS[agent.id];
    if (!hook) return null;
    return (
      <SettingsRow
        key={agent.id}
        title={hook.title}
        description="Hooks let Agentic Leash ask you before an agent reads or writes outside the folders you've allowed. New sessions pick them up after a restart."
        control={
          <span className="flex items-center gap-2">
            <SetupButton kind="hook" actionKey={agent.id} done={agent.hooks === true} onClick={() => window.leash.installHooks(hook.id)} />
            {agent.hooks ? <Button size="sm" variant="outline" onClick={() => run(`${agent.id}:off`, () => window.leash.uninstallHooks(hook.id))}>Uninstall</Button> : null}
          </span>
        }
      />
    );
  });
}

export function SetupScreen() {
  const { status, refresh } = useSetup();
  const progress = status ? setupProgress(status) : null;
  const helperSkipped = status?.helper === "skipped";
  return (
    <div className="flex h-dvh flex-col bg-background">
      {/* Traffic lights sit in this strip and hide in fullscreen, so the brand stays left. */}
      <div className="drag-region h-13 shrink-0" />
      <div className="drag-region flex items-center gap-3 border-b border-border px-5 py-3">
        <LeashMark className="h-7 w-auto shrink-0" />
        <span className="text-base font-semibold tracking-tight">Agentic Leash</span>
      </div>
      <PageContainer>
        <div className="px-3 sm:px-4">
          <h1 className="text-lg font-medium">Set up this Mac</h1>
          <p className="mt-1 text-sm text-muted-foreground">Install hooks for one agent, plus the history helper and Full Disk Access. The other agents can wait.</p>
          {progress ? <p className="mt-1 text-sm font-medium">{progress.done} of {progress.total} done</p> : null}
        </div>
        <SettingsSection title="1. Hooks">
          <HookRows agents={status?.agents ?? []} />
        </SettingsSection>
        <SettingsSection title="2. History helper">
          <SettingsRow
            title="File history helper"
            description={helperSkipped ? "The helper records which files each agent touched, so you can see diffs and spot sensitive reads later. Available in the installed app." : "The helper records which files each agent touched, so you can see diffs and spot sensitive reads later. Installs a root LaunchDaemon. macOS asks for an administrator password."}
            control={helperSkipped ? <Button size="sm" disabled>Available in the installed app</Button> : <SetupButton kind="helper" actionKey="helper" done={status?.helper === "running"} onClick={() => window.leash.installHelper()} />}
          />
        </SettingsSection>
        <SettingsSection title="3. Full Disk Access">
          <SettingsRow
            title="Full Disk Access"
            description="macOS needs this so the helper can see file activity in every folder. Opens the Full Disk Access pane. If Agentic Leash is missing, click + and add Agentic Leash.app."
            control={<span className="flex items-center gap-2"><FullDiskControl />{status?.fda === false ? <Button size="sm" variant="outline" onClick={refresh}>Check again</Button> : null}</span>}
          />
        </SettingsSection>
      </PageContainer>
    </div>
  );
}
