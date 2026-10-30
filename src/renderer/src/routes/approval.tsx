import { useEffect, useState } from "react";
import { CheckCircle2, Undo2, X, Zap } from "lucide-react";
import { denyCountdown, pendingSecondsLeft, POPUP_TIMEOUT_S } from "../../../shared/pending";
import { AllowButtons, ApprovalChoices, defaultPreset, Kbd, presetsFor } from "~/components/ApprovalChoices";
import type { PendingRequest, PresetId } from "../../../shared/types";
import { AGENT_LABELS, AgentIcon } from "~/components/Icons";
import { Button } from "~/components/ui/button";
import { usePending } from "~/hooks/useLeash";

const ARM_MS = 600;
// Matches how long the main process keeps the popup open after a Deny.
const UNDO_MS = 6000;

function CloseButton() {
  return (
    <Button size="icon-sm" variant="ghost" aria-label="Close" className="size-7" onClick={() => void window.leash.closeApproval()}>
      <X />
    </Button>
  );
}

const targetOf = (item: PendingRequest) => item.request.command?.trim() || item.request.url || item.request.paths.join(", ");

function UndoBar({ undo, onUndo }: { undo: { id: string; never: boolean; label: string }; onUndo: () => void }) {
  return (
    <div role="status" className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/60 px-3 py-1.5 text-xs">
      <p className="min-w-0 flex-1 truncate">
        {undo.never ? "Never allowed" : "Denied"} <span className="font-mono">{undo.label}</span>
      </p>
      <Button size="sm" variant="ghost" className="h-6" onClick={onUndo}>
        <Undo2 aria-hidden />
        Undo
      </Button>
    </div>
  );
}

export function ApprovalPage() {
  const pending = usePending();
  const [now, setNow] = useState(() => Date.now());
  const [scope, setScope] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ id: string; never: boolean; label: string; at: number } | null>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const current = pending[0];
  useEffect(() => {
    setScope(current?.policy?.scope ?? null);
  }, [current?.id, current?.policy?.scope]);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    let timer = 0;
    const arm = () => {
      window.clearTimeout(timer);
      setArmed(false);
      timer = window.setTimeout(() => setArmed(true), ARM_MS);
    };
    arm();
    window.addEventListener("focus", arm);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", arm);
    };
  }, [current?.id]);
  const showUndo = undo && now - undo.at < UNDO_MS ? undo : null;
  const presets = presetsFor(current?.policy);
  const allow = (preset: PresetId) => current && armed && void window.leash.decidePending(current.id, "allow", null, scope ?? undefined, preset);
  const deny = (never = false) => {
    if (!current) return;
    setUndo({ id: current.id, never, label: targetOf(current), at: Date.now() });
    void window.leash.decidePending(current.id, never ? "never" : "deny", null, scope ?? undefined);
  };
  const undoDeny = () => {
    if (!undo) return;
    void window.leash.undoDeny(undo.id);
    setUndo(null);
  };
  // Each request is clamped to its own limits in the main process, so a secret in the batch stays Once.
  const allowAll = () => {
    for (const id of pending.map((item) => item.id)) void window.leash.decidePending(id, "allow", null, undefined, "session");
  };
  const denyAll = () => {
    for (const id of pending.map((item) => item.id)) void window.leash.decidePending(id, "deny", null);
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!current) return;
      // High-risk requests need a click, so Enter muscle memory can't approve them.
      if (event.key === "Enter" && current.policy?.risk !== "high") allow(defaultPreset(current.policy));
      if (event.key === "Escape") deny();
      const preset = presets[Number(event.key) - 1];
      if (/^[1-9]$/.test(event.key) && preset) allow(preset);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!current) {
    return (
      <div className="drag-region flex h-dvh flex-col justify-center gap-2 bg-popover px-4 text-sm text-popover-foreground">
        <div className="flex items-center gap-3">
          <CheckCircle2 className="size-4 text-emerald-500" aria-hidden />
          <p className="flex-1">No requests waiting.</p>
          <CloseButton />
        </div>
        {showUndo ? <UndoBar undo={showUndo} onUndo={undoDeny} /> : null}
      </div>
    );
  }

  const { request } = current;
  return (
    <div className="flex h-dvh flex-col bg-popover text-popover-foreground">
      <header className="drag-region flex shrink-0 items-center gap-3 border-b border-border/60 px-4 py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-card">
          <AgentIcon agent={request.agent} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold tracking-tight">
            {AGENT_LABELS[request.agent] ?? request.agent} wants {current.policy ? `to ${current.policy.summary}` : `${request.access} access`}
          </h1>
          <p className="truncate text-xs text-muted-foreground">{request.tool} tool · {request.cwd}</p>
        </div>
        {pending.length > 1 ? <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground tabular-nums">1 of {pending.length}</span> : null}
        <CloseButton />
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3 [&>*]:shrink-0">
        {showUndo ? <UndoBar undo={showUndo} onUndo={undoDeny} /> : null}
        <ApprovalChoices request={request} policy={current.policy} scope={scope} onScope={setScope} />
        <AllowButtons policy={current.policy} scope={scope} disabled={!armed} showKeys onAllow={allow} />
      </div>
      {pending.length > 1 ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-border/60 px-4 py-1.5">
          <p className="mr-auto text-xs text-muted-foreground tabular-nums">{pending.length} waiting:</p>
          <Button size="sm" variant="ghost" className="h-7" onClick={denyAll}>Deny all ({pending.length})</Button>
          <Button size="sm" variant="outline" className="h-7" disabled={!armed} title="Secrets and personal folders in the batch are still allowed once only." onClick={allowAll}>
            Allow all ({pending.length}) this session
          </Button>
        </div>
      ) : null}
      <footer className="flex shrink-0 items-center gap-2 border-t border-border/60 bg-muted/50 px-4 py-2.5">
        <p className="mr-auto text-xs text-muted-foreground tabular-nums">{denyCountdown(pendingSecondsLeft(current.askedAt, now, POPUP_TIMEOUT_S))}</p>
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs font-medium border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-amber-600 dark:text-amber-400 gap-1.5"
          title="Auto-approve all tool calls for 1 hour without any prompts"
          onClick={() => {
            void window.leash.setGodMode(3600);
            void window.leash.closeApproval();
          }}
        >
          <Zap className="size-3.5 fill-current" aria-hidden />
          Accept all (1h)
        </Button>
        <Button size="sm" variant="ghost" className="h-8 text-sm text-muted-foreground" title="Always deny this for this agent. Remove it on Access → Blocked." onClick={() => deny(true)}>
          Never
        </Button>
        <Button size="sm" variant="outline" className="h-8 text-sm" onClick={() => deny()}>
          Deny <Kbd>esc</Kbd>
        </Button>
      </footer>
    </div>
  );
}
