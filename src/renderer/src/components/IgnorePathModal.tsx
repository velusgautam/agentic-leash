import { useEffect, useState } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { EyeOff } from "lucide-react";
import { Button } from "~/components/ui/button";
import { toast } from "~/components/ui/toast";

export function IgnorePathModal({
  open,
  onOpenChange,
  initialPath,
  onIgnored,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialPath: string;
  onIgnored?: (path: string) => void;
}) {
  const [path, setPath] = useState(initialPath);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setPath(initialPath);
      setError("");
      setSubmitting(false);
    }
  }, [open, initialPath]);

  const handleIgnore = async () => {
    const cleaned = path.trim();
    if (!cleaned.startsWith("/") || cleaned === "/" || /[\0\n\r]/.test(cleaned)) {
      setError("Use a full path, such as /tmp/scratch.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await window.leash.addIgnored(cleaned);
      if (result.added) {
        toast({ title: "Path added to hidden paths", description: cleaned });
        onOpenChange(false);
        onIgnored?.(cleaned);
      } else {
        setError("Could not hide this path. Ensure it is a valid full path.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <AlertDialog.Viewport className="fixed inset-0 z-50 grid place-items-center p-6">
          <AlertDialog.Popup className="dialog-glass w-full max-w-md overflow-hidden rounded-2xl border border-border text-popover-foreground shadow-2xl transition-[opacity,scale] duration-150 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0">
            <div className="flex gap-3.5 px-6 pt-6 pb-4">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
                <EyeOff className="size-4.5" aria-hidden />
              </span>
              <div className="min-w-0 space-y-1.5">
                <AlertDialog.Title className="text-base font-semibold tracking-tight">Hide path from history</AlertDialog.Title>
                <AlertDialog.Description className="text-sm leading-normal text-muted-foreground">
                  Activity under this path will be excluded from history and dropped from future captures. Agents still ask before using it.
                </AlertDialog.Description>
              </div>
            </div>

            <form
              className="px-6 pb-5 space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                void handleIgnore();
              }}
            >
              <label htmlFor="ignore-path-input" className="block text-xs font-medium text-foreground">
                Path to ignore
              </label>
              <input
                id="ignore-path-input"
                aria-label="Path to ignore"
                className="w-full h-8 rounded-lg border border-border bg-background/60 px-2.5 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={path}
                onChange={(e) => {
                  setPath(e.target.value);
                  if (error) setError("");
                }}
                autoFocus
              />
              <p className="text-[11px] text-muted-foreground">
                You can edit this path to ignore a directory or prefix (e.g. parent folder).
              </p>
              {error ? <p className="text-xs text-destructive">{error}</p> : null}

              <div className="flex justify-end gap-2 pt-3 border-t border-border/60 -mx-6 px-6 -mb-5 py-3.5 bg-muted/50 mt-4">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={submitting}
                >
                  Ignore
                </Button>
              </div>
            </form>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
