import { useState } from "react";
import { EyeOff, KeyRound, ShieldQuestion, Undo2, X } from "lucide-react";
import type { Grant, HistoryRow } from "../../../shared/types";
import { ConfirmAction, grantEffects } from "~/components/ConfirmAction";
import { KindBadge } from "~/components/EventRow";
import { AGENT_LABELS, AgentIcon } from "~/components/Icons";
import { IgnorePathModal } from "~/components/IgnorePathModal";
import { Button } from "~/components/ui/button";
import { toast } from "~/components/ui/toast";
import { WriteDiff } from "~/components/WriteDiff";
import { cn } from "~/lib/utils";

const GRANT_AGENT: Record<string, string> = { claude: "claude-code", "cursor-agent": "cursor", agy: "antigravity" };

// Same match as the hook: a grant on "/" covers only "/" itself.
export function coveringGrant(row: HistoryRow, grants: Grant[]): Grant | undefined {
  const agent = GRANT_AGENT[row.agent] ?? row.agent;
  return grants
    .filter((grant) => (grant.agent === "*" || grant.agent === agent) && (grant.expiresAt === null || grant.expiresAt > Date.now()))
    .filter((grant) => row.path === grant.path || row.path.startsWith(`${grant.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

export function EventDetail({
  row,
  text,
  grant,
  onRevoked,
  onIgnored,
  onClose,
  docked,
}: {
  row: HistoryRow;
  text: { before: string | null; after: string | null } | null;
  grant: Grant | undefined;
  onRevoked: () => void;
  onIgnored?: (path: string) => void;
  onClose?: () => void;
  docked: boolean;
}) {
  const [ignoreOpen, setIgnoreOpen] = useState(false);
  const who = grant ? (grant.agent === "*" ? "All agents" : AGENT_LABELS[grant.agent] ?? grant.agent) : "";
  return (
    <section className={cn("flex flex-col overflow-hidden", docked ? "min-h-0 flex-1" : "rounded-xl border border-border/60 bg-card/40")}>
      <div className="space-y-3 border-b border-border/50 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <KindBadge kind={row.kind} />
            <AgentIcon agent={row.agent} className="size-3.5" />
            <span>{AGENT_LABELS[row.agent] ?? row.agent}</span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">{new Date(row.ts).toLocaleString()}</span>
          </div>
          {!docked && onClose ? (
            <Button
              size="icon-micro"
              variant="ghost"
              className="size-5 text-muted-foreground hover:text-foreground"
              aria-label="Close details"
              title="Close details (Esc)"
              onClick={onClose}
            >
              <X className="size-3.5" />
            </Button>
          ) : null}
        </div>
        <div className="flex items-start justify-between gap-3">
          <p className="min-w-0 flex-1 font-mono text-xs leading-relaxed break-all">{row.path}</p>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={() => setIgnoreOpen(true)}
          >
            <EyeOff className="size-3.5" aria-hidden />
            Ignore
          </Button>
        </div>
        <IgnorePathModal
          open={ignoreOpen}
          onOpenChange={setIgnoreOpen}
          initialPath={row.path}
          onIgnored={onIgnored}
        />
        <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
          {grant ? <KeyRound className="size-4 shrink-0 text-emerald-500" aria-hidden /> : <ShieldQuestion className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
          <div className="min-w-0 flex-1 text-xs">
            <div className="font-medium">{grant ? `Allowed by ${who} · ${grant.source === "leash" ? "Agentic Leash grant" : "agent config"}` : "No grant covers this"}</div>
            <div className="truncate font-mono text-muted-foreground" title={grant?.path}>{grant ? grant.path : "Monitored only"}</div>
          </div>
          {grant ? (
            <ConfirmAction
              trigger={<Button size="sm" variant="destructive-outline" className="shrink-0">Revoke</Button>}
              title="Revoke the grant behind this event?"
              description={grant.path}
              effects={grantEffects(grant)}
              confirmLabel="Revoke"
              onConfirm={() => void window.leash.revokeGrant(grant.id).then(onRevoked)}
            />
          ) : null}
        </div>
      </div>
      {row.kind === "write" ? (
        text ? (
          <>
            {typeof text.before === "string" ? (
              <div className="flex justify-end border-b border-border/50 px-4 py-2">
                <ConfirmAction
                  trigger={<Button size="sm" variant="outline"><Undo2 />Restore previous version</Button>}
                  title="Restore the previous version?"
                  description="Agentic Leash writes the captured earlier text back to this file."
                  effects={["Replaces the file's current contents.", "Only works if the file hasn't changed since this write."]}
                  confirmLabel="Restore"
                  onConfirm={() => void window.leash.restoreWrite(row.id).then((result) => {
                    if (result.ok) toast({ title: `Restored ${row.path.split("/").pop()}` });
                    else toast({ title: "Could not restore", description: result.reason, tone: "destructive" });
                  }, (error: unknown) => { toast({ title: "Could not restore", description: error instanceof Error ? error.message : String(error), tone: "destructive" }); })}
                />
              </div>
            ) : null}
            <WriteDiff className={docked ? "min-h-0 flex-1" : undefined} path={row.path} before={text.before ?? ""} after={text.after ?? ""} />
          </>
        ) : (
          <p className="px-4 py-4 text-sm text-muted-foreground">Loading the captured text.</p>
        )
      ) : null}
    </section>
  );
}
