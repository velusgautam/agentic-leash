import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import { cn } from "~/lib/utils";

export const PageHeaderGlobalActionsContext = createContext<ReactNode>(null);
export const PageHeaderBannersContext = createContext<ReactNode>(null);

export function PageContainer({ className, ...props }: ComponentProps<"div">) {
  return <div {...props} className={cn("flex min-h-0 w-full flex-1 flex-col gap-5 overflow-auto px-7 pt-0 pb-12", className)} />;
}

export function PageHeader({
  title,
  badge,
  subtitle,
  actions,
}: {
  title: ReactNode;
  badge?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  const globalActions = useContext(PageHeaderGlobalActionsContext);
  const banners = useContext(PageHeaderBannersContext);
  return (
    <div className="shrink-0">
      <div className="drag-region flex min-h-16 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border/60 py-2.5">
        <div className="flex min-w-0 shrink-0 items-center gap-2.5">
          <h1 className="flex shrink-0 items-center gap-2.5 whitespace-nowrap text-lg font-semibold tracking-tight text-foreground">{title}</h1>
          {badge ? <span className="no-drag flex shrink-0 items-center">{badge}</span> : null}
          {subtitle ? (
            <span
              className="hidden 2xl:inline-block max-w-md truncate text-xs font-normal text-muted-foreground"
              title={typeof subtitle === "string" ? subtitle : undefined}
            >
              {subtitle}
            </span>
          ) : null}
        </div>
        {actions || globalActions ? (
          <div className="no-drag ml-auto flex flex-wrap items-center justify-end gap-2">
            {actions}
            {actions && globalActions ? <span className="h-4 w-px bg-border/60" aria-hidden /> : null}
            {globalActions}
          </div>
        ) : null}
      </div>
      {banners ? <div className="pt-4">{banners}</div> : null}
    </div>
  );
}

export function SettingsSection({ title, id, children }: { title: string; id?: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-4 space-y-2.5">
      <h2 className="flex min-h-7 items-center text-base font-semibold text-foreground">{title}</h2>
      <div className="relative overflow-visible rounded-xl border border-border/60 bg-card/40 text-foreground shadow-xs/5 [&>*+*]:border-t [&>*+*]:border-border/50">
        {children}
      </div>
    </section>
  );
}

export function SettingsRow({ title, description, control }: { title: ReactNode; description?: ReactNode; control?: ReactNode }) {
  return (
    <div data-slot="settings-row" className="@container/settings-row px-3 py-3 sm:px-4">
      <div className="flex flex-col gap-3 @min-[32rem]/settings-row:grid @min-[32rem]/settings-row:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)] @min-[32rem]/settings-row:items-center @min-[32rem]/settings-row:gap-8">
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          {description ? <p className="max-w-xl text-xs leading-normal text-muted-foreground/80">{description}</p> : null}
        </div>
        {control ? (
          <div className="flex w-full min-w-0 shrink-0 items-center gap-2 @min-[32rem]/settings-row:w-auto @min-[32rem]/settings-row:justify-end">
            {control}
          </div>
        ) : null}
      </div>
    </div>
  );
}
