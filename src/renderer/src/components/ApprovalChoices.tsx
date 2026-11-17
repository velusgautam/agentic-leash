import { useState } from "react";
import { FileText, Folder, Globe, Lock, ShieldAlert, ShieldCheck, SquareTerminal, TriangleAlert } from "lucide-react";
import { parentFolders } from "../../../shared/parents";
import { allowText, presetById } from "../../../shared/presets";
import { SECURE_AREA_GROUP_INFO } from "../../../shared/secureAreas";
import type { HookRequest, PresetId, RequestPolicy, RiskLevel, SecureArea } from "../../../shared/types";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

const BASE_CHOICES: PresetId[] = ["once", "session", "today"];

function hasUnresolved(paths: readonly string[]): boolean {
  return paths.some((path) => path.includes("$"));
}

export interface ScopeChoice {
  value: string;
  label: string;
  kind: "repo" | "folder" | "file";
}

function isSecretLike(policy?: RequestPolicy, matchedSecureArea?: SecureArea | null): boolean {
  return (
    matchedSecureArea?.group === "secrets" ||
    matchedSecureArea?.group === "project_secrets" ||
    policy?.kind === "secret"
  );
}

export function scopeChoicesFor(
  request?: HookRequest,
  policy?: RequestPolicy,
  matchedSecureArea?: SecureArea | null,
): ScopeChoice[] {
  if (!request || request.paths.length === 0 || hasUnresolved(request.paths)) return [];
  if (isSecretLike(policy, matchedSecureArea) || policy?.kind === "startup" || policy?.kind === "egress" || policy?.risk === "high") {
    return [];
  }
  const parents = parentFolders(request.paths);
  const choices: ScopeChoice[] = [];
  const seen = new Set<string>();
  const add = (value: string, label: string, kind: ScopeChoice["kind"]) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    choices.push({ value, label, kind });
  };
  if (policy?.repo && parents.includes(policy.repo)) {
    add(policy.repo, `${folderLabel(policy.repo)} (repo)`, "repo");
  }
  if (parents[0]) {
    add(parents[0], folderLabel(parents[0]), "folder");
  }
  if (!policy?.repo && parents[1]) {
    add(parents[1], folderLabel(parents[1]), "folder");
  }
  if (request.paths.length === 1 && request.paths[0]) {
    add(request.paths[0], folderLabel(request.paths[0]), "file");
  }
  return choices;
}

export function defaultScope(
  request?: HookRequest,
  policy?: RequestPolicy,
  matchedSecureArea?: SecureArea | null,
): string | null {
  const choices = scopeChoicesFor(request, policy, matchedSecureArea);
  return choices.find((c) => c.kind === "repo")?.value ?? choices.find((c) => c.kind === "folder")?.value ?? null;
}

export const presetsFor = (
  policy?: RequestPolicy,
  matchedSecureArea?: SecureArea | null,
  hasScope = false,
): PresetId[] => {
  const canAlways =
    hasScope &&
    !isSecretLike(policy, matchedSecureArea) &&
    policy?.kind !== "startup" &&
    policy?.kind !== "egress" &&
    policy?.risk !== "high";
  return canAlways ? [...BASE_CHOICES, "always"] : BASE_CHOICES;
};

export const defaultPreset = (policy?: RequestPolicy, matchedSecureArea?: SecureArea | null): PresetId => {
  if (matchedSecureArea?.group === "secrets" || policy?.kind === "secret" || policy?.risk === "high") return "once";
  return "session";
};

export const folderLabel = (path: string) => {
  const parts = path.split("/").filter(Boolean);
  return parts[0] === "Users" && parts.length === 2 ? "~" : parts.at(-1) ?? path;
};

/** Text for an allow button. */
export const allowLabel = (_scope: string | null, choice: PresetId, repo: string | null = null) =>
  choice === "always" ? "Always allow folder" : allowText(choice, repo);

export const Kbd = ({ children, className }: { children: string; className?: string }) => (
  <kbd className={cn("rounded border border-current/20 px-1 font-sans text-[10px] leading-4 font-medium opacity-70", className)}>{children}</kbd>
);

const RISK: Record<RiskLevel, { label: string; className: string; Icon: typeof ShieldCheck }> = {
  low: { label: "Low risk", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300", Icon: ShieldCheck },
  medium: { label: "Check this", className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300", Icon: TriangleAlert },
  high: { label: "High risk", className: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300", Icon: ShieldAlert },
};

export function RiskNote({
  request,
  policy,
  matchedSecureArea,
}: {
  request?: HookRequest;
  policy?: RequestPolicy;
  matchedSecureArea?: SecureArea | null;
}) {
  const isSecrets = matchedSecureArea?.group === "secrets" || policy?.kind === "secret";
  const effectiveRisk: RiskLevel = isSecrets ? "high" : (policy?.risk ?? (matchedSecureArea ? "medium" : "low"));
  const risk = RISK[effectiveRisk];
  const groupTitle = matchedSecureArea ? SECURE_AREA_GROUP_INFO[matchedSecureArea.group]?.title : null;
  const isNetworkAfterSecret = Boolean(request?.afterSecret || policy?.kind === "egress");
  const isDestructive = Boolean(
    policy?.risk === "high" &&
      !isSecrets &&
      !isNetworkAfterSecret &&
      request?.command &&
      policy?.kind !== "startup",
  );

  return (
    <div className={cn("flex items-start gap-2 rounded-lg border px-3 py-2 text-xs", risk.className)}>
      <risk.Icon className="mt-px size-3.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium">{risk.label}</span>
          {matchedSecureArea ? (
            <span className="inline-flex items-center gap-1 rounded bg-background/50 px-1.5 py-0.5 text-[11px] font-medium">
              <Lock className="size-3 shrink-0" aria-hidden />
              Secure Area{groupTitle ? ` · ${groupTitle}` : ""}
            </span>
          ) : null}
          {isDestructive ? (
            <span className="inline-flex items-center gap-1 rounded bg-background/50 px-1.5 py-0.5 text-[11px] font-medium">
              <SquareTerminal className="size-3 shrink-0" aria-hidden />
              Destructive command
            </span>
          ) : null}
          {isNetworkAfterSecret ? (
            <span className="inline-flex items-center gap-1 rounded bg-background/50 px-1.5 py-0.5 text-[11px] font-medium">
              <Globe className="size-3 shrink-0" aria-hidden />
              Network after secret
            </span>
          ) : null}
        </div>
        {policy?.reasons.length ? (
          <p className="text-[11px] opacity-90">{policy.reasons.join(" · ")}</p>
        ) : null}
        {matchedSecureArea ? (
          <p className="text-[11px] font-medium">
            Rule: {matchedSecureArea.label} ({request?.access === "write" ? `Write: ${matchedSecureArea.writeRule}` : `Read: ${matchedSecureArea.readRule}`})
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Full context for what is being asked for: matched Secure Area, scope chips, command, URL, and exact path(s). */
export function ApprovalChoices({
  request,
  policy,
  matchedSecureArea,
  scope,
  onScope,
}: {
  request: HookRequest;
  policy?: RequestPolicy;
  matchedSecureArea?: SecureArea | null;
  scope?: string | null;
  onScope?: (scope: string | null) => void;
}) {
  const scopes = scopeChoicesFor(request, policy, matchedSecureArea);
  return (
    <>
      {policy || matchedSecureArea ? <RiskNote request={request} policy={policy} matchedSecureArea={matchedSecureArea} /> : null}
      {scopes.length > 0 && onScope ? (
        <div>
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">Allow scope</div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Allow scope">
            {scopes.map((choice) => {
              const active = scope === choice.value;
              const Icon = choice.kind === "file" ? FileText : Folder;
              return (
                <button
                  key={choice.value}
                  type="button"
                  aria-pressed={active}
                  title={choice.value}
                  onClick={() => onScope(choice.value)}
                  className={cn(
                    "inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors",
                    active
                      ? "border-primary bg-primary/12 font-medium text-foreground ring-1 ring-primary/30"
                      : "border-border/70 bg-muted/30 text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  <Icon className="size-3 shrink-0" aria-hidden />
                  <span className="truncate">{choice.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
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

/** One click allows: Allow once, Allow this session, Allow today, or Always allow folder. Secrets group keeps default focus on Deny. */
export function AllowButtons({
  request,
  policy,
  matchedSecureArea,
  scope,
  disabled,
  showKeys,
  onAllow,
}: {
  request?: HookRequest;
  policy?: RequestPolicy;
  matchedSecureArea?: SecureArea | null;
  scope?: string | null;
  disabled?: boolean;
  showKeys?: boolean;
  onAllow: (id: PresetId) => void;
}) {
  const hasScope = request ? scopeChoicesFor(request, policy, matchedSecureArea).length > 0 : Boolean(scope);
  const presets = presetsFor(policy, matchedSecureArea, hasScope);
  const isSecretsGroup = matchedSecureArea?.group === "secrets" || policy?.kind === "secret";
  const preferred = defaultPreset(policy, matchedSecureArea);
  const [hover, setHover] = useState<PresetId | null>(null);
  const explained = hover ?? preferred;
  const enterOk = !isSecretsGroup && policy?.risk !== "high";
  const scopeIsFile = Boolean(scope && request?.paths.includes(scope) && !parentFolders(request.paths).includes(scope));
  const labelFor = (id: PresetId) => {
    if (id === "always") return scopeIsFile ? "Always allow file" : "Always allow folder";
    return allowText(id);
  };
  const hintFor = (id: PresetId) => {
    if (id === "always") {
      return `Adds ${scope ? folderLabel(scope) : "this folder"} to Secure Areas as Allow so it won't ask again.`;
    }
    if ((id === "session" || id === "today") && scope) {
      return `For ${folderLabel(scope)}. ${presetById(id).hint}`;
    }
    return presetById(id).hint;
  };
  return (
    <div>
      <div
        className={cn("grid gap-1.5", presets.length === 4 ? "grid-cols-2" : undefined)}
        style={presets.length === 4 ? undefined : { gridTemplateColumns: `repeat(${presets.length}, minmax(0, 1fr))` }}
      >
        {presets.map((id, index) => (
          <Button
            key={id}
            size="sm"
            variant={!isSecretsGroup && id === preferred ? (policy?.risk === "high" ? "destructive" : "default") : "outline"}
            disabled={disabled}
            className="h-9 min-w-0 text-xs sm:text-sm"
            title={hintFor(id)}
            onMouseEnter={() => setHover(id)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(id)}
            onBlur={() => setHover(null)}
            onClick={() => onAllow(id)}
          >
            <span className="truncate">{labelFor(id)}</span>
            {showKeys ? <Kbd>{String(index + 1)}</Kbd> : null}
          </Button>
        ))}
      </div>
      <p className="mt-1.5 min-h-4 text-xs text-muted-foreground">
        <span className="font-medium text-foreground/80">
          {isSecretsGroup && !hover ? "Default: Deny (Secrets group)" : labelFor(explained)}
        </span>
        {!isSecretsGroup || hover ? ` · ${hintFor(explained)}` : " · Press Esc or Enter on Deny to block."}
        {showKeys && explained === preferred && enterOk ? <Kbd className="ml-1.5">↵</Kbd> : null}
      </p>
    </div>
  );
}
