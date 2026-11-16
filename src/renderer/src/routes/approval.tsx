import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Undo2, X } from "lucide-react";
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

const isSecretsItem = (item: PendingRequest | undefined) =>
  Boolean(item && (item.matchedSecureArea?.group === "secrets" || item.policy?.kind === "secret"));

function UndoBar({ undo, onUndo }: { undo: { id: string; label: string }; onUndo: () => void }) {
  return (
    <div role="status" className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/60 px-3 py-1.5 text-xs">
      <p className="min-w-0 flex-1 truncate">
        Denied <span className="font-mono">{undo.label}</span>
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
  const [undo, setUndo] = useState<{ id: string; label: string; at: number } | null>(null);
  const denyButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const current = pending[0];
  const currentIsSecrets = isSecretsItem(current);
  const hasSecretsInBatch = pending.some(isSecretsItem);
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
  useEffect(() => {
    if (currentIsSecrets) {
      denyButtonRef.current?.focus();
    }
  }, [current?.id, currentIsSecrets]);
  const showUndo = undo && now - undo.at < UNDO_MS ? undo : null;
  const presets = presetsFor(current?.policy, current?.matchedSecureArea);
  const allow = (preset: PresetId) => current && armed && void window.leash.decidePending(current.id, "allow", null, undefined, preset);
  const deny = () => {
    if (!current) return;
    setUndo({ id: current.id, label: targetOf(current), at: Date.now() });
    void window.leash.decidePending(current.id, "deny", null);
  };
  const undoDeny = () => {
    if (!undo) return;
    void window.leash.undoDeny(undo.id);
    setUndo(null);
  };
  const allowAll = () => {
    if (hasSecretsInBatch) return;
    for (const id of pending.map((item) => item.id)) void window.leash.decidePending(id, "allow", null, undefined, "session");
  };
  const denyAll = () => {
    for (const id of pending.map((item) => item.id)) void window.leash.decidePending(id, "deny", null);
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!current) return;
      // High-risk and Secrets requests keep focus on Deny so Enter muscle memory can't approve them.
      if (event.key === "Enter" && !currentIsSecrets && current.policy?.risk !== "high") {
        allow(defaultPreset(current.policy, current.matchedSecureArea));
      }
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
        <ApprovalChoices request={request} policy={current.policy} matchedSecureArea={current.matchedSecureArea} />
        <AllowButtons policy={current.policy} matchedSecureArea={current.matchedSecureArea} disabled={!armed} showKeys onAllow={allow} />
      </div>
      {pending.length > 1 ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-border/60 px-4 py-1.5">
          <p className="mr-auto text-xs text-muted-foreground tabular-nums">{pending.length} waiting:</p>
          <Button size="sm" variant="ghost" className="h-7" onClick={denyAll}>Deny all ({pending.length})</Button>
          {!hasSecretsInBatch ? (
            <Button size="sm" variant="outline" className="h-7" disabled={!armed} onClick={allowAll}>
              Allow all ({pending.length}) this session
            </Button>
          ) : (
            <span className="text-[11px] text-muted-foreground">Secrets in batch — decide individually</span>
          )}
        </div>
      ) : null}
      <footer className="flex shrink-0 items-center gap-2 border-t border-border/60 bg-muted/50 px-4 py-2.5">
        <p className="mr-auto text-xs text-muted-foreground tabular-nums">{denyCountdown(pendingSecondsLeft(current.askedAt, now, POPUP_TIMEOUT_S))}</p>
        <Button
          ref={denyButtonRef}
          size="sm"
          variant={currentIsSecrets ? "destructive" : "outline"}
          className="h-8 text-sm"
          onClick={() => deny()}
        >
          Deny <Kbd>esc</Kbd>
        </Button>
      </footer>
    </div>
  );
}
