import { useState } from "react";
import { Lock, ShieldAlert, ShieldCheck, TriangleAlert } from "lucide-react";
import { allowText, presetById } from "../../../shared/presets";
import { SECURE_AREA_GROUP_INFO } from "../../../shared/secureAreas";
import type { HookRequest, PresetId, RequestPolicy, RiskLevel, SecureArea } from "../../../shared/types";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

const CHOICES: PresetId[] = ["once", "session", "today"];

export const presetsFor = (_policy?: RequestPolicy, _matchedSecureArea?: SecureArea | null): PresetId[] => CHOICES;

export const defaultPreset = (policy?: RequestPolicy, matchedSecureArea?: SecureArea | null): PresetId => {
  if (matchedSecureArea?.group === "secrets" || policy?.kind === "secret" || policy?.risk === "high") return "once";
  return "session";
};

export const folderLabel = (path: string) => {
  const parts = path.split("/").filter(Boolean);
  return parts[0] === "Users" && parts.length === 2 ? "~" : parts.at(-1) ?? path;
};

/** Text for an allow button. */
export const allowLabel = (_scope: string | null, choice: PresetId, repo: string | null = null) => allowText(choice, repo);

export const Kbd = ({ children, className }: { children: string; className?: string }) => (
  <kbd className={cn("rounded border border-current/20 px-1 font-sans text-[10px] leading-4 font-medium opacity-70", className)}>{children}</kbd>
);

const RISK: Record<RiskLevel, { label: string; className: string; Icon: typeof ShieldCheck }> = {
  low: { label: "Low risk", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300", Icon: ShieldCheck },
  medium: { label: "Check this", className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300", Icon: TriangleAlert },
  high: { label: "High risk", className: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300", Icon: ShieldAlert },
};

export function RiskNote({ policy, matchedSecureArea }: { policy?: RequestPolicy; matchedSecureArea?: SecureArea | null }) {
  const isSecrets = matchedSecureArea?.group === "secrets" || policy?.kind === "secret";
  const effectiveRisk: RiskLevel = isSecrets ? "high" : (policy?.risk ?? (matchedSecureArea ? "medium" : "low"));
  const risk = RISK[effectiveRisk];
  const groupTitle = matchedSecureArea ? SECURE_AREA_GROUP_INFO[matchedSecureArea.group]?.title : null;
  return (
    <div className={cn("flex items-start gap-2 rounded-lg border px-3 py-2 text-xs", risk.className)}>
      <risk.Icon className="mt-px size-3.5 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-0.5">
        <div>
          <span className="font-medium">{risk.label}</span>
          {policy?.reasons.length ? <span>{` · ${policy.reasons.join(" · ")}`}</span> : null}
        </div>
        {matchedSecureArea ? (
          <p className="flex items-center gap-1 font-medium">
            <Lock className="size-3 shrink-0" aria-hidden />
            <span>
              Secure Area: {matchedSecureArea.label}
              {groupTitle ? ` (${groupTitle})` : ""}
            </span>
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Full context for what is being asked for: matched Secure Area, command, URL, and exact path(s). */
export function ApprovalChoices({
  request,
  policy,
  matchedSecureArea,
}: {
  request: HookRequest;
  policy?: RequestPolicy;
  matchedSecureArea?: SecureArea | null;
  scope?: string | null;
  onScope?: (scope: string | null) => void;
}) {
  return (
    <>
      {policy || matchedSecureArea ? <RiskNote policy={policy} matchedSecureArea={matchedSecureArea} /> : null}
      {request.command ? (
        <div>
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">Command</div>
          <pre className="max-h-24 overflow-auto rounded-lg border border-border/60 bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
            {request.command}
          </pre>
        </div>
      ) : null}
      {request.url ? (
        <div>
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">URL</div>
          <pre className="max-h-20 overflow-auto rounded-lg border border-border/60 bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
            {request.url}
          </pre>
        </div>
      ) : null}
      {request.paths.length > 0 ? (
        <div>
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">{request.paths.length > 1 ? "Paths" : "Path"}</div>
          <pre className="max-h-24 overflow-auto rounded-lg border border-border/60 bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
            {request.paths.join("\n")}
          </pre>
        </div>
      ) : null}
    </>
  );
}

/** One click allows: Allow once, Allow this session, or Allow today. Secrets group keeps default focus on Deny. */
export function AllowButtons({
  policy,
  matchedSecureArea,
  disabled,
  showKeys,
  onAllow,
}: {
  policy?: RequestPolicy;
  matchedSecureArea?: SecureArea | null;
  scope?: string | null;
  disabled?: boolean;
  showKeys?: boolean;
  onAllow: (id: PresetId) => void;
}) {
  const presets = presetsFor(policy, matchedSecureArea);
  const isSecretsGroup = matchedSecureArea?.group === "secrets" || policy?.kind === "secret";
  const preferred = defaultPreset(policy, matchedSecureArea);
  const [hover, setHover] = useState<PresetId | null>(null);
  const explained = hover ?? preferred;
  const enterOk = !isSecretsGroup && policy?.risk !== "high";
  return (
    <div>
      <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${presets.length}, minmax(0, 1fr))` }}>
        {presets.map((id, index) => (
          <Button
            key={id}
            size="sm"
            variant={!isSecretsGroup && id === preferred ? (policy?.risk === "high" ? "destructive" : "default") : "outline"}
            disabled={disabled}
            className="h-9 min-w-0 text-xs sm:text-sm"
            title={presetById(id).hint}
            onMouseEnter={() => setHover(id)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(id)}
            onBlur={() => setHover(null)}
            onClick={() => onAllow(id)}
          >
            <span className="truncate">{allowText(id)}</span>
            {showKeys ? <Kbd>{String(index + 1)}</Kbd> : null}
          </Button>
        ))}
      </div>
      <p className="mt-1.5 min-h-4 text-xs text-muted-foreground">
        <span className="font-medium text-foreground/80">{isSecretsGroup && !hover ? "Default: Deny (Secrets group)" : allowText(explained)}</span>
        {!isSecretsGroup || hover ? ` · ${presetById(explained).hint}` : " · Press Esc or Enter on Deny to block."}
        {showKeys && explained === preferred && enterOk ? <Kbd className="ml-1.5">↵</Kbd> : null}
      </p>
    </div>
  );
}
