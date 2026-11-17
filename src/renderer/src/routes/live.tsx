import { useEffect, useRef, useState } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Activity, FileText, Folder, Lock, Pause, Play } from "lucide-react";
import { Button } from "~/components/ui/button";
import { useLeashData } from "~/hooks/useLeash";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import { describeRule } from "../../../shared/secureAreas";
import type { Grant, HistoryRow, SecureAreaRule } from "../../../shared/types";
import { EventRow } from "~/components/EventRow";
import { AgentChips, KindSelect, SensitiveToggle } from "~/components/EventFilters";
import { DetailSplit } from "~/components/DetailSplit";
import { PageHeader } from "~/components/settings";
import { coveringGrant, EventDetail } from "~/components/EventDetail";
import { IgnorePathModal } from "~/components/IgnorePathModal";
import { toast } from "~/components/ui/toast";
import { HISTORY_AGENT, visibleAgent } from "../../../shared/setup";
import { useSetup } from "~/components/useSetup";
import { cn } from "~/lib/utils";

function scopeOptions(rawPath: string): { label: string; path: string; isFolder?: boolean }[] {
  const cleaned = rawPath.replace(/\s\(\d+ files read\)$/, "").replace(/\/+$/, "");
  if (!cleaned) return [];
  const parentIdx = cleaned.lastIndexOf("/");
  const parent = parentIdx > 0 ? cleaned.slice(0, parentIdx) : "";
  const gpIdx = parent ? parent.lastIndexOf("/") : -1;
  const grandparent = gpIdx > 0 ? parent.slice(0, gpIdx) : "";
  const out: { label: string; path: string; isFolder?: boolean }[] = [{ label: "This path", path: cleaned, isFolder: /\s\(\d+ files read\)$/.test(rawPath) }];
  if (parent && parent !== cleaned) out.push({ label: "Parent folder", path: parent, isFolder: true });
  if (grandparent && grandparent !== parent) out.push({ label: "Grandparent folder", path: grandparent, isFolder: true });
  return out;
}

export function isProtectablePathRow(row: HistoryRow): boolean {
  return row.kind !== "net" && (row.path.startsWith("/") || row.path.startsWith("~"));
}

const PROTECT_RULES: { value: SecureAreaRule; label: string }[] = [
  { value: "ask", label: "Ask" },
  { value: "block", label: "Block" },
  { value: "allow", label: "Allow" },
];

export function ProtectPathModal({
  open,
  onOpenChange,
  initialPath,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialPath: string;
}) {
  const scopes = scopeOptions(initialPath);
  const [selectedPath, setSelectedPath] = useState(initialPath);
  const [readRule, setReadRule] = useState<SecureAreaRule>("ask");
  const [writeRule, setWriteRule] = useState<SecureAreaRule>("ask");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setSelectedPath(scopes[0]?.path ?? initialPath);
      setReadRule("ask");
      setWriteRule("ask");
      setError("");
      setSaving(false);
    }
  }, [open, initialPath]);

  const handleProtect = async (event: React.FormEvent) => {
    event.preventDefault();
    const cleaned = selectedPath.trim();
    if (!cleaned) {
      setError("Pick or enter a path to protect.");
      return;
    }
    setSaving(true);
    try {
      await window.leash.addSecureArea({
        pattern: cleaned,
        group: "custom",
        readRule,
        writeRule,
        enabled: true,
      });
      toast({ title: "Added to Secure Areas", description: cleaned });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <AlertDialog.Viewport className="fixed inset-0 z-50 grid place-items-center p-6">
          <AlertDialog.Popup
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                onOpenChange(false);
              }
            }}
            className="dialog-glass w-full max-w-md overflow-hidden rounded-2xl border border-border text-popover-foreground shadow-2xl transition-[opacity,scale] duration-150 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0"
          >
            <div className="flex gap-3.5 px-6 pt-6 pb-4">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
                <Lock className="size-4.5" aria-hidden />
              </span>
              <div className="min-w-0 space-y-1">
                <AlertDialog.Title className="text-base font-semibold tracking-tight">Protect in Secure Areas</AlertDialog.Title>
                <AlertDialog.Description className="text-sm leading-normal text-muted-foreground">
                  Choose whether to protect this file or a parent folder, and set rules for reading and writing.
                </AlertDialog.Description>
              </div>
            </div>

            <form className="space-y-4 px-6 pb-5" onSubmit={(e) => void handleProtect(e)}>
              {scopes.length > 0 ? (
                <div className="space-y-1.5">
                  <div className="text-xs font-medium text-foreground">Scope</div>
                  <div className="space-y-1.5">
                    {scopes.map((choice, idx) => {
                      const ScopeIcon = choice.isFolder ? Folder : FileText;
                      return (
                        <button
                          key={choice.path}
                          type="button"
                          autoFocus={idx === 0}
                          aria-pressed={selectedPath === choice.path}
                          onClick={() => setSelectedPath(choice.path)}
                          className={cn(
                            "flex w-full flex-col items-start rounded-lg border px-3 py-2 text-left text-xs transition-colors",
                            selectedPath === choice.path
                              ? "border-primary bg-primary/10 ring-1 ring-primary/30"
                              : "border-border bg-background/60 hover:bg-accent",
                          )}
                        >
                          <span className="flex items-center gap-1.5 font-medium text-foreground">
                            <ScopeIcon className="size-3.5 text-muted-foreground" aria-hidden />
                            {choice.label}
                          </span>
                          <span className="w-full truncate pl-5 font-mono text-[11px] text-muted-foreground" title={choice.path}>{choice.path}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              <div className="grid grid-cols-2 gap-3">
                <label className="block space-y-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">Read rule</span>
                  <select
                    aria-label="Protect read rule"
                    className="h-8 w-full rounded-lg border border-border bg-background px-2 text-xs text-foreground"
                    value={readRule}
                    onChange={(e) => setReadRule(e.target.value as SecureAreaRule)}
                  >
                    {PROTECT_RULES.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">Write rule</span>
                  <select
                    aria-label="Protect write rule"
                    className="h-8 w-full rounded-lg border border-border bg-background px-2 text-xs text-foreground"
                    value={writeRule}
                    onChange={(e) => setWriteRule(e.target.value as SecureAreaRule)}
                  >
                    {PROTECT_RULES.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="space-y-0.5 text-[11px] text-muted-foreground">
                <p>{describeRule(readRule, "read")}</p>
                <p>{describeRule(writeRule, "write")}</p>
              </div>
              {error ? <p className="text-xs text-destructive">{error}</p> : null}

              <div className="flex justify-end gap-2 border-t border-border/60 bg-muted/50 -mx-6 -mb-5 px-6 py-3.5 mt-4">
                <Button type="button" size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={saving}>
                  {saving ? "Saving…" : "Protect"}
                </Button>
              </div>
            </form>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

const subscribeHistory = (refresh: () => void) => window.leash.onHistory(refresh);
const loadHistory = () => window.leash.listHistory();
const isSummaryRead = (row: HistoryRow) => row.kind === "read" && /\(\d+ files read\)$/.test(row.path);

export function LivePage() {
  const live = useLeashData(loadHistory, subscribeHistory, [] as HistoryRow[], 5000);
  const [frozen, setFrozen] = useState<HistoryRow[] | null>(null);
  const rawRows = frozen ?? live;
  // Live shows tool calls, writes/deletes, network calls, sensitive/Secure Area events, and recursive summaries.
  const rows = rawRows.filter((row) => row.kind !== "read" || row.sensitive || isSummaryRead(row));
  const newer = frozen ? live.filter((row) => row.id > Math.max(0, ...frozen.map((item) => item.id))).length : 0;
  const parentRef = useRef<HTMLDivElement>(null);
  const [agents, setAgents] = useState<string[]>([]);
  const [kind, setKind] = useState("all");
  const [sensitiveOnly, setSensitiveOnly] = useState(false);
  const [selected, setSelected] = useState<HistoryRow | null>(null);
  const [ignoreRow, setIgnoreRow] = useState<HistoryRow | null>(null);
  const [protectRow, setProtectRow] = useState<HistoryRow | null>(null);
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
              <EmptyDescription>Tool calls, writes, network calls, and Secure Area hits show up here in real time.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div ref={parentRef} className="@container/list table-frame min-h-0 flex-1 overflow-y-auto rounded-xl border border-border/60 bg-card/40 shadow-xs/5">
            <div role="list" style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = visible[item.index];
                if (!row) return null;
                return (
                  <div key={row.id} data-index={item.index} ref={virtualizer.measureElement} className="group/row flex items-center border-b border-border/50 pr-2" style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` }}>
                    <div className="min-w-0 flex-1">
                      <EventRow row={row} selected={selected?.id === row.id} onSelect={() => setSelected(row)} onIgnore={() => setIgnoreRow(row)} />
                    </div>
                    {isProtectablePathRow(row) ? (
                      <Button
                        size="micro"
                        variant="ghost"
                        className="shrink-0 h-5 px-1.5 text-[11px] opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                        onClick={(event) => {
                          event.stopPropagation();
                          setProtectRow(row);
                        }}
                      >
                        <Lock className="size-3" aria-hidden />
                        Protect
                      </Button>
                    ) : null}
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
      <ProtectPathModal
        open={Boolean(protectRow)}
        onOpenChange={(open) => {
          if (!open) setProtectRow(null);
        }}
        initialPath={protectRow?.path ?? ""}
      />
    </>
  );
}
