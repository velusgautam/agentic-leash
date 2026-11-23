import { useCallback, useEffect, useMemo, useState } from "react";
import type { AutoAllow } from "../../../shared/autoAllow";
import { decisionTarget } from "../../../shared/decisionView";
import type { AllowRule, BlockRule, DecisionRow, FindingRow, RememberedDenial, ValueExceptionRow } from "../../../shared/types";
import { ConfirmAction } from "~/components/ConfirmAction";
import { AGENT_LABELS, AgentIcon } from "~/components/Icons";
import { SettingsRow, SettingsSection } from "~/components/settings";
import { Button } from "~/components/ui/button";
import { Pill, verdictTone, type PillTone } from "~/components/ui/pill";
import { Switch } from "~/components/ui/switch";
import { toast } from "~/components/ui/toast";
import { useLeashData } from "~/hooks/useLeash";
import { cn } from "~/lib/utils";
import { v11Bridge, type AllowDeniedDecisionMode } from "~/lib/v11Bridge";
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
      <p className="px-3 text-xs leading-normal text-muted-foreground/80 sm:px-4">Read is allowed without a prompt, at home or inside a project. Scratch and log folders also allow write. Sensitive files still ask.</p>
      {rows.length === 0 ? <SettingsSection title="Automatic"><p className="px-4 py-4 text-sm text-muted-foreground">No automatic allows on this Mac yet.</p></SettingsSection> : null}
      {groups.map((group) => (
        <SettingsSection key={group.agent} title={group.title}>
          {rows.filter((row) => row.agent === group.agent).map((row) => (
            <SettingsRow
              key={row.id}
              title={
                <span className="flex items-center gap-2">
                  <span>{row.label}</span>
                  {row.write ? <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">Read & write</span> : null}
                </span>
              }
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

function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const EGRESS_COMMAND_RE =
  /(?:^|[\s;&|(/])(?:curl|wget|nc|ncat|netcat|socat|telnet|ftp|sftp|scp|rsync|ssh|http|https|xh)\b|\bgit\s+push\b|\b(?:npm|pnpm|yarn)\s+publish\b|\bgh\s+(?:api|gist|pr|release)\b|https?:\/\/|ssh:\/\/|git:\/\/|ftp:\/\/|\b[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:/i;

function isEgressDecision(row: DecisionRow): boolean {
  if (row.url) return true;
  if (row.command && EGRESS_COMMAND_RE.test(row.command)) return true;
  return false;
}

function isSecureAreaReason(reason: string | null): boolean {
  return Boolean(reason && /secure area/i.test(reason));
}

/** What Agentic Leash denies on its own: denied decision log, recent denials it remembers, and Never rules. */
export function BlockedList() {
  const blocks = useLeashData(() => window.leash.listBlocks(), subscribeBlocks, NO_BLOCKS, 15_000);
  const [deniedDecisions, setDeniedDecisions] = useState<DecisionRow[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);

  const loadDenied = useCallback(() => {
    void v11Bridge
      .listDeniedDecisions(200)
      .then(setDeniedDecisions)
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadDenied();
    const off = subscribeBlocks(loadDenied);
    const timer = window.setInterval(loadDenied, 15_000);
    return () => {
      off();
      window.clearInterval(timer);
    };
  }, [loadDenied]);

  const fail = (error: unknown) =>
    toast({
      title: "Action failed",
      description: error instanceof Error ? error.message : String(error),
      tone: "destructive",
    });
  const removed = () =>
    toast({ title: "Removed", description: "The agent's next try asks again. Tell it to retry." });

  const handleAllowDecision = async (row: DecisionRow, mode: AllowDeniedDecisionMode) => {
    setBusyId(row.id);
    try {
      const res = await v11Bridge.allowDeniedDecision(row.id, mode);
      if (res.ok) {
        const title =
          mode === "relax_secure_area"
            ? "Secure Area relaxed to Ask"
            : mode === "trust_host"
              ? "Host added to trusted egress hosts"
              : "Allowed";
        toast({
          title,
          description: res.detail ?? "Tell the agent to retry.",
        });
        loadDenied();
      } else {
        toast({
          title: "Could not update policy",
          description: res.detail ?? "The requested allow action could not be completed.",
          tone: "destructive",
        });
      }
    } catch (error) {
      fail(error);
    } finally {
      setBusyId(null);
    }
  };

  const handleAskAgain = async (row: DecisionRow) => {
    setBusyId(row.id);
    try {
      const count = await window.leash.releaseDecision(row.id);
      toast({
        title: count ? "It will ask again" : "Nothing is blocking this",
        description: count ? "Tell the agent to retry." : "The next try already opens the popup.",
      });
      loadDenied();
    } catch (error) {
      fail(error);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <p className="px-3 text-xs leading-normal text-muted-foreground/80 sm:px-4">
        Review denied or blocked calls below, grant one-click access or trust a host, or clear active blocks so the agent can ask again.
      </p>
      <SettingsSection title="Denied & Blocked Requests">
        {deniedDecisions.length === 0 ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">No denied or blocked requests recorded yet.</p>
        ) : (
          deniedDecisions.map((row) => {
            const target = decisionTarget(row);
            const showAskInstead = isSecureAreaReason(row.reason);
            const showTrustHost = isEgressDecision(row);
            const busy = busyId === row.id;
            return (
              <div key={row.id} className="flex flex-col gap-2 px-3 py-3 text-sm sm:px-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex items-center gap-1.5 text-xs font-medium">
                    <AgentIcon agent={row.agent} className="size-3.5" />
                    {blockAgent(row.agent)}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">{row.tool}</span>
                  <Pill tone={verdictTone(row.verdict)}>{row.verdict}</Pill>
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums" title={new Date(row.ts).toLocaleString()}>
                    {formatWhen(row.ts)}
                  </span>
                </div>
                <div className="truncate font-mono text-xs font-medium" title={target}>
                  {target}
                </div>
                {row.reason ? (
                  <div className="text-xs text-muted-foreground">{row.reason}</div>
                ) : null}
                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void handleAllowDecision(row, row.command ? "allow_command" : "allow_path")}
                  >
                    Allow
                  </Button>
                  {showAskInstead ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void handleAllowDecision(row, "relax_secure_area")}
                    >
                      Ask instead
                    </Button>
                  ) : null}
                  {showTrustHost ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void handleAllowDecision(row, "trust_host")}
                    >
                      Trust host
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    title="Remove blocks that match this, so the next try opens the popup"
                    onClick={() => void handleAskAgain(row)}
                  >
                    Ask again
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </SettingsSection>
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

const CATEGORY_LABEL: Record<FindingRow["category"], string> = {
  secret: "Secrets",
  pci: "PCI",
  pii: "PII",
  phi: "PHI",
};

const CATEGORY_TONE: Record<FindingRow["category"], PillTone> = {
  secret: "red",
  pci: "amber",
  pii: "sky",
  phi: "violet",
};

const ACTION_TONE: Record<string, PillTone> = {
  block: "red",
  deny: "red",
  ask: "amber",
  warn: "amber",
  monitor: "sky",
  pass: "emerald",
  allow: "emerald",
};

/** Displays content guardrail findings and exact-value exemptions. */
export function ContentFindingsSection() {
  const [findings, setFindings] = useState<FindingRow[]>([]);
  const [exceptions, setExceptions] = useState<ValueExceptionRow[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const loadAll = useCallback(() => {
    void Promise.all([v11Bridge.listFindings(100), v11Bridge.listValueExceptions()])
      .then(([nextFindings, nextExceptions]) => {
        setFindings(nextFindings);
        setExceptions(nextExceptions);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadAll();
    const off = subscribeBlocks(loadAll);
    const timer = window.setInterval(loadAll, 15_000);
    return () => {
      off();
      window.clearInterval(timer);
    };
  }, [loadAll]);

  const exemptedHashes = useMemo(
    () => new Set(exceptions.map((item) => item.valueHash)),
    [exceptions],
  );

  const handleExempt = async (finding: FindingRow) => {
    setBusyKey(`exempt:${finding.id}`);
    try {
      await v11Bridge.addValueException({
        valueHash: finding.valueHash,
        preview: finding.preview,
        label: finding.label,
      });
      toast({
        title: "Value exempted",
        description: `${finding.label} (${finding.preview}) will be ignored in future scans.`,
      });
      loadAll();
    } catch (error) {
      toast({
        title: "Could not exempt value",
        description: error instanceof Error ? error.message : String(error),
        tone: "destructive",
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleDeleteException = async (item: ValueExceptionRow) => {
    setBusyKey(`delete:${item.id}`);
    try {
      await v11Bridge.deleteValueException(item.id);
      toast({
        title: "Exception removed",
        description: `${item.label} (${item.preview}) will be checked again.`,
      });
      loadAll();
    } catch (error) {
      toast({
        title: "Could not remove exception",
        description: error instanceof Error ? error.message : String(error),
        tone: "destructive",
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleClearFindings = async () => {
    setBusyKey("clear-findings");
    try {
      await v11Bridge.clearFindings();
      toast({ title: "Findings cleared" });
      loadAll();
    } catch (error) {
      toast({
        title: "Could not clear findings",
        description: error instanceof Error ? error.message : String(error),
        tone: "destructive",
      });
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="space-y-6">
      <SettingsSection title="Content Findings & Exceptions">
        {findings.length === 0 ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">
            No content findings recorded yet. Secrets, card numbers, SSNs, and medical IDs detected by Content Guardrails appear here.
          </p>
        ) : (
          <>
            {findings.map((finding) => {
              const exempted = exemptedHashes.has(finding.valueHash);
              return (
                <div key={finding.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm sm:px-4">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-medium sm:text-sm">{finding.label}</span>
                      <Pill tone={CATEGORY_TONE[finding.category]}>{CATEGORY_LABEL[finding.category]}</Pill>
                      <Pill tone={ACTION_TONE[finding.action] ?? "muted"}>{finding.action}</Pill>
                      <Pill tone="subtle" className="font-mono">{finding.preview}</Pill>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <AgentIcon agent={finding.agent} className="size-3" />
                        {blockAgent(finding.agent)}
                      </span>
                      <span className="font-mono">{finding.tool}</span>
                      <span className="max-w-md truncate font-mono" title={finding.target}>{finding.target}</span>
                      <span className="tabular-nums">{formatWhen(finding.ts)}</span>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant={exempted ? "ghost" : "outline"}
                    disabled={exempted || busyKey === `exempt:${finding.id}`}
                    onClick={() => void handleExempt(finding)}
                  >
                    {exempted ? "Exempted" : "Exempt value"}
                  </Button>
                </div>
              );
            })}
            <div className="px-3 py-2 sm:px-4">
              <Button
                size="sm"
                variant="outline"
                disabled={busyKey === "clear-findings"}
                onClick={() => void handleClearFindings()}
              >
                Clear findings
              </Button>
            </div>
          </>
        )}
      </SettingsSection>

      <SettingsSection title="Value Exceptions">
        {exceptions.length === 0 ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">
            No value exceptions yet. Use “Exempt value” on a finding above to stop flagging that exact value.
          </p>
        ) : (
          exceptions.map((item) => (
            <div key={item.id} className="flex items-center gap-3 px-3 py-2.5 text-sm sm:px-4">
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium sm:text-sm">{item.label}</span>
                  <Pill tone="subtle" className="font-mono">{item.preview}</Pill>
                </div>
                <div className="text-xs text-muted-foreground">
                  {item.note ? `${item.note} · ` : ""}Added {new Date(item.createdAt).toLocaleDateString()}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                disabled={busyKey === `delete:${item.id}`}
                onClick={() => void handleDeleteException(item)}
              >
                Remove
              </Button>
            </div>
          ))
        )}
      </SettingsSection>
    </div>
  );
}
