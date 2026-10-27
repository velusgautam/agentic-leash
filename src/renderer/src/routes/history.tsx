import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CalendarClock, Eye, EyeOff, Inbox, Search, X } from "lucide-react";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import type { Grant, HistoryRow, HistorySummary } from "../../../shared/types";
import { DetailSplit } from "~/components/DetailSplit";
import { coveringGrant, EventDetail } from "~/components/EventDetail";
import { IgnorePathModal } from "~/components/IgnorePathModal";
import { AgentChips, control, KindSelect, SensitiveToggle } from "~/components/EventFilters";
import { EventRow } from "~/components/EventRow";
import { HISTORY_AGENT, visibleAgent } from "../../../shared/setup";
import { useSetup } from "~/components/useSetup";
import { AGENT_LABELS, AgentIcon } from "~/components/Icons";
import { Pill } from "~/components/ui/pill";
import { useLeashData } from "~/hooks/useLeash";
import { cn } from "~/lib/utils";

const PAGE = 200;
const HOUR = 3_600_000;
const RANGES = [
  { id: "any", label: "Any time" },
  { id: "1h", label: "Last hour" },
  { id: "today", label: "Today" },
  { id: "24h", label: "Last 24 hours" },
  { id: "7d", label: "Last 7 days" },
  { id: "custom", label: "Custom range" },
] as const;
type Range = (typeof RANGES)[number]["id"];

function rangeStart(range: Range): number | null {
  const now = Date.now();
  if (range === "1h") return now - HOUR;
  if (range === "24h") return now - 24 * HOUR;
  if (range === "7d") return now - 7 * 24 * HOUR;
  if (range === "today") return new Date().setHours(0, 0, 0, 0);
  return null;
}

function localValue(ms: number | null): string {
  if (ms === null) return "";
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const subscribeHistory = (refresh: () => void) => window.leash.onHistory(refresh);
const startOfToday = () => new Date().setHours(0, 0, 0, 0);
const NO_SUMMARY = null as HistorySummary | null;
const plural = (count: number, one: string, many: string) => `${count.toLocaleString()} ${count === 1 ? one : many}`;

function TodayStrip() {
  const summary = useLeashData(() => window.leash.historySummary(startOfToday()), subscribeHistory, NO_SUMMARY, 60000);
  if (!summary || (summary.total === 0 && summary.blocked === 0)) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span className="tabular-nums">Today · {plural(summary.total, "event", "events")}</span>
      <span aria-hidden>·</span>
      <span className={cn("tabular-nums", summary.sensitive > 0 && "font-medium text-red-700 dark:text-red-300")}>{summary.sensitive.toLocaleString()} sensitive</span>
      <span aria-hidden>·</span>
      <span className={cn("tabular-nums", summary.blocked > 0 && "font-medium text-amber-700 dark:text-amber-300")}>{summary.blocked.toLocaleString()} blocked</span>
      {summary.agents.map((item) => {
        const parts = [item.reads && plural(item.reads, "read", "reads"), item.writes && plural(item.writes, "write", "writes"), item.execs && plural(item.execs, "exec", "execs"), item.net && `${item.net.toLocaleString()} net`].filter(Boolean);
        if (parts.length === 0) return null;
        return <Pill key={item.agent} className="tabular-nums"><AgentIcon agent={item.agent} className="size-3" />{AGENT_LABELS[item.agent] ?? item.agent} {parts.join(" · ")}</Pill>;
      })}
    </div>
  );
}

export function HistoryPage() {
  const { status } = useSetup();
  const agentChoices = (status?.agents ?? []).filter(visibleAgent).map((item) => HISTORY_AGENT[item.id]).filter((id): id is string => Boolean(id));
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [range, setRange] = useState<Range>("any");
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const [agents, setAgents] = useState<string[]>([]);
  const [path, setPath] = useState("");
  const [kind, setKind] = useState("all");
  const [sensitive, setSensitive] = useState(false);
  const [includeNoise, setIncludeNoise] = useState(false);
  const [selected, setSelected] = useState<HistoryRow | null>(null);
  const [ignoreRow, setIgnoreRow] = useState<HistoryRow | null>(null);
  const [text, setText] = useState<{ before: string | null; after: string | null } | null>(null);
  const [grants, setGrants] = useState<Grant[]>([]);
  const parentRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const loading = useRef(false);
  const filtered = range !== "any" || agents.length > 0 || path !== "" || kind !== "all" || sensitive || includeNoise;
  const load = (offset: number, replace: boolean) => {
    if (loading.current) return;
    loading.current = true;
    void window.leash.queryHistory({ from, to, agents, path, kind, sensitive, includeNoise, offset, limit: PAGE }).then((result) => {
      setTotal(result.total);
      setRows((current) => (replace ? result.rows : [...current, ...result.rows]));
    }).finally(() => {
      loading.current = false;
    });
  };
  const loadGrants = () => void window.leash.listGrants().then(setGrants);
  useEffect(() => {
    load(0, true);
    loadGrants();
  }, [from, to, agents.join(","), path, kind, sensitive, includeNoise]);
  useEffect(() => {
    if (selected?.kind !== "write") {
      setText(null);
      return;
    }
    setText(null);
    void window.leash.historyText(selected.id).then(setText);
  }, [selected?.id, selected?.kind]);
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => 44, overscan: 8 });
  const pickRange = (next: Range) => {
    setRange(next);
    if (next !== "custom") {
      setFrom(rangeStart(next));
      setTo(null);
    }
  };
  const clear = () => {
    pickRange("any");
    setAgents([]);
    setPath("");
    setKind("all");
    setSensitive(false);
    setIncludeNoise(false);
  };

  const toolbar = (
    <div className="space-y-3">
      <TodayStrip />
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold tracking-tight">History</h1>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground tabular-nums">{total.toLocaleString()} events</span>
        <label className={cn(control, "ml-auto flex w-72 items-center gap-2 px-2.5")}>
          <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <input ref={searchRef} aria-label="Path contains" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground" placeholder="Filter by path" value={path} onChange={(event) => setPath(event.target.value)} />
          {path ? <button type="button" aria-label="Clear path" onClick={() => setPath("")}><X className="size-3.5 text-muted-foreground" /></button> : null}
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <AgentChips choices={agentChoices} value={agents} onChange={setAgents} />
        <KindSelect value={kind} onChange={setKind} />
        <label className={cn(control, "flex items-center gap-1.5 pl-2.5")}>
          <CalendarClock className="size-3.5 text-muted-foreground" aria-hidden />
          <select aria-label="Time range" className="h-full bg-transparent pr-2 outline-none" value={range} onChange={(event) => pickRange(event.target.value as Range)}>
            {RANGES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        {range === "custom" ? (
          <div className={cn(control, "flex items-center gap-1 px-2 text-xs")}>
            <input aria-label="From" className="bg-transparent outline-none" type="datetime-local" value={localValue(from)} onChange={(event) => setFrom(event.target.value ? new Date(event.target.value).getTime() : null)} />
            <span className="text-muted-foreground">to</span>
            <input aria-label="To" className="bg-transparent outline-none" type="datetime-local" value={localValue(to)} onChange={(event) => setTo(event.target.value ? new Date(event.target.value).getTime() : null)} />
          </div>
        ) : null}
        <SensitiveToggle on={sensitive} onToggle={() => setSensitive((value) => !value)} />
        <button type="button" aria-pressed={includeNoise} title="Shows scratch-path writes, execs, and /tmp reads." onClick={() => setIncludeNoise((value) => !value)} className={cn(control, "inline-flex items-center gap-1.5 px-2.5", includeNoise && "border-primary/40 bg-primary/10")}>
          {includeNoise ? <Eye className="size-3.5" aria-hidden /> : <EyeOff className="size-3.5" aria-hidden />}
          Show temp files and execs
        </button>
        {filtered ? <button type="button" className="ml-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={clear}>Clear filters</button> : null}
      </div>
    </div>
  );

  return (
    <>
      <DetailSplit
        toolbar={toolbar}
        onClose={() => setSelected(null)}
        detail={selected ? (docked) => (
          <EventDetail
            row={selected}
            text={text}
            grant={coveringGrant(selected, grants)}
            onRevoked={loadGrants}
            onIgnored={() => {
              setSelected(null);
              load(0, true);
            }}
            onClose={() => setSelected(null)}
            docked={docked}
          />
        ) : null}
        list={rows.length === 0 ? (
          <Empty className="rounded-xl border border-dashed border-border/70">
            <EmptyHeader>
              <EmptyMedia variant="icon"><Inbox aria-hidden /></EmptyMedia>
              <EmptyTitle className="text-sm font-normal text-muted-foreground">{filtered ? "No events match these filters." : "No history yet"}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <div ref={parentRef} className="@container/list table-frame min-h-0 flex-1 overflow-y-auto rounded-xl border border-border/60 bg-card/40" onScroll={(event) => {
            const node = event.currentTarget;
            if (node.scrollTop + node.clientHeight > node.scrollHeight - 240 && rows.length < total) load(rows.length, false);
          }}>
            <div role="list" style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index];
                if (!row) return null;
                return (
                  <div key={row.id} data-index={item.index} ref={virtualizer.measureElement} className="border-b border-border/50" style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` }}>
                    <EventRow row={row} showDate selected={selected?.id === row.id} onSelect={() => setSelected(row)} onIgnore={() => setIgnoreRow(row)} />
                  </div>
                );
              })}
            </div>
          </div>
        )}
      />
      <IgnorePathModal
        open={Boolean(ignoreRow)}
        onOpenChange={(open) => {
          if (!open) setIgnoreRow(null);
        }}
        initialPath={ignoreRow?.path ?? ""}
        onIgnored={() => {
          setIgnoreRow(null);
          setSelected(null);
          load(0, true);
        }}
      />
    </>
  );
}
