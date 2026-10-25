import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Check, CircleHelp, Eye, FolderLock, KeyRound, Lock, LockOpen, Pencil, ScrollText, ShieldOff, SquareTerminal, Timer, Users, X, type LucideIcon } from "lucide-react";
import { decisionTarget } from "../../../shared/decisionView";
import { viewGrants, type GrantSortKey, type SortDir } from "../../../shared/grantView";
import { isHomeFolder } from "../../../shared/parents";
import { denyCountdown, pendingSecondsLeft, POPUP_TIMEOUT_S } from "../../../shared/pending";
import type { AllowRule, DecisionRow, Grant, PendingRequest, PresetId, RuleSuggestion } from "../../../shared/types";
import { AllowButtons, ApprovalChoices, allowLabel } from "~/components/ApprovalChoices";
import { ConfirmAction, grantEffects, REVOKE_ALL_EFFECTS } from "~/components/ConfirmAction";
import { AGENT_LABELS, AgentIcon } from "~/components/Icons";
import { PageContainer, SettingsSection } from "~/components/settings";
import { Button } from "~/components/ui/button";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import { accessTone, Pill, verdictTone } from "~/components/ui/pill";
import { Tabs, TabsList, TabsPanel, TabsTab } from "~/components/ui/tabs";
import { toast, toastRevoked } from "~/components/ui/toast";
import { useLeashData, usePending } from "~/hooks/useLeash";
import { cn } from "~/lib/utils";
import { AllowList, AutomaticAllows, BlockedList } from "./access-parts";

function remaining(expiresAt: number | null): string {
  if (expiresAt === null) return "Forever";
  const seconds = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
  return `${seconds}s`;
}

const VERDICT_ICON: Record<string, LucideIcon> = { allow: Check, pass: Check, deny: X, ask: CircleHelp };

function AccessPill({ access }: { access: string }) {
  const Icon = access === "write" ? Pencil : Eye;
  return <Pill tone={accessTone(access)}><Icon className="size-3" aria-hidden />{access}</Pill>;
}

function VerdictPill({ verdict }: { verdict: string }) {
  const Icon = VERDICT_ICON[verdict];
  return <Pill tone={verdictTone(verdict)} className="shrink-0">{Icon ? <Icon className="size-3" aria-hidden /> : null}{verdict}</Pill>;
}

const agentName = (agent: string) => (agent === "*" ? "All agents" : AGENT_LABELS[agent] ?? agent);
const SOURCE_LABELS: Record<string, string> = { leash: "Agentic Leash", config: "Agent config" };

function when(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function Agent({ agent }: { agent: string }) {
  return (
    <span className="flex items-center gap-1.5 text-xs">
      {agent === "*" ? <Users className="size-3.5 text-muted-foreground" aria-hidden /> : <AgentIcon agent={agent} className="size-3.5" />}
      {agentName(agent)}
    </span>
  );
}

function PendingRow({ item, now }: { item: PendingRequest; now: number }) {
  const [scope, setScope] = useState<string | null>(item.policy?.scope ?? null);
  const request = item.request;
  const allow = (choice: PresetId) =>
    void window.leash.decidePending(item.id, "allow", null, scope ?? undefined, choice).then(() => { toast({ title: "Allowed", description: allowLabel(scope, choice, item.policy?.repo ?? null) }); });
  const deny = (never: boolean) =>
    void window.leash.decidePending(item.id, never ? "never" : "deny", null, scope ?? undefined).then(() => {
      toast({ title: never ? "Never allowed" : "Denied", action: { label: "Undo", onClick: () => void window.leash.undoDeny(item.id).then(() => { toast({ title: "Undone", description: "The agent's next try asks again." }); }) } });
    });
  return (
    <div className="flex flex-col gap-3 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Agent agent={request.agent} />
        <AccessPill access={request.access} />
        <span className="font-mono text-xs">{request.tool}</span>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">{denyCountdown(pendingSecondsLeft(item.askedAt, now, POPUP_TIMEOUT_S))}</span>
      </div>
      <ApprovalChoices request={request} policy={item.policy} scope={scope} onScope={setScope} />
      <AllowButtons policy={item.policy} scope={scope} onAllow={allow} />
      <div className="flex flex-wrap items-center gap-2">
        <span className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" className="text-muted-foreground" title="Always deny this for this agent. Remove it under Blocked." onClick={() => deny(true)}>Never</Button>
          <Button size="sm" variant="outline" onClick={() => deny(false)}>Deny</Button>
        </span>
      </div>
    </div>
  );
}

const tilde = (path: string) => path.replace(/^\/(Users|home)\/[^/]+/, "~");

function SuggestionRow({ item }: { item: RuleSuggestion }) {
  const target = item.command ?? (item.path ? tilde(item.path) : "");
  const home = item.path !== null && isHomeFolder(item.path);
  const fail = (error: unknown) => { toast({ title: "Could not update suggestion", description: error instanceof Error ? error.message : String(error), tone: "destructive" }); };
  return (
    <div className="flex items-center gap-3 px-4 py-3 text-sm">
      <AgentIcon agent={item.agent} className="size-4 shrink-0" />
      <p className="min-w-0 flex-1 text-xs">
        {agentName(item.agent)} got {item.access} access to <span className="font-mono font-medium break-all">{target}</span> {item.count} {item.count === 1 ? "time" : "times"} in 2 weeks
      </p>
      <Button size="sm" variant={home ? "destructive" : "default"} onClick={() => void window.leash.acceptSuggestion(item.key).then(() => { toast({ title: "Always allowed" }); }, fail)}>Make it Always</Button>
      <Button size="sm" variant="ghost" onClick={() => void window.leash.dismissSuggestion(item.key).then(() => { toast({ title: "Suggestion dismissed" }); }, fail)}>Dismiss</Button>
    </div>
  );
}

const RULE_AGENTS = new Set(["*", "claude-code", "cursor", "codex", "gemini", "antigravity", "hermes"]);

function makeAlways(grant: Grant) {
  const rule = { kind: grant.command == null ? "folder" : "command", agent: grant.agent, value: grant.command ?? grant.path } as AllowRule;
  void window.leash.createRule(rule).then((result) => {
    if (result.error) {
      toast({ title: "Could not always allow", description: result.error, tone: "destructive" });
      return;
    }
    return window.leash.revokeGrant(grant.id).then(() => { toast({ title: "Always allowed", description: rule.value }); });
  }, (error: unknown) => { toast({ title: "Could not always allow", description: error instanceof Error ? error.message : String(error), tone: "destructive" }); });
}

function GrantRow({ grant, mono, Icon, onRevoke }: { grant: Grant; mono: string; Icon: typeof FolderLock; onRevoke: (grant: Grant) => void }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 text-sm">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="overflow-x-auto font-mono text-xs font-medium whitespace-nowrap">{mono}</div>
        <div className="flex flex-wrap items-center gap-2">
          <Agent agent={grant.agent} />
          <AccessPill access={grant.access} />
          <span className="text-xs text-muted-foreground tabular-nums" title={when(grant.createdAt)}>Approved {when(grant.createdAt)}</span>
          <Pill tone="subtle" title={grant.expiresAt === null ? "Forever" : when(grant.expiresAt)}><Timer className="size-3" aria-hidden />{remaining(grant.expiresAt)}</Pill>
          {grant.idleSeconds ? <Pill tone="subtle" title="Stays alive while the agent keeps using it. Lapses after 30 idle minutes, at most 12 hours.">This session</Pill> : null}
          <span className="text-xs text-muted-foreground">{SOURCE_LABELS[grant.source] ?? grant.source}</span>
        </div>
      </div>
      {grant.expiresAt !== null && grant.source === "leash" && !grant.idleSeconds ? (
        <Button size="sm" variant="ghost" aria-label="Extend by 1 hour" onClick={() => void window.leash.extendGrant(grant.id, 3600).then(({ expiresAt }) => { if (expiresAt === null) toast({ title: "Could not extend", description: "This grant can't be extended.", tone: "destructive" }); else toast({ title: "Extended by 1 hour" }); }, (error: unknown) => { toast({ title: "Could not extend", description: error instanceof Error ? error.message : String(error), tone: "destructive" }); })}>+1 h</Button>
      ) : null}
      {grant.expiresAt !== null && grant.source === "leash" && RULE_AGENTS.has(grant.agent) ? (
        <ConfirmAction
          trigger={<Button size="sm" variant="outline">Always allow</Button>}
          title="Always allow this?"
          description={grant.command == null ? `${agentName(grant.agent)} can read and write in ${grant.path} from now on, without asking. Secret files still ask.` : `${agentName(grant.agent)} can run this exact command from now on, without asking.`}
          effects={["The grant is replaced by a rule under Always.", "Remove the rule there to ask again."]}
          confirmLabel="Always allow"
          icon={Check}
          onConfirm={() => makeAlways(grant)}
        />
      ) : null}
      <ConfirmAction
        trigger={<Button size="sm" variant="destructive-outline">Revoke</Button>}
        title="Revoke this grant?"
        description={mono}
        effects={grantEffects(grant)}
        confirmLabel="Revoke"
        onConfirm={() => onRevoke(grant)}
      />
    </div>
  );
}

function GrantList({ grants, agent, sort, dir, onAgent, onSort, onRevoke }: { grants: Grant[]; agent: string; sort: GrantSortKey; dir: SortDir; onAgent: (agent: string) => void; onSort: (sort: GrantSortKey) => void; onRevoke: (grant: Grant) => void }) {
  const agents = [...new Set(grants.map((grant) => grant.agent))].sort((a, b) => agentName(a).localeCompare(agentName(b)));
  const folders = viewGrants(grants.filter((grant) => grant.command == null), { agent, sort, dir });
  const commands = viewGrants(grants.filter((grant) => grant.command != null), { agent, sort, dir });
  const sorts = [
    { key: "approved" as const, label: "Approved", asc: "oldest first", desc: "newest first" },
    { key: "expires" as const, label: "Expires", asc: "soon first", desc: "last first" },
  ];
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 px-3">
        <div className="inline-flex flex-wrap rounded-lg border border-border p-0.5">
          {["all", ...agents].map((id) => (
            <button key={id} type="button" aria-pressed={agent === id} onClick={() => onAgent(id)} className={cn("rounded-md px-2.5 py-1 text-xs", agent === id ? "bg-accent font-medium" : "text-muted-foreground")}>
              {id === "all" ? "All" : id === "*" ? "Shared" : agentName(id)}
            </button>
          ))}
        </div>
        <div className="inline-flex rounded-lg border border-border p-0.5">
          {sorts.map((item) => {
            const active = sort === item.key;
            const Icon = dir === "desc" ? ArrowDown : ArrowUp;
            return (
              <button key={item.key} type="button" aria-pressed={active} aria-label={active ? `${item.label}, ${dir === "desc" ? item.desc : item.asc}` : item.label} onClick={() => onSort(item.key)} className={cn("inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs", active ? "bg-accent font-medium" : "text-muted-foreground")}>
                {item.label}
                {active ? <Icon className="size-3" aria-hidden /> : null}
              </button>
            );
          })}
        </div>
      </div>
      {folders.length === 0 && commands.length === 0 ? <p className="px-4 py-4 text-sm text-muted-foreground">No grants for {agentName(agent)}.</p> : null}
      {folders.length > 0 ? (
        <SettingsSection title="Live grants">
          {folders.map((grant) => <GrantRow key={grant.id} grant={grant} mono={grant.path} Icon={FolderLock} onRevoke={onRevoke} />)}
        </SettingsSection>
      ) : null}
      {commands.length > 0 ? (
        <SettingsSection title="Commands">
          {commands.map((grant) => <GrantRow key={grant.id} grant={grant} mono={grant.command!} Icon={SquareTerminal} onRevoke={onRevoke} />)}
        </SettingsSection>
      ) : null}
    </>
  );
}

const subscribeGrants = (refresh: () => void) => window.leash.onGrantStatus(refresh);
const subscribeLog = (refresh: () => void) => {
  const offPending = window.leash.onPending(refresh);
  const offGrants = window.leash.onGrantStatus(refresh);
  return () => {
    offPending();
    offGrants();
  };
};
const NO_GRANTS = { grants: [] as Grant[], lockdown: false };
const NO_DECISIONS: DecisionRow[] = [];
const NO_SUGGESTIONS: RuleSuggestion[] = [];

export function GrantsPage() {
  const { grants, lockdown } = useLeashData(async () => {
    const [list, status] = await Promise.all([window.leash.listGrants(), window.leash.grantStatus()]);
    return { grants: list, lockdown: status.lockdown };
  }, subscribeGrants, NO_GRANTS, 15000);
  const decisions = useLeashData(() => window.leash.listDecisions(), subscribeLog, NO_DECISIONS, 10000);
  const suggestions = useLeashData(() => window.leash.listSuggestions(), subscribeGrants, NO_SUGGESTIONS, 60000);
  const pending = usePending();
  const [tab, setTab] = useState("active");
  const [agent, setAgent] = useState("all");
  const [sort, setSort] = useState<GrantSortKey>("approved");
  const [dir, setDir] = useState<SortDir>("desc");
  const [now, setNow] = useState(() => Date.now());
  const pickSort = (next: GrantSortKey) => {
    if (next === sort) setDir((value) => (value === "desc" ? "asc" : "desc"));
    else {
      setSort(next);
      setDir(next === "approved" ? "desc" : "asc");
    }
  };
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const onRevoke = (grant: Grant) => void window.leash.revokeGrant(grant.id).then(() => { toast({ title: "Grant revoked", description: grant.command ?? grant.path }); });
  return (
    <PageContainer>
      <h1 className="px-3 text-lg font-semibold tracking-tight">Access</h1>
      {pending.length ? (
        <SettingsSection title="Pending">
          {pending.map((item) => <PendingRow key={item.id} item={item} now={now} />)}
        </SettingsSection>
      ) : null}
      {suggestions.length ? (
        <SettingsSection title="Suggestions">
          {suggestions.map((item) => <SuggestionRow key={item.key} item={item} />)}
        </SettingsSection>
      ) : null}
      <Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
        <TabsList className="mx-3">
          <TabsTab value="active">Active</TabsTab>
          <TabsTab value="always">Always</TabsTab>
          <TabsTab value="automatic">Automatic</TabsTab>
          <TabsTab value="blocked">Blocked</TabsTab>
          <TabsTab value="log">Log</TabsTab>
        </TabsList>
        <TabsPanel value="active">
          {grants.length === 0 ? (
            <Empty className="rounded-xl border border-dashed border-border/70">
              <EmptyHeader>
                <EmptyMedia variant="icon"><KeyRound aria-hidden /></EmptyMedia>
                <EmptyTitle className="text-sm font-normal text-muted-foreground">No grants yet</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            <GrantList grants={grants} agent={agent} sort={sort} dir={dir} onAgent={setAgent} onSort={pickSort} onRevoke={onRevoke} />
          )}
          <div className="flex flex-wrap items-center gap-2 px-3">
            <ConfirmAction
              trigger={<Button variant="destructive" disabled={grants.length === 0}><ShieldOff />{grants.length === 0 ? "Nothing to revoke" : "Revoke all and lock down"}</Button>}
              title={`Revoke all ${grants.length} grants?`}
              description="Every agent loses the folder access it has now."
              effects={REVOKE_ALL_EFFECTS}
              confirmLabel="Revoke all"
              onConfirm={() => void window.leash.revokeAll().then((result) => { toastRevoked(result.revoked); })}
            />
            <Button
              variant={lockdown ? "destructive" : "outline"}
              disabled={!lockdown}
              aria-pressed={lockdown}
              className={lockdown ? undefined : "text-muted-foreground disabled:opacity-100"}
              onClick={() => void window.leash.unlock().then(() => { toast({ title: "Lockdown ended" }); })}
            >
              {lockdown ? <Lock /> : <LockOpen />}
              {lockdown ? "End lockdown" : "Lockdown off"}
            </Button>
          </div>
        </TabsPanel>
        <TabsPanel value="always"><AllowList /></TabsPanel>
        <TabsPanel value="automatic"><AutomaticAllows /></TabsPanel>
        <TabsPanel value="blocked"><BlockedList /></TabsPanel>
        <TabsPanel value="log">
          <SettingsSection title="Decisions, last 30 days">
            {decisions.length === 0 ? <p className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground"><ScrollText className="size-4" aria-hidden />No decisions yet</p> : null}
            {decisions.map((row) => (
              <div key={row.id} className="flex items-center gap-3 px-4 py-2.5 text-sm whitespace-nowrap">
                <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">{new Date(row.ts).toLocaleString()}</span>
                <span className="shrink-0"><Agent agent={row.agent} /></span>
                <span className="shrink-0 font-mono text-xs">{row.tool}</span>
                <VerdictPill verdict={row.verdict} />
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={decisionTarget(row)}>{decisionTarget(row)}</span>
                {row.reason ? <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground" title={row.reason}>{row.reason}</span> : null}
                {row.durationMs !== null ? <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{row.durationMs} ms</span> : null}
                {row.verdict === "deny" || row.verdict === "timeout" ? (
                  <Button size="sm" variant="ghost" className="h-6 shrink-0" title="Remove blocks that match this, so the next try opens the popup" onClick={() => void window.leash.releaseDecision(row.id).then((count) => { toast({ title: count ? "It will ask again" : "Nothing is blocking this", description: count ? "Tell the agent to retry." : "The next try already opens the popup." }); })}>Ask again</Button>
                ) : null}
              </div>
            ))}
          </SettingsSection>
        </TabsPanel>
      </Tabs>
    </PageContainer>
  );
}
