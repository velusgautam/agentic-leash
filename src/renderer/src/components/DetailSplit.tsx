import { useEffect, useRef, useState, type ReactNode } from "react";
import { PanelRightClose, PanelRightOpen, X } from "lucide-react";
import { Button } from "~/components/ui/button";

const DOCK_AT = 900;

export function DetailSplit({
  toolbar,
  list,
  detail,
  onClose,
}: {
  toolbar: ReactNode;
  list: ReactNode;
  detail: ((docked: boolean) => ReactNode) | null;
  onClose?: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWide((entry?.contentRect.width ?? 0) >= DOCK_AT));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!detail || !onClose) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [detail, onClose]);
  const docked = wide && detail !== null && !collapsed;
  const body = detail?.(docked) ?? null;
  return (
    <div ref={rootRef} className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="shrink-0 px-5 pt-1">{toolbar}</div>
        <div className="flex min-h-0 flex-1 flex-col px-5 pt-3 pb-4">{list}</div>
        {!docked && body ? <div className="max-h-[45%] shrink-0 overflow-auto px-5 pb-5">{body}</div> : null}
      </div>
      {docked ? (
        <aside className="flex w-[clamp(20rem,36%,34rem)] shrink-0 flex-col border-l border-border/60 bg-card/30">
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/50 pr-2 pl-4">
            <span className="text-xs font-medium text-muted-foreground">Details</span>
            <div className="flex items-center gap-0.5">
              <Button size="icon-sm" variant="ghost" aria-label="Dock to bottom" title="Dock to bottom" onClick={() => setCollapsed(true)}>
                <PanelRightClose className="size-4" />
              </Button>
              {onClose ? (
                <Button size="icon-sm" variant="ghost" aria-label="Close details" title="Close details (Esc)" onClick={onClose}>
                  <X className="size-4" />
                </Button>
              ) : null}
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-auto">{body}</div>
        </aside>
      ) : null}
      {wide && collapsed && detail ? (
        <button type="button" aria-label="Show details" title="Show details" className="flex w-9 shrink-0 items-start justify-center border-l border-border/60 pt-3 text-muted-foreground hover:bg-accent" onClick={() => setCollapsed(false)}>
          <PanelRightOpen className="size-4" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
