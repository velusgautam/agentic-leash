import type { ReactNode } from "react";
import { ArrowRightLeft, Eye, EyeOff, FilePlus2, Globe, Pencil, ShieldAlert, SquareTerminal, Trash2, type LucideIcon } from "lucide-react";
import { claudeSurface } from "../../../shared/setup";
import type { HistoryRow } from "../../../shared/types";
import { AGENT_LABELS, AgentIcon } from "~/components/Icons";
import { Button } from "~/components/ui/button";
import { Pill, type PillTone } from "~/components/ui/pill";
import { cn } from "~/lib/utils";

const KINDS: Record<string, { icon: LucideIcon; tone: PillTone }> = {
  read: { icon: Eye, tone: "sky" },
  write: { icon: Pencil, tone: "amber" },
  create: { icon: FilePlus2, tone: "emerald" },
  delete: { icon: Trash2, tone: "red" },
  rename: { icon: ArrowRightLeft, tone: "violet" },
  exec: { icon: SquareTerminal, tone: "fuchsia" },
  net: { icon: Globe, tone: "cyan" },
};

export const EVENT_KINDS = Object.keys(KINDS);

export function KindBadge({ kind }: { kind: string }) {
  const { icon: Icon, tone } = KINDS[kind] ?? { icon: Eye, tone: "muted" as PillTone };
  return (
    <Pill tone={tone}>
      <Icon className="size-3" aria-hidden />
      {kind}
    </Pill>
  );
}

export function EventList({ children }: { children: ReactNode }) {
  return (
    <div className="@container/list table-frame min-h-0 flex-1 overflow-y-auto rounded-xl border border-border/60 bg-card/40 shadow-xs/5">
      <ul className="divide-y divide-border/50">{children}</ul>
    </div>
  );
}

export function EventRow({
  row,
  showDate,
  selected,
  onSelect,
  onIgnore,
}: {
  row: HistoryRow;
  showDate?: boolean;
  selected?: boolean;
  onSelect?: () => void;
  onIgnore?: (row: HistoryRow) => void;
}) {
  const time = showDate
    ? new Date(row.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : new Date(row.ts).toLocaleTimeString();
  const body = (
    <>
      <span className="font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums">{time}</span>
      <span className="flex items-center gap-2 whitespace-nowrap" title={AGENT_LABELS[row.agent] ?? row.agent}>
        <AgentIcon agent={row.agent} />
        <span className="hidden @2xl/list:inline">{AGENT_LABELS[row.agent] ?? row.agent}</span>
        {claudeSurface(row.exe) ? <span className="hidden text-xs text-muted-foreground @2xl/list:inline">{claudeSurface(row.exe)}</span> : null}
      </span>
      <KindBadge kind={row.kind} />
      <span className="flex min-w-0 items-start justify-between gap-2 font-mono text-xs break-all">
        <span className="min-w-0 flex-1">
          {row.sensitive ? <ShieldAlert className="mr-1 inline size-3.5 shrink-0 text-destructive align-text-bottom" aria-label="Sensitive" /> : null}
          <span className={row.sensitive ? "text-destructive" : undefined}>{row.path}</span>
          {row.destPath ? <span className="text-muted-foreground"> → {row.destPath}</span> : null}
        </span>
        {onIgnore ? (
          <Button
            size="micro"
            variant="ghost"
            className="shrink-0 h-5 px-1.5 text-[11px] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              onIgnore(row);
            }}
          >
            <EyeOff className="size-3" aria-hidden />
            Ignore
          </Button>
        ) : null}
      </span>
    </>
  );
  const layout = cn(
    "grid w-full items-start gap-4 px-4 py-2.5 text-left text-sm",
    showDate ? "grid-cols-[8.5rem_1rem_5.5rem_minmax(0,1fr)] @2xl/list:grid-cols-[8.5rem_8rem_5.5rem_minmax(0,1fr)]" : "grid-cols-[5.5rem_1rem_5.5rem_minmax(0,1fr)] @2xl/list:grid-cols-[5.5rem_8rem_5.5rem_minmax(0,1fr)]",
    row.sensitive && "bg-destructive/6 shadow-[inset_3px_0_0_var(--color-destructive)]",
    selected && "bg-accent",
  );
  return (
    <li className="group">
      {onSelect ? (
        <div
          role="button"
          tabIndex={0}
          className={cn(layout, "cursor-pointer hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring")}
          onClick={onSelect}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSelect();
            }
          }}
        >
          {body}
        </div>
      ) : (
        <div className={layout}>{body}</div>
      )}
    </li>
  );
}
