import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { BarChart3, FolderLock, ShieldAlert, Terminal } from "lucide-react";
import { AgentIcon, AGENT_LABELS } from "~/components/Icons";
import { PageContainer, SettingsSection } from "~/components/settings";
import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import { Pill } from "~/components/ui/pill";
import { toast } from "~/components/ui/toast";
import { useLeashData } from "~/hooks/useLeash";
import { cn } from "~/lib/utils";
import type { DayStat, Insights } from "../../../shared/insights";
import type { RuleSuggestion } from "../../../shared/types";

const RANGES = [7, 30] as const;
const NO_SUGGESTIONS: RuleSuggestion[] = [];

const subscribe = (refresh: () => void) => {
  const offGrants = window.leash.onGrantStatus(refresh);
  const offPending = window.leash.onPending(refresh);
  return () => {
    offGrants();
    offPending();
  };
};

const agentName = (agent: string) => (agent === "*" ? "All agents" : AGENT_LABELS[agent] ?? agent);
const tilde = (path: string) => path.replace(/^\/(Users|home)\/[^/]+/, "~");
const dayLabel = (ts: number, long = false) => new Date(ts).toLocaleDateString(undefined, long ? { weekday: "short", month: "short", day: "numeric" } : { month: "numeric", day: "numeric" });

function wait(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function since(ts: number): string {
  const hours = Math.round((Date.now() - ts) / 3_600_000);
  if (hours < 1) return "under an hour ago";
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/40 px-4 py-3 shadow-xs/5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      {note ? <div className="mt-0.5 text-xs text-muted-foreground">{note}</div> : null}
    </div>
  );
}

// One series, so one hue from the theme and no legend; the title names it.
function PromptChart({ days }: { days: DayStat[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...days.map((day) => day.prompted));
  const shown = hover === null ? null : days[hover];
  const step = days.length > 10 ? Math.ceil(days.length / 6) : 1;
  return (
    <div className="px-3 py-3 sm:px-4">
      <div className="mb-2 flex min-h-5 items-baseline justify-between gap-3 text-xs">
        <span className="text-muted-foreground">Prompts you answered per day</span>
        <span className="text-foreground/80 tabular-nums" aria-live="polite">
          {shown ? `${dayLabel(shown.day, true)} · ${shown.prompted} prompts · ${shown.auto} allowed without asking · ${shown.blocked} blocked` : days.some((day) => day.prompted) ? `Most in a day: ${max}` : ""}
        </span>
      </div>
      <div className="relative h-36" onMouseLeave={() => setHover(null)}>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 border-t border-border/60" aria-hidden />
        <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-border/40" aria-hidden />
        {days.some((day) => day.prompted) ? null : <p className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">No prompts in this range.</p>}
        <div className="absolute inset-0 flex items-end gap-[2px]" role="img" aria-label={`Prompts per day, highest ${max}`}>
          {days.map((day, index) => (
            <div key={day.day} className="flex h-full flex-1 cursor-default items-end" onMouseEnter={() => setHover(index)} onFocus={() => setHover(index)} tabIndex={0} aria-label={`${dayLabel(day.day, true)}: ${day.prompted} prompts`}>
              <div
                className={cn("w-full rounded-t bg-primary transition-opacity", hover !== null && hover !== index && "opacity-40")}
                style={{ height: day.prompted ? `${Math.max(3, (day.prompted / max) * 100)}%` : 0 }}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="mt-1 flex gap-[2px] text-[10px] text-muted-foreground tabular-nums" aria-hidden>
        {days.map((day, index) => (
          <span key={day.day} className="flex-1 text-center">{index % step === 0 || index === days.length - 1 ? dayLabel(day.day) : ""}</span>
        ))}
      </div>
      <table className="sr-only">
        <caption>Prompts per day</caption>
        <thead><tr><th>Day</th><th>Prompts</th><th>Allowed without asking</th><th>Blocked</th></tr></thead>
        <tbody>
          {days.map((day) => <tr key={day.day}><td>{dayLabel(day.day, true)}</td><td>{day.prompted}</td><td>{day.auto}</td><td>{day.blocked}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}

export function InsightsPage() {
  const [range, setRange] = useState<(typeof RANGES)[number]>(7);
  return (
    <PageContainer>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Insights</h1>
        <div className="flex gap-1" role="group" aria-label="Range">
          {RANGES.map((days) => (
            <Button key={days} size="sm" variant={range === days ? "default" : "outline"} aria-pressed={range === days} onClick={() => setRange(days)}>
              {days} days
            </Button>
          ))}
        </div>
      </div>
      {/* Keyed so a new range reloads; useLeashData loads once per mount. */}
      <InsightsBody key={range} range={range} />
    </PageContainer>
  );
}

function InsightsBody({ range }: { range: number }) {
  const data = useLeashData<Insights | null>(() => window.leash.insights(range), subscribe, null, 30_000);
  const suggestions = useLeashData(() => window.leash.listSuggestions(), subscribe, NO_SUGGESTIONS, 60_000);
  const revoke = (id: number) =>
    void window.leash.revokeGrant(id).then(
      () => toast({ title: "Revoked" }),
      (error: unknown) => toast({ title: "Could not revoke", description: error instanceof Error ? error.message : String(error), tone: "destructive" }),
    );

  return (
    <>
      {!data ? null : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile label="Prompts per day" value={String(data.promptsPerDay)} note={`${data.promptsToday} today`} />
            <Tile label="Allowed without asking" value={data.autoShare === null ? "—" : `${Math.round(data.autoShare * 100)}%`} note="covered by a grant or rule" />
            <Tile label="Median wait on a prompt" value={wait(data.medianWaitMs)} note="time an agent sat waiting" />
            <Tile label="Blocked" value={String(data.blocked)} note={`${data.secretTouches} secret ${data.secretTouches === 1 ? "request" : "requests"}`} />
          </div>

          <SettingsSection title="Prompts">
            <PromptChart days={data.days} />
            {suggestions.length ? (
              <div className="flex items-center gap-3 px-3 py-3 text-xs sm:px-4">
                <p className="flex-1 text-muted-foreground">
                  You approved {suggestions.length === 1 ? "one thing" : `${suggestions.length} things`} three or more times. Making {suggestions.length === 1 ? "it" : "them"} Always would cut these prompts.
                </p>
                <Button size="sm" variant="outline" render={<Link to="/grants" />}>See suggestions</Button>
              </div>
            ) : null}
          </SettingsSection>

          <SettingsSection title="By agent">
            {data.agents.length === 0 ? (
              <p className="px-4 py-3 text-xs text-muted-foreground">No agent tool calls in this range.</p>
            ) : (
              data.agents.map((agent) => (
                <div key={agent.agent} className="flex flex-col gap-2 px-3 py-3 text-sm sm:px-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <AgentIcon agent={agent.agent} className="size-4" />
                    <span className="font-medium">{agentName(agent.agent)}</span>
                    <span className="ml-auto flex flex-wrap gap-1.5">
                      <Pill tone="emerald">{agent.auto} allowed</Pill>
                      <Pill tone="sky">{agent.prompted} asked</Pill>
                      {agent.denied ? <Pill tone="red">{agent.denied} denied</Pill> : null}
                      {agent.timedOut ? <Pill tone="muted">{agent.timedOut} timed out</Pill> : null}
                      {agent.secret ? <Pill tone="red"><ShieldAlert className="size-3" aria-hidden />{agent.secret} secret</Pill> : null}
                    </span>
                  </div>
                  {agent.folders.length ? (
                    <ul className="flex flex-wrap gap-1.5 text-xs" aria-label={`Top folders for ${agentName(agent.agent)}`}>
                      {agent.folders.map((folder) => (
                        <li key={folder.path} className="rounded-md border border-border/60 bg-background px-1.5 py-0.5 font-mono">
                          {folder.path} <span className="text-muted-foreground tabular-nums">{folder.count}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))
            )}
          </SettingsSection>

          <SettingsSection title="Grants nobody is using">
            {data.unused.length === 0 ? (
              <p className="px-4 py-3 text-xs text-muted-foreground">Every live grant has been used recently.</p>
            ) : (
              data.unused.map((item) => (
                <div key={item.id} className="flex items-center gap-3 px-3 py-2.5 text-sm sm:px-4">
                  {item.command ? <Terminal className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : <FolderLock className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-xs font-medium">{item.command ? item.target : tilde(item.target)}</div>
                    <div className="text-xs text-muted-foreground">
                      {agentName(item.agent)} · {item.lastUsedAt ? `last used ${since(item.lastUsedAt)}` : `no use recorded since approval ${since(item.createdAt)}`} · {item.expiresAt === null ? "forever" : `expires ${new Date(item.expiresAt).toLocaleString(undefined, { timeStyle: "short", dateStyle: "short" })}`}
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => revoke(item.id)}>Revoke</Button>
                </div>
              ))
            )}
          </SettingsSection>

          <SettingsSection title="Secret and startup file activity">
            {data.alerts.length === 0 ? (
              <Empty className="py-6">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><BarChart3 aria-hidden /></EmptyMedia>
                  <EmptyTitle className="text-sm">Nothing flagged</EmptyTitle>
                  <EmptyDescription>Reads of keys and tokens, and changes to shell or login startup files, show up here.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <>
                {data.alerts.map((row) => (
                  <div key={row.id} className="flex items-center gap-3 px-3 py-2 text-xs sm:px-4">
                    <ShieldAlert className="size-3.5 shrink-0 text-red-600 dark:text-red-400" aria-hidden />
                    <span className="w-24 shrink-0 text-muted-foreground tabular-nums">{new Date(row.ts).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}</span>
                    <span className="shrink-0">{agentName(row.agent)}</span>
                    <span className="shrink-0 text-muted-foreground">{row.kind}</span>
                    <span className="min-w-0 truncate font-mono">{tilde(row.path)}</span>
                  </div>
                ))}
                <div className="px-3 py-2 sm:px-4">
                  <Button size="sm" variant="ghost" render={<Link to="/history" />}>Open History</Button>
                </div>
              </>
            )}
          </SettingsSection>
        </>
      )}
    </>
  );
}
