import type { ComponentProps, ReactNode } from "react";
import { cn } from "~/lib/utils";

export function PageContainer({ className, ...props }: ComponentProps<"div">) {
  return <div {...props} className={cn("flex min-h-0 w-full flex-1 flex-col gap-6 overflow-auto px-5 pt-1 pb-12", className)} />;
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
