import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, CircleHelp, Eye, FilePlus, FileText, Folder, FolderLock, FolderPlus, KeyRound, Lock, LockOpen, Pencil, ScrollText, Search, ShieldAlert, ShieldCheck, ShieldOff, SquareTerminal, Timer, Trash2, TriangleAlert, Users, X, type LucideIcon } from "lucide-react";
import { decisionTarget } from "../../../shared/decisionView";
import { viewGrants, type GrantSortKey, type SortDir } from "../../../shared/grantView";
import { denyCountdown, pendingSecondsLeft, POPUP_TIMEOUT_S } from "../../../shared/pending";
import { describeRule, SECURE_AREA_GROUP_INFO } from "../../../shared/secureAreas";
import type { DecisionRow, Grant, GuardSettings, PendingRequest, PresetId, SecureArea, SecureAreaGroup, SecureAreaRule, SessionAllow } from "../../../shared/types";
import { AllowButtons, ApprovalChoices, allowLabel, defaultScope } from "~/components/ApprovalChoices";
import { ConfirmAction, grantEffects, REVOKE_ALL_EFFECTS } from "~/components/ConfirmAction";
import { AGENT_LABELS, AgentIcon } from "~/components/Icons";
import { PageContainer, PageHeader, SettingsRow, SettingsSection } from "~/components/settings";
import { Button } from "~/components/ui/button";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import { accessTone, Pill, verdictTone, type PillTone } from "~/components/ui/pill";
import { Switch } from "~/components/ui/switch";
import { Tabs, TabsList, TabsPanel, TabsTab } from "~/components/ui/tabs";
import { toast, toastRevoked } from "~/components/ui/toast";
import { useLeashData, usePending } from "~/hooks/useLeash";
import { cn } from "~/lib/utils";
import { BlockedList } from "./access-parts";

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

const RULE_OPTIONS: { value: SecureAreaRule; label: string }[] = [
  { value: "allow", label: "Allow" },
  { value: "ask", label: "Ask" },
  { value: "block", label: "Block" },
];

export function GuardToggles({ onChanged }: { onChanged?: () => void }) {
  const [guards, setGuards] = useState<GuardSettings | null>(null);
  useEffect(() => {
    void window.leash.getGuardSettings().then(setGuards);
  }, []);
  const toggle = (key: keyof GuardSettings, value: boolean) => {
    void window.leash.setGuardSettings({ [key]: value }).then((next) => {
      setGuards(next);
      onChanged?.();
    });
  };
  return (
    <SettingsSection title="Automatic guards (always active outside Secure Areas)">
      <SettingsRow
        title="Destructive commands"
        description={
          <span className="space-y-1.5 block">
            <span>Ask before running rm -rf, sudo, git push --force, git reset --hard, or git clean -f.</span>
            {guards && !guards.destructiveCommands ? (
              <span className="flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-300">
                <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
                Warning: Destructive command guard is off. Agents can run destructive shell and git commands without asking.
              </span>
            ) : null}
          </span>
        }
        control={
          <Switch
            aria-label="Destructive commands guard"
            checked={guards?.destructiveCommands ?? true}
            disabled={!guards}
            onCheckedChange={(checked) => toggle("destructiveCommands", checked)}
          />
        }
      />
      <SettingsRow
        title="Network after a secret"
        description={
          <span className="space-y-1.5 block">
            <span>Ask before any network call shortly after an agent reads a Secure Area or a file containing an API key or private key.</span>
            {guards && !guards.egressAfterSecret ? (
              <span className="flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-300">
                <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
                Warning: Network-after-secret guard is off. Agents can make network calls after reading secrets without asking.
              </span>
            ) : null}
          </span>
        }
        control={
          <Switch
            aria-label="Network after a secret guard"
            checked={guards?.egressAfterSecret ?? true}
            disabled={!guards}
            onCheckedChange={(checked) => toggle("egressAfterSecret", checked)}
          />
        }
      />
    </SettingsSection>
  );
}

const RULE_LABEL: Record<SecureAreaRule, string> = {
  allow: "Allow",
  ask: "Ask",
  block: "Block",
};

const RULE_TONE: Record<SecureAreaRule | "mixed", PillTone> = {
  allow: "emerald",
  ask: "amber",
  block: "red",
  mixed: "muted",
};

function predominantRule(items: SecureArea[], field: "readRule" | "writeRule"): SecureAreaRule | "mixed" {
  const pool = items.filter((item) => item.enabled);
  const source = pool.length > 0 ? pool : items;
  const first = source[0]?.[field];
  if (!first) return "ask";
  return source.every((item) => item[field] === first) ? first : "mixed";
}

function pathBasename(rawPath: string): string {
  const cleaned = rawPath.trim().replace(/\/+$/, "");
  if (!cleaned) return "";
  if (cleaned === "~") return "Home";
  return cleaned.split("/").filter(Boolean).pop() ?? cleaned;
}

export function SecureAreasManager({ compact = false }: { compact?: boolean }) {
  const [areas, setAreas] = useState<SecureArea[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [pickedKind, setPickedKind] = useState<"folder" | "file" | null>(null);
  const [pattern, setPattern] = useState("");
  const [label, setLabel] = useState("");
  const [readRule, setReadRule] = useState<SecureAreaRule>("ask");
  const [writeRule, setWriteRule] = useState<SecureAreaRule>("allow");
  const [error, setError] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<Partial<Record<SecureAreaGroup, boolean>>>({});
  const [filterQuery, setFilterQuery] = useState("");
  const patternInputRef = useRef<HTMLInputElement>(null);
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const autoLabelRef = useRef<string | null>(null);

  useEffect(() => {
    void window.leash.listSecureAreas().then(setAreas);
  }, []);

  const resetForm = () => {
    setShowAdd(false);
    setPickedKind(null);
    setPattern("");
    setLabel("");
    autoLabelRef.current = null;
    setReadRule("ask");
    setWriteRule("allow");
    setError(null);
  };

  const handlePick = async (kind: "folder" | "file") => {
    setError(null);
    const picked = await window.leash.pickSecureAreaPath?.(kind);
    if (picked) {
      setPattern(picked);
      const base = pathBasename(picked);
      setLabel((prev) => {
        if (!prev.trim() || prev === autoLabelRef.current) {
          autoLabelRef.current = base;
          return base;
        }
        return prev;
      });
      setPickedKind(kind);
      setShowAdd(true);
      window.setTimeout(() => submitButtonRef.current?.focus(), 0);
    } else if (!showAdd) {
      setPickedKind(kind);
      setShowAdd(true);
      window.setTimeout(() => patternInputRef.current?.focus(), 0);
    }
  };

  const handleAdd = (event: React.FormEvent) => {
    event.preventDefault();
    const cleaned = pattern.trim();
    if (!cleaned) {
      setError("Choose a folder or file, or enter a path or pattern (e.g. ~/Secrets or *.key).");
      return;
    }
    setError(null);
    void window.leash
      .addSecureArea({
        pattern: cleaned,
        label: label.trim() || undefined,
        group: "custom",
        readRule,
        writeRule,
        enabled: true,
      })
      .then((next) => {
        setAreas(next);
        resetForm();
        setOpenGroups((prev) => ({ ...prev, custom: true }));
        toast({ title: "Secure Area added", description: cleaned });
      });
  };

  const groups = (Object.keys(SECURE_AREA_GROUP_INFO) as SecureAreaGroup[]).sort(
    (a, b) => SECURE_AREA_GROUP_INFO[a].order - SECURE_AREA_GROUP_INFO[b].order,
  );
  const query = filterQuery.trim().toLowerCase();
  const visibleGroups = groups
    .map((groupKey) => {
      let items = areas.filter((a) => a.group === groupKey);
      if (groupKey === "custom") {
        items = [...items].sort((a, b) => (b.createdAt - a.createdAt) || (b.id - a.id));
      }
      if (query) {
        items = items.filter(
          (a) =>
            a.label.toLowerCase().includes(query) ||
            a.pattern.toLowerCase().includes(query) ||
            SECURE_AREA_GROUP_INFO[groupKey].title.toLowerCase().includes(query),
        );
      }
      return { groupKey, items };
    })
    .filter(({ items }) => items.length > 0);

  const allExpanded = visibleGroups.length > 0 && visibleGroups.every(({ groupKey }) => Boolean(openGroups[groupKey]));
  const toggleAllGroups = () => {
    if (allExpanded) {
      setOpenGroups({});
    } else {
      const next: Partial<Record<SecureAreaGroup, boolean>> = {};
      for (const { groupKey } of visibleGroups) next[groupKey] = true;
      setOpenGroups(next);
    }
  };

  return (
    <div className="space-y-4">
      <SettingsSection title="Secure Areas">
        <SettingsRow
          title="Protected folders and files"
          description="Requests outside Secure Areas are auto-accepted. Choose what happens when an agent reads or writes inside each area."
          control={
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => void handlePick("folder")}>
                <FolderPlus className="size-3.5" aria-hidden />
                Add folder
              </Button>
              <Button size="sm" variant="outline" onClick={() => void handlePick("file")}>
                <FilePlus className="size-3.5" aria-hidden />
                Add file
              </Button>
              {visibleGroups.length > 0 && !query ? (
                <Button size="sm" variant="ghost" onClick={toggleAllGroups}>
                  {allExpanded ? "Collapse all" : "Expand all"}
                </Button>
              ) : null}
            </div>
          }
        />
        <div className="flex items-center gap-2 px-3 py-2 sm:px-4">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input
              aria-label="Filter Secure Areas"
              placeholder="Filter Secure Areas by name or path…"
              className="h-8 w-full rounded-lg border border-border bg-background/60 pr-7 pl-8 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
            />
            {filterQuery ? (
              <button
                type="button"
                aria-label="Clear filter"
                onClick={() => setFilterQuery("")}
                className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
        </div>
      </SettingsSection>

      {showAdd ? (
        <SettingsSection title="Add Secure Area">
          <form
            className="space-y-3 px-4 py-3"
            onSubmit={handleAdd}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                resetForm();
              }
            }}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              {pattern.trim() || pickedKind ? (
                <Pill tone="subtle" className="max-w-full font-mono">
                  {pickedKind === "file" ? <FileText className="size-3 shrink-0" aria-hidden /> : <Folder className="size-3 shrink-0" aria-hidden />}
                  <span className="truncate">{pattern.trim() || (pickedKind === "file" ? "File" : "Folder")}</span>
                </Pill>
              ) : (
                <span className="text-xs text-muted-foreground">Choose a folder or file, or enter a path or pattern below.</span>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => void handlePick("folder")}>
                  <FolderPlus className="size-3.5" aria-hidden />
                  Browse folder…
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => void handlePick("file")}>
                  <FilePlus className="size-3.5" aria-hidden />
                  Browse file…
                </Button>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1 text-xs text-muted-foreground">
                Folder, file, or pattern
                <input
                  ref={patternInputRef}
                  aria-label="Secure Area path or pattern"
                  placeholder="~/Work/secrets or *.pem"
                  className="h-8 w-full rounded-lg border border-border bg-background/60 px-2.5 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={pattern}
                  onChange={(e) => setPattern(e.target.value)}
                />
              </label>
              <label className="block space-y-1 text-xs text-muted-foreground">
                Label (optional)
                <input
                  aria-label="Secure Area label"
                  placeholder="Work API keys"
                  className="h-8 w-full rounded-lg border border-border bg-background/60 px-2.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={label}
                  onChange={(e) => {
                    autoLabelRef.current = null;
                    setLabel(e.target.value);
                  }}
                />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <label className="flex items-center gap-2 text-muted-foreground">
                Read
                <select
                  aria-label="New Secure Area read rule"
                  className="h-8 rounded-lg border border-border bg-background px-2 text-xs text-foreground"
                  value={readRule}
                  onChange={(e) => setReadRule(e.target.value as SecureAreaRule)}
                >
                  {RULE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 text-muted-foreground">
                Write
                <select
                  aria-label="New Secure Area write rule"
                  className="h-8 rounded-lg border border-border bg-background px-2 text-xs text-foreground"
                  value={writeRule}
                  onChange={(e) => setWriteRule(e.target.value as SecureAreaRule)}
                >
                  {RULE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </label>
              <span className="text-muted-foreground">{describeRule(readRule, "read")}</span>
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            <div className="flex gap-2">
              <Button ref={submitButtonRef} size="sm" type="submit">Add Secure Area</Button>
              <Button size="sm" type="button" variant="ghost" onClick={resetForm}>Cancel</Button>
            </div>
          </form>
        </SettingsSection>
      ) : null}

      {query && visibleGroups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/70 px-4 py-6 text-center text-xs text-muted-foreground">
          No Secure Areas match “{filterQuery}”.
        </div>
      ) : null}

      <div className="space-y-2.5">
        {visibleGroups.map(({ groupKey, items }) => {
          const info = SECURE_AREA_GROUP_INFO[groupKey];
          const isOpen = query ? true : Boolean(openGroups[groupKey]);
          const enabledCount = items.filter((a) => a.enabled).length;
          const readSummary = predominantRule(items, "readRule");
          const writeSummary = predominantRule(items, "writeRule");
          const Chevron = isOpen ? ChevronDown : ChevronRight;
          return (
            <div
              key={groupKey}
              className="overflow-hidden rounded-xl border border-border/60 bg-card/40 text-foreground shadow-xs/5"
            >
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() =>
                  setOpenGroups((prev) => ({
                    ...prev,
                    [groupKey]: !prev[groupKey],
                  }))
                }
                className={cn(
                  "flex w-full items-center justify-between gap-3 px-4 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  compact ? "py-2.5" : "py-3",
                )}
              >
                <div className="flex min-w-0 flex-1 items-start gap-2.5">
                  <Chevron className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">{info.title}</span>
                      {groupKey === "custom" ? <Pill tone="subtle">User-added</Pill> : null}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{info.description}</p>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                  <Pill tone={enabledCount > 0 ? "subtle" : "muted"} className="tabular-nums">
                    {enabledCount}/{items.length} active
                  </Pill>
                  <Pill tone={RULE_TONE[readSummary]}>
                    Read: {readSummary === "mixed" ? "Mixed" : RULE_LABEL[readSummary]}
                  </Pill>
                  <Pill tone={RULE_TONE[writeSummary]}>
                    Write: {writeSummary === "mixed" ? "Mixed" : RULE_LABEL[writeSummary]}
                  </Pill>
                </div>
              </button>
              {isOpen ? (
                <div className="divide-y divide-border/50 border-t border-border/50">
                  {items.map((area) => (
                    <div key={area.id} className={cn("flex flex-wrap items-center gap-3 px-4 text-sm", compact ? "py-2" : "py-2.5")}>
                      <div className="min-w-0 flex-1 space-y-0.5 pl-6">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium sm:text-sm">{area.label}</span>
                          {!area.builtin ? <Pill tone="subtle">Custom</Pill> : null}
                        </div>
                        <div className="truncate font-mono text-xs text-muted-foreground" title={area.pattern}>{area.pattern}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <label className="flex items-center gap-1 text-xs text-muted-foreground">
                          <span>Read</span>
                          <select
                            aria-label={`${area.label} read rule`}
                            className="h-7 rounded-md border border-border bg-background px-1.5 text-xs text-foreground"
                            value={area.readRule}
                            title={describeRule(area.readRule, "read")}
                            onChange={(e) =>
                              void window.leash
                                .updateSecureArea(area.id, { readRule: e.target.value as SecureAreaRule })
                                .then(setAreas)
                            }
                          >
                            {RULE_OPTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                          </select>
                        </label>
                        <label className="flex items-center gap-1 text-xs text-muted-foreground">
                          <span>Write</span>
                          <select
                            aria-label={`${area.label} write rule`}
                            className="h-7 rounded-md border border-border bg-background px-1.5 text-xs text-foreground"
                            value={area.writeRule}
                            title={describeRule(area.writeRule, "write")}
                            onChange={(e) =>
                              void window.leash
                                .updateSecureArea(area.id, { writeRule: e.target.value as SecureAreaRule })
                                .then(setAreas)
                            }
                          >
                            {RULE_OPTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                          </select>
                        </label>
                        <Switch
                          aria-label={`Enable ${area.label}`}
                          checked={area.enabled}
                          onCheckedChange={(enabled) =>
                            void window.leash.updateSecureArea(area.id, { enabled }).then(setAreas)
                          }
                        />
                        {!area.builtin ? (
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Delete ${area.label}`}
                            onClick={() =>
                              void window.leash.deleteSecureArea(area.id).then((next) => {
                                setAreas(next);
                                toast({ title: "Secure Area removed", description: area.pattern });
                              })
                            }
                          >
                            <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PendingRow({ item, now }: { item: PendingRequest; now: number }) {
  const request = item.request;
  const [scope, setScope] = useState<string | null>(() => defaultScope(request, item.policy, item.matchedSecureArea));
  useEffect(() => {
    setScope(defaultScope(request, item.policy, item.matchedSecureArea));
  }, [item.id]);
  const allow = (choice: PresetId) =>
    void window.leash.decidePending(item.id, "allow", null, scope ?? undefined, choice).then(() => {
      toast({ title: "Allowed", description: allowLabel(scope, choice, item.policy?.repo ?? null) });
    });
  const deny = () =>
    void window.leash.decidePending(item.id, "deny", null).then(() => {
      toast({
        title: "Denied",
        action: {
          label: "Undo",
          onClick: () =>
            void window.leash.undoDeny(item.id).then(() => {
              toast({ title: "Undone", description: "The agent's next try asks again." });
            }),
        },
      });
    });
  return (
    <div className="flex flex-col gap-3 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Agent agent={request.agent} />
        <AccessPill access={request.access} />
        <span className="font-mono text-xs">{request.tool}</span>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">{denyCountdown(pendingSecondsLeft(item.askedAt, now, POPUP_TIMEOUT_S))}</span>
      </div>
      <ApprovalChoices
        request={request}
        policy={item.policy}
        matchedSecureArea={item.matchedSecureArea}
        scope={scope}
        onScope={setScope}
      />
      <AllowButtons
        request={request}
        policy={item.policy}
        matchedSecureArea={item.matchedSecureArea}
        scope={scope}
        onAllow={allow}
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={deny}>Deny</Button>
        </span>
      </div>
    </div>
  );
}

function GrantRow({ grant, mono, Icon, onRevoke }: { grant: Grant; mono: string; Icon: typeof FolderLock; onRevoke: (grant: Grant) => void }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 text-sm">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="overflow-x-auto pb-1 font-mono text-xs font-medium whitespace-nowrap">{mono}</div>
        <div className="flex flex-wrap items-center gap-2">
          <Agent agent={grant.agent} />
          <AccessPill access={grant.access} />
          <span className="text-xs text-muted-foreground tabular-nums" title={when(grant.createdAt)}>Approved {when(grant.createdAt)}</span>
          <Pill tone="subtle" title={grant.expiresAt === null ? "Forever" : when(grant.expiresAt)}><Timer className="size-3" aria-hidden />{remaining(grant.expiresAt)}</Pill>
          {grant.idleSeconds ? <Pill tone="subtle" title="Stays alive while the agent keeps using it.">This session</Pill> : null}
          <span className="text-xs text-muted-foreground">{SOURCE_LABELS[grant.source] ?? grant.source}</span>
        </div>
      </div>
      <ConfirmAction
        trigger={
          <Button
            size="sm"
            variant="destructive-outline"
            className="group h-8 gap-1.5 px-2.5 text-xs hover:border-rose-500/50 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-500/10 transition-all duration-200"
          >
            <ShieldOff className="size-3.5 text-muted-foreground group-hover:text-rose-500 group-hover:scale-110 transition-all duration-200" aria-hidden />
            <span>Revoke</span>
          </Button>
        }
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
      <div className="flex flex-wrap items-center gap-2">
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
const NO_GRANTS = { grants: [] as Grant[], lockdown: false, sessionAllows: [] as SessionAllow[] };
const NO_DECISIONS: DecisionRow[] = [];

export function GrantsPage() {
  const { grants, lockdown, sessionAllows } = useLeashData(async () => {
    const [list, status, allows] = await Promise.all([
      window.leash.listGrants(),
      window.leash.grantStatus(),
      window.leash.listSessionAllows(),
    ]);
    return { grants: list, lockdown: status.lockdown, sessionAllows: allows };
  }, subscribeGrants, NO_GRANTS, 15000);
  const decisions = useLeashData(() => window.leash.listDecisions(), subscribeLog, NO_DECISIONS, 10000);
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
  const onRevokeSessionAllow = (allow: SessionAllow) =>
    void window.leash.revokeSessionAllow(allow.id).then(() => {
      toast({ title: "Session allow revoked", description: allow.path });
    });

  return (
    <PageContainer>
      <PageHeader
        title="Access"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
              <ShieldCheck className="size-3.5" aria-hidden />
              Auto-Accept active outside Secure Areas
            </span>
            {tab !== "secure-areas" ? (
              <Button size="sm" variant="outline" onClick={() => setTab("secure-areas")}>
                <Lock className="size-3.5" aria-hidden />
                Configure Secure Areas
              </Button>
            ) : null}
          </div>
        }
      />
      {pending.length ? (
        <SettingsSection title="Pending">
          {pending.map((item) => <PendingRow key={item.id} item={item} now={now} />)}
        </SettingsSection>
      ) : null}
      <Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
        <TabsList>
          <TabsTab value="active">Active</TabsTab>
          <TabsTab value="secure-areas">Secure Areas</TabsTab>
          <TabsTab value="blocked">Blocked</TabsTab>
          <TabsTab value="log">Log</TabsTab>
        </TabsList>
        <TabsPanel value="active" className="space-y-4">
          <SettingsSection title="Active session allows">
            {sessionAllows.length === 0 ? (
              <p className="px-4 py-3 text-xs text-muted-foreground">
                No temporary Secure Area allows active. When you choose “Allow this session” or “Allow today” on a Secure Area prompt, it appears here.
              </p>
            ) : (
              sessionAllows.map((allow) => (
                <div key={allow.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                  <ShieldAlert className="size-4 shrink-0 text-amber-500" aria-hidden />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="overflow-x-auto pb-0.5 font-mono text-xs font-medium whitespace-nowrap">{allow.path}</div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Agent agent={allow.agent} />
                      <AccessPill access={allow.access} />
                      <Pill tone="subtle">
                        <Timer className="size-3" aria-hidden />
                        {allow.sessionId ? "This session" : remaining(allow.expiresAt)}
                      </Pill>
                    </div>
                  </div>
                  <Button size="sm" variant="destructive-outline" onClick={() => onRevokeSessionAllow(allow)}>
                    Revoke
                  </Button>
                </div>
              ))
            )}
          </SettingsSection>

          <GuardToggles />

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

          <div className="flex flex-wrap items-center gap-2">
            <ConfirmAction
              trigger={
                <Button
                  variant="destructive"
                  size="sm"
                  className="group h-8 gap-1.5 px-2.5 text-xs transition-all duration-200"
                  disabled={grants.length === 0}
                >
                  <ShieldOff className="size-3.5" />
                  <span>{grants.length === 0 ? "Nothing to revoke" : "Revoke all and lock down"}</span>
                </Button>
              }
              title={`Revoke all ${grants.length} grants?`}
              description="Every agent loses the folder access it has now."
              effects={REVOKE_ALL_EFFECTS}
              confirmLabel="Revoke all"
              onConfirm={() => void window.leash.revokeAll().then((result) => { toastRevoked(result.revoked); })}
            />
            <Button
              variant={lockdown ? "destructive" : "outline"}
              size="sm"
              disabled={!lockdown}
              aria-pressed={lockdown}
              className={cn(
                "group h-8 gap-1.5 px-2.5 text-xs transition-all duration-200",
                lockdown ? "" : "text-muted-foreground disabled:opacity-100",
              )}
              onClick={() => void window.leash.unlock().then(() => { toast({ title: "Lockdown ended" }); })}
            >
              {lockdown ? (
                <Lock className="size-3.5 text-destructive fill-destructive/40 animate-pulse group-hover:scale-110 transition-transform duration-200" />
              ) : (
                <LockOpen className="size-3.5 text-muted-foreground group-hover:text-rose-500 group-hover:scale-110 transition-all duration-200" />
              )}
              <span>{lockdown ? "End lockdown" : "Lockdown off"}</span>
            </Button>
          </div>
        </TabsPanel>
        <TabsPanel value="secure-areas" className="space-y-5">
          <SecureAreasManager />
          <GuardToggles />
        </TabsPanel>
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
