import { useEffect, useState, type ReactNode } from "react";
import { useParams } from "@tanstack/react-router";
import { FolderOpen, Globe, Lock, Plug, ShieldCheck, ShieldX, type LucideIcon } from "lucide-react";
import { isHookAgent } from "../../../shared/setup";
import { revokeDue, type RevokePreset } from "../../../shared/revokeWhen";
import type { AgentId, AgentSnapshot, Enforcement, ScheduledRevoke } from "../../../shared/types";
import { ConfirmAction, TRUST_EFFECTS } from "~/components/ConfirmAction";
import { FullDiskControl } from "~/components/FullDiskControl";
import { AGENT_LABELS, AgentIcon } from "~/components/Icons";
import { PageContainer, SettingsSection } from "~/components/settings";
import { SetupButton } from "~/components/SetupButton";
import { useSetup } from "~/components/useSetup";
import { Button } from "~/components/ui/button";
import { accessTone, Pill, type PillTone } from "~/components/ui/pill";

const ENFORCEMENT: Record<Enforcement, { label: string; tone: PillTone; hint: string }> = {
  hook: { label: "Hooks enforce", hint: "Agentic Leash asks before each tool call.", tone: "emerald" },
  rules: { label: "Rules mode", hint: "Hooks are blocked here, so Agentic Leash writes the agent's own allow rules instead.", tone: "amber" },
  "monitor-only": { label: "Monitor only", hint: "Activity is recorded but nothing is blocked.", tone: "muted" },
};

function Row({ icon, locked, children, action }: { icon: ReactNode; locked: boolean; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 text-sm">
      <span className="text-muted-foreground">{icon}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
      {locked ? (
        <span title="Set by your organization's managed policy. Can't be changed locally.">
          <Pill><Lock className="size-3" />Org locked</Pill>
        </span>
      ) : action}
    </div>
  );
}

const MCP_FILES: Record<string, string> = { "claude-code": "~/.claude.json", cursor: "~/.cursor/mcp.json", gemini: "~/.gemini/settings.json", antigravity: "~/.gemini/config/mcp_config.json" };

const PRESETS: { preset: RevokePreset; label: string }[] = [
  { preset: "hour", label: "In 1 hour" },
  { preset: "tonight", label: "Tonight" },
  { preset: "tomorrow", label: "Tomorrow" },
];

function TrustActions({ path, dueAt, onChange }: { path: string; dueAt?: number; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const done = () => {
    setOpen(false);
    onChange();
  };
  if (dueAt) {
    return (
      <span className="flex items-center gap-2">
        <span className="text-xs whitespace-nowrap text-muted-foreground">Revokes {new Date(dueAt).toLocaleString()}</span>
        <Button size="sm" variant="outline" onClick={() => void window.leash.cancelTrust(path).then(onChange)}>Cancel</Button>
      </span>
    );
  }
  return (
    <span className="relative flex items-center gap-2">
      <ConfirmAction
        trigger={<Button size="sm" variant="destructive-outline">Revoke</Button>}
        title="Revoke Claude's trust for this folder?"
        description={path}
        effects={TRUST_EFFECTS}
        confirmLabel="Revoke"
        onConfirm={() => void window.leash.revokeTrust(path).then(done)}
      />
      <Button size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen((value) => !value)}>Revoke later…</Button>
      {open ? (
        <span className="dropdown-glass absolute top-9 right-0 z-20 flex w-56 flex-col gap-1 rounded-lg border border-border p-1.5 text-popover-foreground shadow-md">
          {PRESETS.map((item) => (
            <Button key={item.preset} size="sm" variant="ghost" className="justify-start" onClick={() => void window.leash.scheduleTrust(path, revokeDue(item.preset)).then(done)}>
              {item.label}
            </Button>
          ))}
          <label className="px-2 py-1 text-xs text-muted-foreground">
            Custom
            <input aria-label="Revoke at" className="mt-1 w-full bg-transparent text-sm text-foreground" type="datetime-local" value={custom} onChange={(event) => setCustom(event.target.value)} />
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={!custom || new Date(custom).getTime() <= Date.now()}
            onClick={() => void window.leash.scheduleTrust(path, new Date(custom).getTime()).then(done)}
          >
            Set
          </Button>
        </span>
      ) : null}
    </span>
  );
}

function Empty({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return <p className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground"><Icon className="size-4" aria-hidden />{children}</p>;
}

export function AgentPage() {
  const { agentId } = useParams({ from: "/agents/$agentId" });
  const [agent, setAgent] = useState<AgentSnapshot | null>(null);
  const [scheduled, setScheduled] = useState<ScheduledRevoke[]>([]);
  const load = () => {
    void window.leash.listAgents().then((agents) => setAgent(agents.find((item) => item.id === agentId) ?? null));
    void window.leash.scheduledRevokes().then(setScheduled);
  };
  useEffect(() => {
    load();
    const off = window.leash.onAgents(load);
    const timer = window.setInterval(load, 10000);
    return () => {
      off();
      window.clearInterval(timer);
    };
  }, [agentId]);
  const { status } = useSetup();
  const hook = status?.agents.find((item) => item.id === agentId);
  const name = agent?.name ?? AGENT_LABELS[agentId] ?? agentId;
  const enforcement = agent ? ENFORCEMENT[agent.enforcement] : null;
  return (
    <PageContainer>
      <header className="flex items-start gap-4">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-card shadow-xs/5">
          <AgentIcon agent={agentId} className="size-6" />
        </div>
        <div className="min-w-0 space-y-1.5">
          <h1 className="text-lg font-semibold tracking-tight">{name}</h1>
          <div className="flex flex-wrap items-center gap-2">
            {agent?.installed ? <Pill tone="emerald">● Installed</Pill> : <Pill>Not installed</Pill>}
            {agent?.installed && enforcement ? <Pill tone={enforcement.tone} title={enforcement.hint}>{enforcement.label}</Pill> : null}
            {agent?.children.map((id) => (
              <Pill key={id} tone="subtle"><AgentIcon agent={id} className="size-3" />{AGENT_LABELS[id] ?? id}</Pill>
            ))}
          </div>
          {agent?.installed && agent.note ? <p className="text-sm text-muted-foreground">{agent.note}</p> : null}
          {agent && !agent.installed ? <p className="text-sm text-muted-foreground">Not installed on this Mac.</p> : null}
        </div>
      </header>
      {hook && hook.hooks === false && hook.installed ? (
        <div role="status" className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
          <span>Install hooks so this agent is asked before it reads or writes.</span>
          {isHookAgent(agentId) ? <SetupButton kind="hook" actionKey={agentId} done={false} onClick={() => window.leash.installHooks(agentId)} /> : null}
        </div>
      ) : null}
      <SettingsSection title="Folders">
        {agent?.folders.length ? agent.folders.map((folder) => (
          <Row
            key={`${folder.source}:${folder.path}`}
            icon={<FolderOpen className="size-4" />}
            locked={folder.locked}
            action={folder.source === "~/.claude.json" ? <TrustActions path={folder.path} dueAt={scheduled.find((item) => item.path === folder.path)?.dueAt} onChange={load} /> : undefined}
          >
            <span className="font-mono text-xs">{folder.path}</span>
            <Pill tone={accessTone(folder.access)}>{folder.access}</Pill>
            <span className="text-xs text-muted-foreground">{folder.source}</span>
          </Row>
        )) : <Empty icon={FolderOpen}>No folders</Empty>}
      </SettingsSection>
      <SettingsSection title="MCP servers">
        {agent?.mcpServers.length ? agent.mcpServers.map((server) => (
          <Row
            key={`${server.source}:${server.name}`}
            icon={<Plug className="size-4" />}
            locked={server.locked}
            action={agentId === "codex" ? undefined : (
              <ConfirmAction
                trigger={<Button size="sm" variant="outline">Remove</Button>}
                title={`Remove the ${server.name} MCP server?`}
                description={MCP_FILES[agentId] ?? server.source}
                effects={["Deletes this server entry from the config file. A .bak is written first.", "New sessions no longer load its tools. If the agent is running, you'll be offered a restart."]}
                confirmLabel="Remove"
                onConfirm={() => void window.leash.removeMcp(agentId as AgentId, server.name).then(load)}
              />
            )}
          >
            <span className="font-medium">{server.name}</span>
            <span className="font-mono text-xs text-muted-foreground">{server.command || server.url || "stdio"}</span>
            <span className="text-xs text-muted-foreground">{server.source}</span>
          </Row>
        )) : <Empty icon={Plug}>No MCP servers</Empty>}
      </SettingsSection>
      <SettingsSection title="Network">
        {agent?.network.length ? agent.network.map((rule) => (
          <Row key={`${rule.source}:${rule.rule}`} icon={<Globe className="size-4" />} locked={rule.locked}>
            <Pill tone={rule.effect === "allow" ? "emerald" : "red"}>{rule.effect}</Pill>
            <span className="font-mono text-xs">{rule.rule}</span>
            <span className="text-xs text-muted-foreground">{rule.source}</span>
          </Row>
        )) : <Empty icon={Globe}>No network rules</Empty>}
      </SettingsSection>
      <SettingsSection title="macOS Privacy">
        {agent?.privacy.length ? agent.privacy.map((row) => (
          <Row
            key={`${row.bundleId}:${row.service}`}
            icon={row.authValue ? <ShieldCheck className="size-4 text-emerald-500" /> : <ShieldX className="size-4 text-red-500" />}
            locked={false}
            action={row.bundleId.startsWith("/") ? undefined : (
              <ConfirmAction
                trigger={<Button size="sm" variant="outline">Reset</Button>}
                title={`Reset ${row.service.replace(/^kTCCService/, "")} access?`}
                description={row.via ?? row.bundleId}
                effects={["Runs tccutil reset for this app and service.", "macOS asks for permission again the next time the app needs it."]}
                confirmLabel="Reset"
                onConfirm={() => void window.leash.resetTcc(row.service, row.bundleId).then(load)}
              />
            )}
          >
            <span>{row.service.replace(/^kTCCService/, "")}</span>
            <Pill tone={row.authValue ? "emerald" : "red"}>{row.authValue ? "granted" : "denied"}</Pill>
            {row.via ? <span className="text-xs text-muted-foreground">{row.via}</span> : null}
          </Row>
        )) : (
          <div className="flex items-center justify-between gap-3 px-4 py-4">
            <p className="flex items-center gap-2 text-sm text-muted-foreground"><Lock className="size-4 shrink-0" aria-hidden />Privacy grants show up here once Full Disk Access is on.</p>
            <FullDiskControl />
          </div>
        )}
      </SettingsSection>
    </PageContainer>
  );
}
