import { useEffect, useState } from "react";
import type { AutoAllow } from "../../../shared/autoAllow";
import type { AllowRule, BlockRule, RememberedDenial } from "../../../shared/types";
import { ConfirmAction } from "~/components/ConfirmAction";
import { AGENT_LABELS } from "~/components/Icons";
import { SettingsRow, SettingsSection } from "~/components/settings";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { toast } from "~/components/ui/toast";
import { useLeashData } from "~/hooks/useLeash";
import { cn } from "~/lib/utils";
import { AGENT_NAV } from "~/nav";

export function AutomaticAllows() {
  const [rows, setRows] = useState<(AutoAllow & { enabled: boolean })[]>([]);
  useEffect(() => {
    void window.leash.listAutoAllows().then(setRows);
  }, []);
  const groups: { agent: string; title: string }[] = [];
  for (const row of rows) {
    if (!groups.some((group) => group.agent === row.agent)) groups.push({ agent: row.agent, title: row.agent === "*" ? "Every agent" : (AGENT_LABELS[row.agent] ?? row.agent) });
  }
  return (
    <div className="space-y-6">
      <p className="px-3 text-xs leading-normal text-muted-foreground/80 sm:px-4">Read is allowed without a prompt, at home or inside a project. Write still asks. Sensitive files still ask.</p>
      {rows.length === 0 ? <SettingsSection title="Automatic"><p className="px-4 py-4 text-sm text-muted-foreground">No automatic allows on this Mac yet.</p></SettingsSection> : null}
      {groups.map((group) => (
        <SettingsSection key={group.agent} title={group.title}>
          {rows.filter((row) => row.agent === group.agent).map((row) => (
            <SettingsRow
              key={row.id}
              title={row.label}
              description={row.folder}
              control={<Switch aria-label={`${group.title} ${row.label}`} checked={row.enabled} onCheckedChange={(enabled) => void window.leash.setAutoAllow(row.id, enabled).then(setRows)} />}
            />
          ))}
        </SettingsSection>
      ))}
    </div>
  );
}

const AGENTS = [{ id: "*", label: "Global" }, ...AGENT_NAV.map((agent) => ({ id: agent.id, label: agent.label }))] as const;

export function AllowList() {
  const [rules, setRules] = useState<AllowRule[]>([]);
  const [kind, setKind] = useState<AllowRule["kind"]>("folder");
  const [value, setValue] = useState("");
  const [agent, setAgent] = useState<AllowRule["agent"]>("*");
  const [editing, setEditing] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const load = () => void window.leash.listRules().then(setRules);
    load();
    return window.leash.onGrantStatus(load);
  }, []);
  const reset = () => {
    setKind("folder");
    setValue("");
    setAgent("*");
    setEditing(null);
    setError(null);
  };
  const apply = (result: { rules: AllowRule[]; error: string | null }) => {
    setRules(result.rules);
    if (result.error) setError(result.error);
    else reset();
  };
  const save = () => {
    const input = { kind, agent, value };
    if (editing === null) void window.leash.createRule(input).then(apply);
    else void window.leash.updateRule(editing, input).then(apply);
  };
  return (
    <div className="space-y-6">
      <SettingsSection title={editing === null ? "Add" : "Edit"}>
        <div className="space-y-3 px-4 py-3">
          <div role="radiogroup" aria-label="Kind" className="inline-flex rounded-lg border border-border p-0.5">
            {(["folder", "command"] as const).map((item) => (
              <button key={item} type="button" role="radio" aria-checked={kind === item} onClick={() => setKind(item)} className={cn("rounded-md px-2.5 py-1 text-xs capitalize", kind === item ? "bg-accent font-medium" : "text-muted-foreground")}>
                {item}
              </button>
            ))}
          </div>
          <label className="block space-y-1 text-xs text-muted-foreground">
            {kind === "folder" ? "Folder path" : "Command"}
            <input aria-label={kind === "folder" ? "Folder path" : "Command"} className="h-8 w-full rounded-lg border border-border bg-background/60 px-2 font-mono text-sm text-foreground" value={value} onChange={(event) => setValue(event.target.value)} />
          </label>
          <label className="block space-y-1 text-xs text-muted-foreground">
            Agent
            <select aria-label="Agent" className="h-8 w-full rounded-lg border border-border bg-background px-2 text-sm text-foreground" value={agent} onChange={(event) => setAgent(event.target.value as AllowRule["agent"])}>
              {AGENTS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <div className="flex gap-2">
            <Button size="sm" onClick={save}>{editing === null ? "Add" : "Save"}</Button>
            {editing !== null ? <Button size="sm" variant="outline" onClick={reset}>Cancel</Button> : null}
          </div>
        </div>
      </SettingsSection>
      <SettingsSection title="Forever">
        {rules.length === 0 ? <p className="px-4 py-4 text-sm text-muted-foreground">Nothing is allowed forever yet.</p> : null}
        {rules.map((rule) => (
          <div key={rule.id} className="flex items-center gap-3 px-4 py-3 text-sm">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="text-xs capitalize text-muted-foreground">{rule.kind}</div>
              <div className="overflow-x-auto pb-1 font-mono text-xs font-medium whitespace-nowrap">{rule.value}</div>
              <div className="text-xs text-muted-foreground">{AGENTS.find((item) => item.id === rule.agent)?.label ?? rule.agent}</div>
            </div>
            <Button size="sm" variant="outline" onClick={() => { setEditing(rule.id); setKind(rule.kind); setValue(rule.value); setAgent(rule.agent); setError(null); }}>Edit</Button>
            <ConfirmAction
              trigger={<Button size="sm" variant="destructive-outline">Delete</Button>}
              title="Delete this allow rule?"
              description={rule.value}
              effects={["The next matching request opens the approval popup."]}
              confirmLabel="Delete"
              onConfirm={() => void window.leash.deleteRule(rule.id).then((next) => { setRules(next); if (editing === rule.id) reset(); })}
            />
          </div>
        ))}
      </SettingsSection>
    </div>
  );
}

const NO_BLOCKS = { remembered: [] as RememberedDenial[], never: [] as BlockRule[] };
const subscribeBlocks = (refresh: () => void) => {
  const offGrants = window.leash.onGrantStatus(refresh);
  const offPending = window.leash.onPending(refresh);
  return () => {
    offGrants();
    offPending();
  };
};
const blockAgent = (agent: string) => (agent === "*" ? "Every agent" : (AGENT_LABELS[agent] ?? agent));

function minutesLeft(until: number): string {
  const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60_000));
  return `${minutes} min left`;
}

/** What Agentic Leash denies on its own: recent denials it remembers, and Never rules. */
export function BlockedList() {
  const blocks = useLeashData(() => window.leash.listBlocks(), subscribeBlocks, NO_BLOCKS, 15_000);
  const fail = (error: unknown) => toast({ title: "Could not remove", description: error instanceof Error ? error.message : String(error), tone: "destructive" });
  const removed = () => toast({ title: "Removed", description: "The agent's next try asks again. Tell it to retry." });
  return (
    <div className="space-y-6">
      <p className="px-3 text-xs leading-normal text-muted-foreground/80 sm:px-4">
        Removing a block can't undo a call that was already denied. The agent's next try opens the popup again.
      </p>
      <SettingsSection title="Recently denied">
        {blocks.remembered.length === 0 ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">Nothing denied in the last 10 minutes.</p>
        ) : (
          <>
            {blocks.remembered.map((item) => (
              <div key={item.key} className="flex items-center gap-3 px-3 py-2.5 text-sm sm:px-4">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-xs font-medium" title={item.label}>{item.label}</div>
                  <div className="text-xs text-muted-foreground">{blockAgent(item.agent)} · denied again without asking · {minutesLeft(item.until)}</div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => void window.leash.forgetDenial(item.key).then(removed, fail)}>Remove</Button>
              </div>
            ))}
            <div className="px-3 py-2 sm:px-4">
              <Button size="sm" variant="outline" onClick={() => void window.leash.forgetAllDenials().then(removed, fail)}>Clear all</Button>
            </div>
          </>
        )}
      </SettingsSection>
      <SettingsSection title="Never">
        {blocks.never.length === 0 ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">No Never rules. Pick Never in the popup to always deny something.</p>
        ) : (
          blocks.never.map((item) => (
            <div key={item.id} className="flex items-center gap-3 px-3 py-2.5 text-sm sm:px-4">
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-xs font-medium" title={item.value}>{item.value}</div>
                <div className="text-xs text-muted-foreground">
                  {blockAgent(item.agent)} · {item.kind === "command" ? "this exact command" : "this path and everything in it"} · added {new Date(item.createdAt).toLocaleDateString()}
                </div>
              </div>
              <ConfirmAction
                trigger={<Button size="sm" variant="ghost">Remove</Button>}
                title="Remove this Never rule?"
                description={`${blockAgent(item.agent)} will be asked again the next time it tries ${item.value}.`}
                effects={["The next matching request opens the approval popup.", "Calls already denied stay denied."]}
                confirmLabel="Remove"
                onConfirm={() => void window.leash.deleteNever(item.id).then(removed, fail)}
              />
            </div>
          ))
        )}
      </SettingsSection>
    </div>
  );
}
