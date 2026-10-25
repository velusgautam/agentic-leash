import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Check, Download, RefreshCw, RotateCw } from "lucide-react";
import {
  getUpdateButtonTooltip,
  resolveUpdateButtonAction,
  type UpdateState,
} from "../../../shared/updater";
import { ConfirmAction } from "~/components/ConfirmAction";
import { toast } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

const DOWNLOAD_PROGRESS_RADIUS = 14;
const DOWNLOAD_PROGRESS_CIRCUMFERENCE = 2 * Math.PI * DOWNLOAD_PROGRESS_RADIUS;

const toastedAvailableVersions = new Set<string>();
const toastedDownloadedVersions = new Set<string>();

export function useUpdateState(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    let live = true;
    void window.leash.getUpdateState?.().then((next) => {
      if (live && next) setState(next);
    }).catch(() => {});
    const off = window.leash.onUpdateState?.((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
      off?.();
    };
  }, []);
  return state;
}

function DownloadingRingIcon({ percent }: { percent: number | null }) {
  const normalized = percent !== null && Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  const offset = DOWNLOAD_PROGRESS_CIRCUMFERENCE * (1 - normalized / 100);
  return (
    <span className="relative grid size-8 place-items-center">
      <svg aria-hidden="true" className="pointer-events-none absolute inset-0 size-full -rotate-90" viewBox="0 0 32 32">
        <circle cx="16" cy="16" r={DOWNLOAD_PROGRESS_RADIUS} fill="none" className="stroke-current/20" strokeWidth="1.5" />
        <circle
          cx="16"
          cy="16"
          r={DOWNLOAD_PROGRESS_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeDasharray={DOWNLOAD_PROGRESS_CIRCUMFERENCE}
          strokeDashoffset={offset}
          strokeLinecap="round"
          strokeWidth="1.5"
          className="transition-[stroke-dashoffset] duration-300 ease-out motion-reduce:transition-none"
        />
      </svg>
      <Download className="size-4" />
    </span>
  );
}

/**
 * Updater icon plus the "update available / downloaded" toasts.
 * Pass `toastsOnly` where the icon itself shouldn't show (e.g. Settings pages) so toasts still fire.
 */
export function UpdatePill({ toastsOnly = false }: { toastsOnly?: boolean } = {}) {
  const state = useUpdateState();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const openUpdates = () => void navigate({ to: "/settings/$section", params: { section: "general" }, hash: "updates" });

  useEffect(() => {
    if (!state) return;
    if (state.status === "available" && state.availableVersion && !toastedAvailableVersions.has(state.availableVersion)) {
      toastedAvailableVersions.add(state.availableVersion);
      toast({
        title: `Update v${state.availableVersion} available`,
        description: "Download it now or later from",
        link: { label: "Settings → General → Updates", onClick: openUpdates },
        action: {
          label: "Download",
          onClick: () => void window.leash.downloadUpdate?.(),
        },
      });
    }
    if (state.status === "downloaded" && state.downloadedVersion && !toastedDownloadedVersions.has(state.downloadedVersion)) {
      toastedDownloadedVersions.add(state.downloadedVersion);
      toast({
        title: `Update v${state.downloadedVersion} downloaded`,
        description: "Restart Agentic Leash to finish installing it.",
        action: {
          label: "Restart",
          onClick: () => setConfirmOpen(true),
        },
      });
    }
  }, [state]);

  if (!state || !state.enabled) return null;

  const action = resolveUpdateButtonAction(state);
  const isDownloading = state.status === "downloading";
  const isChecking = state.status === "checking";

  if (action === "none" && !isDownloading && !isChecking) return null;

  const tooltip = getUpdateButtonTooltip(state);
  const targetVersion = state.downloadedVersion ?? state.availableVersion;

  const onClick = () => {
    if (busy || isDownloading || isChecking) return;
    if (action === "download") {
      setBusy(true);
      void window.leash.downloadUpdate?.().then((result) => {
        if (result && !result.completed && result.state.message) {
          toast({ title: "Could not download update", description: result.state.message, tone: "destructive" });
        }
      }).finally(() => setBusy(false));
    } else if (action === "install") {
      setConfirmOpen(true);
    }
  };

  return (
    <>
      {toastsOnly ? null : (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={tooltip}
              disabled={busy || isDownloading || isChecking}
              onClick={onClick}
              className={cn(
                "no-drag ml-auto inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-sidebar-accent/70 text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60",
              )}
            >
              {isDownloading ? (
                <DownloadingRingIcon percent={state.downloadPercent} />
              ) : action === "install" ? (
                <span className="relative grid size-4 place-items-center">
                  <RotateCw className="size-4" />
                  <span className="absolute -right-1 -bottom-1 grid size-2.5 place-items-center rounded-full bg-primary text-primary-foreground ring-2 ring-background">
                    <Check className="size-2" strokeWidth={3} />
                  </span>
                </span>
              ) : action === "download" ? (
                <span className="relative grid size-4 place-items-center">
                  <Download className="size-4" />
                  <span aria-hidden="true" className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-primary ring-2 ring-background" />
                </span>
              ) : (
                <RefreshCw className="size-4 animate-spin" />
              )}
            </button>
          }
        />
        <TooltipPopup side="top" align="end">
          {tooltip}
        </TooltipPopup>
      </Tooltip>
      )}
      <ConfirmAction
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        icon={RotateCw}
        title={`Install update${targetVersion ? ` v${targetVersion}` : ""} and restart?`}
        description="Agentic Leash will restart to apply the update."
        effects={[
          "Quits and replaces Agentic Leash with the downloaded release.",
          "Reopens automatically with your grants, rules, and history intact.",
        ]}
        confirmLabel="Restart and update"
        onConfirm={() => {
          void window.leash.installUpdate?.().then((result) => {
            if (result && !result.completed && result.state.message) {
              toast({ title: "Could not install update", description: result.state.message, tone: "destructive" });
            }
          });
        }}
      />
    </>
  );
}
