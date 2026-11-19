import type { ReactElement, ReactNode } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { ArrowRight, ShieldOff, type LucideIcon } from "lucide-react";
import type { Grant } from "../../../shared/types";
import { AGENT_LABELS } from "~/components/Icons";
import { Button } from "~/components/ui/button";

export function ConfirmAction({
  trigger,
  title,
  description,
  effects,
  confirmLabel,
  icon: Icon = ShieldOff,
  onConfirm,
  open,
  onOpenChange,
}: {
  trigger?: ReactElement;
  title: ReactNode;
  description?: ReactNode;
  effects: string[];
  confirmLabel: string;
  icon?: LucideIcon;
  onConfirm: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <AlertDialog.Trigger render={trigger} /> : null}
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <AlertDialog.Viewport className="fixed inset-0 z-50 grid place-items-center p-6">
          <AlertDialog.Popup className="dialog-glass w-full max-w-md overflow-hidden rounded-2xl border border-border text-popover-foreground shadow-2xl transition-[opacity,scale] duration-150 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0">
            <div className="flex gap-3.5 px-6 pt-6 pb-4">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                <Icon className="size-4.5" aria-hidden />
              </span>
              <div className="min-w-0 space-y-1.5">
                <AlertDialog.Title className="text-base font-semibold tracking-tight">{title}</AlertDialog.Title>
                {description ? <AlertDialog.Description className="text-sm wrap-anywhere text-muted-foreground">{description}</AlertDialog.Description> : null}
              </div>
            </div>
            <ul className="mx-6 mb-5 space-y-2 rounded-xl border border-border/60 bg-muted/40 px-4 py-3 text-sm">
              {effects.map((effect) => (
                <li key={effect} className="flex gap-2.5">
                  <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span>{effect}</span>
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2 border-t border-border/60 bg-muted/50 px-6 py-3.5">
              <AlertDialog.Close render={<Button size="sm" variant="ghost" />}>Cancel</AlertDialog.Close>
              <AlertDialog.Close render={<Button size="sm" variant="destructive" />} onClick={onConfirm}>
                {confirmLabel}
              </AlertDialog.Close>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

export const REVOKE_ALL_EFFECTS = [
  "Unmarks every trusted folder in ~/.claude.json. A .bak is written first.",
  "Removes Agentic Leash's Read and Write rules from Cursor's cli-config.json.",
  "Deletes every Agentic Leash grant and active session allow.",
];

export const TRUST_EFFECTS = [
  "Marks this folder as untrusted in ~/.claude.json. A .bak is written first.",
  "Claude shows its trust prompt the next time it opens here.",
  "Sessions already running keep access until they restart.",
];

export function grantEffects(grant: Grant): string[] {
  const who = grant.agent === "*" ? "all agents" : AGENT_LABELS[grant.agent] ?? grant.agent;
  if (grant.source === "leash") return [`Deletes the Agentic Leash grant for ${who}.`, "The next access here opens an approval request again."];
  if (grant.agent === "cursor") return ["Removes the Read and Write rules for this path from ~/.cursor/cli-config.json. A .bak is written first.", "Cursor asks for permission again next time."];
  return TRUST_EFFECTS;
}
