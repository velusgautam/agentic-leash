import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Activity, Pause, Play } from "lucide-react";
import { Button } from "~/components/ui/button";
import { useLeashData } from "~/hooks/useLeash";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import type { Grant, HistoryRow } from "../../../shared/types";
import { EventRow } from "~/components/EventRow";
import { AgentChips, KindSelect, SensitiveToggle } from "~/components/EventFilters";
import { DetailSplit } from "~/components/DetailSplit";
import { PageHeader } from "~/components/settings";
import { coveringGrant, EventDetail } from "~/components/EventDetail";
import { IgnorePathModal } from "~/components/IgnorePathModal";
import { HISTORY_AGENT, visibleAgent } from "../../../shared/setup";
import { useSetup } from "~/components/useSetup";
import { cn } from "~/lib/utils";

const subscribeHistory = (refresh: () => void) => window.leash.onHistory(refresh);
const loadHistory = () => window.leash.listHistory();

export function LivePage() {
  const live = useLeashData(loadHistory, subscribeHistory, [] as HistoryRow[], 5000);
  const [frozen, setFrozen] = useState<HistoryRow[] | null>(null);
  const rows = frozen ?? live;
  const newer = frozen ? live.filter((row) => row.id > Math.max(0, ...frozen.map((item) => item.id))).length : 0;
  const parentRef = useRef<HTMLDivElement>(null);
  const [agents, setAgents] = useState<string[]>([]);
  const [kind, setKind] = useState("all");
  const [sensitiveOnly, setSensitiveOnly] = useState(false);
  const [selected, setSelected] = useState<HistoryRow | null>(null);
  const [ignoreRow, setIgnoreRow] = useState<HistoryRow | null>(null);
  const [text, setText] = useState<{ before: string | null; after: string | null } | null>(null);
  const [grants, setGrants] = useState<Grant[]>([]);
  const loadGrants = () => void window.leash.listGrants().then(setGrants);
  useEffect(loadGrants, [selected?.id]);
  useEffect(() => {
    setText(null);
    if (selected?.kind === "write") void window.leash.historyText(selected.id).then(setText);
  }, [selected?.id, selected?.kind]);
  const matchesAgent = (rowAgent: string, selectedAgents: string[]) => {
    if (selectedAgents.length === 0) return true;
    const norm = rowAgent === "claude-code" ? "claude" : rowAgent === "cursor" ? "cursor-agent" : rowAgent;
    return selectedAgents.includes(rowAgent) || selectedAgents.includes(norm);
  };
  const visible = rows.filter((row) => matchesAgent(row.agent, agents) && (kind === "all" || row.kind === kind) && (!sensitiveOnly || row.sensitive));
  useEffect(() => {
    if (selected && !visible.some((row) => row.id === selected.id)) setSelected(null);
  }, [selected?.id, visible.map((row) => row.id).join(",")]);
  const virtualizer = useVirtualizer({ count: visible.length, getScrollElement: () => parentRef.current, estimateSize: () => 44, overscan: 8 });
  const sensitive = rows.filter((row) => row.sensitive).length;
  const { status } = useSetup();
  const agentOptions = (status?.agents ?? []).filter(visibleAgent).map((item) => HISTORY_AGENT[item.id]).filter((id): id is string => Boolean(id));
  const detail = selected
    ? (docked: boolean) => (
        <EventDetail
          row={selected}
          text={text}
          grant={coveringGrant(selected, grants)}
          onRevoked={loadGrants}
          onIgnored={(path) => {
            if (selected && (selected.path === path || selected.path.startsWith(`${path}/`))) {
              setSelected(null);
            }
          }}
          onClose={() => setSelected(null)}
          docked={docked}
        />
      )
    : null;
  return (
    <>
      <DetailSplit
        detail={detail}
        onClose={() => setSelected(null)}
        toolbar={
          <div>
            <PageHeader
              title="Live activity"
              badge={
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                  <span className="relative flex size-2">
                    <span className={cn("absolute inline-flex size-full rounded-full bg-emerald-500/60", !frozen && "animate-ping")} />
                    <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
                  </span>
                  {frozen ? "Paused" : "Live"}
                </span>
              }
              actions={
                <Button
                  variant="outline"
                  size="sm"
                  className="group h-8 gap-1.5 px-3 text-xs font-medium transition-all duration-200"
                  onClick={() => setFrozen(frozen ? null : live)}
                >
                  {frozen ? (
                    <Play className="size-3.5 text-muted-foreground group-hover:text-emerald-500 group-hover:fill-emerald-500/40 group-hover:scale-110 transition-all duration-200" aria-hidden />
                  ) : (
                    <Pause className="size-3.5 text-muted-foreground group-hover:text-amber-500 group-hover:scale-110 transition-all duration-200" aria-hidden />
                  )}
                  <span>{frozen ? (newer > 0 ? `Resume · ${newer} new` : "Resume") : "Pause"}</span>
                </Button>
              }
            />
            <div className="flex flex-wrap items-center gap-2 pt-3">
              <AgentChips choices={agentOptions} value={agents} onChange={setAgents} />
              <KindSelect value={kind} onChange={setKind} />
              <SensitiveToggle on={sensitiveOnly} count={sensitive} onToggle={() => setSensitiveOnly((value) => !value)} />
            </div>
          </div>
        }
        list={visible.length === 0 ? (
          <Empty className="rounded-xl border border-dashed border-border/70">
            <EmptyHeader>
              <EmptyMedia variant="icon"><Activity aria-hidden /></EmptyMedia>
              <EmptyTitle className="text-sm">All quiet</EmptyTitle>
              <EmptyDescription>File reads, writes and commands from your agents show up here once monitoring is on.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div ref={parentRef} className="@container/list table-frame min-h-0 flex-1 overflow-y-auto rounded-xl border border-border/60 bg-card/40 shadow-xs/5">
            <div role="list" style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = visible[item.index];
                if (!row) return null;
                return (
                  <div key={row.id} data-index={item.index} ref={virtualizer.measureElement} className="border-b border-border/50" style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` }}>
                    <EventRow row={row} selected={selected?.id === row.id} onSelect={() => setSelected(row)} onIgnore={() => setIgnoreRow(row)} />
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
        onIgnored={(path) => {
          if (selected && (selected.path === path || selected.path.startsWith(`${path}/`))) {
            setSelected(null);
          }
          setIgnoreRow(null);
        }}
      />
    </>
  );
}
