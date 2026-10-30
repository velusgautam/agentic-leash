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
import { coveringGrant, EventDetail } from "~/components/EventDetail";
import { IgnorePathModal } from "~/components/IgnorePathModal";
import { HISTORY_AGENT, visibleAgent } from "../../../shared/setup";
import { useSetup } from "~/components/useSetup";

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
  const visible = rows.filter((row) => (agents.length === 0 || agents.includes(row.agent)) && (kind === "all" || row.kind === kind) && (!sensitiveOnly || row.sensitive));
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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
            <span className="relative flex size-2.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/60" />
              <span className="relative inline-flex size-2.5 rounded-full bg-emerald-500" />
            </span>
            Live activity
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="group h-8 gap-1.5 px-2.5 text-xs transition-all duration-200 hover:bg-accent"
              onClick={() => setFrozen(frozen ? null : live)}
            >
              {frozen ? (
                <Play className="size-3.5 text-muted-foreground group-hover:text-emerald-500 group-hover:fill-emerald-500/40 group-hover:scale-110 transition-all duration-200" aria-hidden />
              ) : (
                <Pause className="size-3.5 text-muted-foreground group-hover:text-amber-500 group-hover:scale-110 transition-all duration-200" aria-hidden />
              )}
              <span>{frozen ? (newer > 0 ? `Resume · ${newer} new` : "Resume") : "Pause"}</span>
            </Button>
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
