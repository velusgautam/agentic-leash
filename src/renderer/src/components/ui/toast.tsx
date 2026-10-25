import { Toast } from "@base-ui/react/toast";
import { X } from "lucide-react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

const manager = Toast.createToastManager();

type ToastLink = { label: string; onClick: () => void };

export function toast({ title, description, tone = "default", action, link }: { title: string; description?: string; tone?: "default" | "destructive"; action?: { label: string; onClick: () => void }; link?: ToastLink }) {
  return manager.add({ title, description, type: tone, priority: tone === "destructive" ? "high" : "low", actionProps: action && { children: action.label, onClick: action.onClick }, data: link ? { link } : undefined });
}

export const useToast = () => toast;

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((item) => (
    <Toast.Root
      key={item.id}
      toast={item}
      className={cn(
        "pointer-events-auto flex items-start gap-3 rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg transition-[opacity,translate] duration-150 data-ending-style:translate-y-2 data-ending-style:opacity-0 data-starting-style:translate-y-2 data-starting-style:opacity-0",
        item.type === "destructive" ? "border-destructive/40" : "border-border",
      )}
    >
      <Toast.Content className="min-w-0 flex-1 space-y-0.5">
        <Toast.Title className={cn("text-sm font-medium", item.type === "destructive" && "text-destructive")} />
        <Toast.Description className="text-xs wrap-anywhere text-muted-foreground" />
        {(item.data as { link?: ToastLink } | undefined)?.link ? (
          <button
            type="button"
            className="text-left text-xs font-medium text-foreground underline underline-offset-2 hover:text-primary"
            onClick={() => {
              (item.data as { link: ToastLink }).link.onClick();
              manager.close(item.id);
            }}
          >
            {(item.data as { link: ToastLink }).link.label}
          </button>
        ) : null}
      </Toast.Content>
      {item.actionProps ? <Toast.Action render={<Button size="sm" variant="outline" />} /> : null}
      <Toast.Close render={<Button size="icon-sm" variant="ghost" aria-label="Dismiss" />}>
        <X />
      </Toast.Close>
    </Toast.Root>
  ));
}

export function Toaster() {
  return (
    <Toast.Provider toastManager={manager} timeout={5000}>
      <Toast.Portal>
        <Toast.Viewport className="pointer-events-none fixed right-4 bottom-4 z-[150] flex w-80 flex-col gap-2">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

export function toastRevoked(count: number) {
  toast({
    title: `Revoked ${count} ${count === 1 ? "grant" : "grants"}`,
    description: "Lockdown is on. Agent tool calls are blocked.",
  });
}
