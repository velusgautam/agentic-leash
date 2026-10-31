import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";

const pillVariants = cva("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap", {
  defaultVariants: { tone: "muted" },
  variants: {
    tone: {
      amber: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
      sky: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
      emerald: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      red: "bg-red-500/10 text-red-700 dark:text-red-300",
      rose: "bg-rose-500/12 text-rose-700 dark:text-rose-300",
      violet: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
      fuchsia: "bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300",
      cyan: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
      muted: "bg-muted text-muted-foreground",
      subtle: "bg-muted text-foreground/80",
    },
  },
});

export type PillTone = NonNullable<VariantProps<typeof pillVariants>["tone"]>;

export function Pill({ tone, className, ...props }: React.ComponentProps<"span"> & VariantProps<typeof pillVariants>) {
  return <span className={cn(pillVariants({ tone }), className)} {...props} />;
}

export const accessTone = (access: string): PillTone => (access === "write" ? "amber" : "sky");

export function verdictTone(verdict: string): PillTone {
  if (verdict === "allow" || verdict === "pass") return "emerald";
  if (verdict === "deny") return "red";
  if (verdict === "ask") return "amber";
  return "muted";
}
