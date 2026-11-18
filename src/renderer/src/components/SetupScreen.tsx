import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { setupProgress, type SetupAgent } from "../../../shared/setup";
import { FullDiskControl } from "~/components/FullDiskControl";
import { LeashMark } from "~/components/Icons";
import { PageContainer, SettingsRow, SettingsSection } from "~/components/settings";
import { SetupButton } from "~/components/SetupButton";
import { Button } from "~/components/ui/button";
import { useSetup } from "~/components/useSetup";
import { SecureAreasManager } from "~/routes/grants";

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
  if (!rows.length) return <SettingsRow title="Hooks" description="Hooks let Agentic Leash ask you before an agent reads or writes inside your Secure Areas. Claude, Cursor, Codex, Gemini, Antigravity, and Hermes are not on this Mac yet. This step can wait." />;
  return rows.map((agent) => {
    const hook = HOOKS[agent.id];
    if (!hook) return null;
    return (
      <SettingsRow
        key={agent.id}
        title={hook.title}
        description="Hooks let Agentic Leash ask you before an agent reads or writes inside your Secure Areas. New sessions pick them up after a restart."
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
  const [secureAreasDone, setSecureAreasDone] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    void window.leash.isSecureAreasSetupDone().then(setSecureAreasDone);
  }, []);

  const baseProgress = status ? setupProgress(status) : null;
  const doneCount = baseProgress ? baseProgress.done + (secureAreasDone ? 1 : 0) : null;
  const totalCount = baseProgress ? baseProgress.total + 1 : null;
  const helperSkipped = status?.helper === "skipped";

  const confirmSecureAreas = () => {
    setConfirming(true);
    void window.leash
      .setSecureAreasSetupDone(true)
      .then(() => {
        setSecureAreasDone(true);
        refresh();
      })
      .finally(() => setConfirming(false));
  };

  return (
    <div className="flex h-dvh flex-col bg-background">
      {/* Traffic lights sit in this strip and hide in fullscreen, so the brand stays left. */}
      <div className="drag-region h-13 shrink-0" />
      <div className="drag-region flex items-center gap-3 border-b border-border px-5 py-3">
        <LeashMark className="h-7 w-auto shrink-0" />
        <span className="text-base font-semibold tracking-tight">Agentic Leash</span>
        <span className="rounded-md border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
          Beta
        </span>
      </div>
      <PageContainer>
        <div className="px-3 sm:px-4">
          <h1 className="text-lg font-medium">Set up this Mac</h1>
          <p className="mt-1 text-sm text-muted-foreground">Install hooks for one agent, set up the history helper and Full Disk Access, and confirm your Secure Areas.</p>
          {doneCount !== null && totalCount !== null ? <p className="mt-1 text-sm font-medium">{doneCount} of {totalCount} done</p> : null}
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
        <SettingsSection title="4. Secure Areas">
          <SettingsRow
            title="Confirm your Secure Areas"
            description="Every entry below is pre-selected to protect secrets, personal data, and startup files. Requests outside Secure Areas are auto-accepted and logged."
            control={
              <Button size="sm" disabled={confirming} onClick={confirmSecureAreas}>
                {secureAreasDone ? <><Check className="size-3.5" aria-hidden />Confirmed</> : confirming ? "Saving…" : "Confirm Secure Areas"}
              </Button>
            }
          />
        </SettingsSection>
        <SecureAreasManager compact />
        <div className="flex justify-end pb-4">
          <Button size="sm" disabled={confirming} onClick={confirmSecureAreas}>
            {secureAreasDone ? <><Check className="size-3.5" aria-hidden />Confirmed</> : confirming ? "Saving…" : "Confirm Secure Areas"}
          </Button>
        </div>
      </PageContainer>
    </div>
  );
}
