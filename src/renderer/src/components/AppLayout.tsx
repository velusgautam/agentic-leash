import { useEffect, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, ArrowLeft, Database, Lock, LockOpen, RotateCw, Settings, ShieldOff, X } from "lucide-react";
import { ConfirmAction, REVOKE_ALL_EFFECTS } from "~/components/ConfirmAction";
import { AgentIcon, LeashMark } from "~/components/Icons";
import { PageHeaderGlobalActionsContext } from "~/components/settings";
import { Button } from "~/components/ui/button";
import { useAppInfo } from "~/components/useAppInfo";
import { toast, Toaster, toastRevoked } from "~/components/ui/toast";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
} from "~/components/ui/sidebar";
import { visibleAgent } from "../../../shared/setup";
import type { HealthWarning } from "../../../shared/types";
import { WelcomeDialog } from "~/components/WelcomeDialog";
import { formatCap, type StorageWarning } from "../../../shared/storage";
import { useLeashData } from "~/hooks/useLeash";
import { cn } from "~/lib/utils";
import { SetupScreen } from "~/components/SetupScreen";
import { UpdatePill } from "~/components/UpdatePill";
import { useGrantStatus } from "~/components/useGrantStatus";
import { SetupProvider, useSetup } from "~/components/useSetup";
import { AGENT_NAV, MAIN_NAV, SETTINGS_SECTIONS } from "~/nav";

function GlobalActions({
  count,
  lockdown,
}: {
  count: number;
  lockdown: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <Button
        size="sm"
        variant={lockdown ? "destructive" : "outline"}
        className={`group h-8 rounded-lg gap-1.5 px-2.5 text-xs transition-all duration-200 ${
          lockdown
            ? "border-destructive/60 bg-destructive/15 text-destructive hover:bg-destructive/25 shadow-xs shadow-destructive/10"
            : "border-border/70 bg-card/60 text-muted-foreground hover:text-rose-600 dark:hover:text-rose-400 hover:border-rose-500/40 hover:bg-rose-500/10"
        }`}
        onClick={() => {
          if (lockdown) {
            void window.leash.unlock().then(() => toast({ title: "Lockdown ended" }));
          } else {
            void window.leash.revokeAll().then((result) => toastRevoked(result.revoked));
          }
        }}
        title={lockdown ? "Lockdown is active. Click to end." : "Lockdown and revoke all grants"}
      >
        {lockdown ? (
          <Lock className="size-3.5 text-destructive fill-destructive/40 animate-pulse group-hover:scale-110 transition-transform duration-200" />
        ) : (
          <LockOpen className="size-3.5 text-muted-foreground group-hover:text-rose-500 group-hover:scale-110 transition-all duration-200" />
        )}
        <span>{lockdown ? "Locked down" : "Lockdown"}</span>
      </Button>

      <RevokeAll count={count} />
    </div>
  );
}

function RevokeAll({ count }: { count: number }) {
  return (
    <ConfirmAction
      trigger={
        <Button
          size="sm"
          variant="ghost"
          className="group h-8 rounded-lg border border-border/70 bg-card/60 px-2.5 text-xs text-muted-foreground hover:border-rose-500/40 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-500/10 disabled:opacity-40 transition-all duration-200"
          disabled={count === 0}
          title={count === 0 ? "No active grants to revoke" : `Revoke all ${count} grants`}
        >
          <ShieldOff className="size-3.5 text-muted-foreground group-hover:text-rose-500 group-hover:scale-110 transition-all duration-200" />
          <span>Revoke ({count})</span>
        </Button>
      }
      title={`Revoke all ${count} grants?`}
      description="Every agent loses the folder access it has now."
      effects={REVOKE_ALL_EFFECTS}
      confirmLabel="Revoke all"
      onConfirm={() => void window.leash.revokeAll().then((result) => toastRevoked(result.revoked))}
    />
  );
}

function StatusPill({
  lockdown,
  restart,
  onClearRestart,
}: {
  lockdown: boolean;
  restart: { name: string; kind: "gui" | "cli"; count: number }[];
  onClearRestart: () => void;
}) {
  if (lockdown) {
    return (
      <div className="no-drag flex items-center gap-2 rounded-full border border-destructive/40 bg-destructive/15 py-1 pr-2.5 pl-3 text-xs text-destructive">
        <Lock className="size-3.5 fill-destructive shrink-0" aria-hidden />
        <span className="font-medium">Lockdown active · all calls blocked</span>
        <button
          type="button"
          className="ml-1 rounded px-1.5 py-0.5 text-[11px] font-medium bg-destructive/20 hover:bg-destructive/30 text-destructive transition-colors"
          onClick={() => void window.leash.unlock()}
        >
          End
        </button>
      </div>
    );
  }

  if (restart.length) {
    return (
      <div className="no-drag flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 py-1 pr-2 pl-3 text-xs text-amber-700 dark:text-amber-300">
        <RotateCw className="size-3.5 text-amber-500 shrink-0" aria-hidden />
        <span className="font-medium">Restart needed for {restart.map((r) => r.name).join(", ")}</span>
        <ConfirmAction
          trigger={
            <button type="button" className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-amber-500/20 hover:bg-amber-500/30 text-amber-800 dark:text-amber-200">
              Restart
            </button>
          }
          title="Restart these agents?"
          description="Unsaved work in them may be lost."
          effects={restart.map((item) =>
            item.kind === "gui"
              ? `Quits ${item.name}. Open it again yourself.`
              : `Stops ${item.count} ${item.name} ${item.count === 1 ? "session" : "sessions"}. Start ${item.count === 1 ? "it" : "them"} again in the terminal${item.name === "Claude" ? " (claude --continue resumes)" : ""}.`,
          )}
          confirmLabel="Restart"
          onConfirm={() => void window.leash.restartAgents().then(onClearRestart)}
        />
        <button
          type="button"
          aria-label="Dismiss"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => void window.leash.dismissRestart().then(onClearRestart)}
        >
          <X className="size-3.5" />
        </button>
      </div>
    );
  }

  return <div className="min-w-0" />;
}

function LockdownBanner() {
  return (
    <div role="status" className="mx-6 mb-2 flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/10 py-1.5 pr-1.5 pl-3 text-sm">
      <Lock className="size-4 shrink-0 text-destructive" aria-hidden />
      <span className="min-w-0 flex-1">Lockdown is on. Every agent tool call is blocked.</span>
      <Button size="sm" variant="outline" onClick={() => void window.leash.unlock()}>End lockdown</Button>
    </div>
  );
}

function HealthBanner() {
  const [warning, setWarning] = useState<HealthWarning | null>(null);
  useEffect(() => {
    if (!window.leash.healthWarning) return;
    const load = () => void window.leash.healthWarning().then(setWarning).catch(() => {});
    load();
    const off = window.leash.onHealthWarning ? window.leash.onHealthWarning(setWarning) : undefined;
    const timer = window.setInterval(load, 5000);
    return () => {
      off?.();
      window.clearInterval(timer);
    };
  }, []);
  if (!warning) return null;
  return (
    <div role="status" className="mx-6 mb-2 flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 py-1.5 pr-1.5 pl-3 text-sm">
      <AlertTriangle className="size-4 shrink-0 text-amber-500" aria-hidden />
      <span className="min-w-0 flex-1">{warning.message}</span>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Dismiss health warning"
        onClick={() => {
          setWarning(null);
          void window.leash.dismissHealthWarning?.();
        }}
      >
        <X />
      </Button>
    </div>
  );
}

type StorageState = { warning: StorageWarning | null; capBytes: number } | null;
const loadWarning = () => window.leash.storageWarning();
const subscribeStorage = (refresh: () => void) => window.leash.onStorage(refresh);

function StorageBanner() {
  const navigate = useNavigate();
  const state: StorageState = useLeashData<StorageState>(loadWarning, subscribeStorage, null, 30_000);
  const warning = state?.warning;
  if (!state || !warning) return null;
  const cap = formatCap(state.capBytes);
  const manage = <Button size="sm" variant="outline" onClick={() => void navigate({ to: "/settings/$section", params: { section: "monitoring" }, hash: "storage" })}>Manage storage</Button>;
  if (!warning.closable) {
    return (
      <div role="status" className="mx-5 mb-2 flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/10 py-1.5 pr-1.5 pl-3 text-sm">
        <Database className="size-4 shrink-0 text-destructive" aria-hidden />
        <span className="min-w-0 flex-1">History is at its {cap} limit. The oldest history, including sensitive files, is being deleted. Raise the limit or clean up to stop this.</span>
        {manage}
      </div>
    );
  }
  return (
    <div role="status" className="mx-5 mb-2 flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 py-1.5 pr-1.5 pl-3 text-sm">
      <Database className="size-4 shrink-0 text-amber-500" aria-hidden />
      <span className="min-w-0 flex-1">History is using {warning.percent}% of its {cap} limit. Automatic cleanup is removing old reads first, then file changes and network activity if needed.</span>
      {manage}
      <Button size="icon-sm" variant="ghost" aria-label="Dismiss" onClick={() => void window.leash.dismissStorageWarning(warning.step)}>
        <X />
      </Button>
    </div>
  );
}

function MainNav({ pathname, agents }: { pathname: string; agents: readonly { id: string; label: string }[] }) {
  return (
    <>
      <SidebarGroup className="p-0">
        <SidebarMenu className="gap-1">
          {MAIN_NAV.map(({ to, label, icon: Icon }) => (
            <SidebarMenuItem key={to}>
              <SidebarMenuButton className="group" isActive={pathname === to} render={<Link to={to} />}>
                <Icon
                  className={cn(
                    "transition-all duration-200",
                    pathname === to ? "text-primary" : "text-muted-foreground group-hover:scale-110",
                    to === "/live" && "group-hover:text-emerald-500",
                    to === "/history" && "group-hover:text-sky-500",
                    to === "/grants" && "group-hover:text-amber-500",
                    to === "/insights" && "group-hover:text-purple-500",
                    to === "/mcp" && "group-hover:text-cyan-500",
                    to === "/skills" && "group-hover:text-violet-500",
                    to === "/plugins" && "group-hover:text-pink-500",
                  )}
                />
                <span className="transition-colors duration-200 group-hover:text-foreground">{label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroup>
      <div className="mx-1 mt-3 border-t border-sidebar-border" role="separator" />
      <SidebarGroup className="p-0">
        <div className="px-3 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">Agents</div>
        <SidebarMenu className="gap-1">
          {agents.map(({ id, label }) => (
            <SidebarMenuItem key={id}>
              <SidebarMenuButton
                className="group"
                isActive={pathname === `/agents/${id}`}
                render={<Link to="/agents/$agentId" params={{ agentId: id }} />}
              >
                <div className="flex size-4 shrink-0 items-center justify-center transition-transform duration-200 group-hover:scale-110">
                  <AgentIcon agent={id} />
                </div>
                <span className="transition-colors duration-200 group-hover:text-foreground">{label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroup>
    </>
  );
}

function SettingsNav({ pathname }: { pathname: string }) {
  return (
    <SidebarGroup className="p-0">
      <SidebarMenu className="gap-1">
        <SidebarMenuItem>
          <SidebarMenuButton render={<Link to="/live" />}>
            <ArrowLeft />
            <span>Back</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        {SETTINGS_SECTIONS.map(({ id, label, icon: Icon }) => (
          <SidebarMenuItem key={id}>
            <SidebarMenuButton
              isActive={pathname === `/settings/${id}`}
              render={<Link to="/settings/$section" params={{ section: id }} />}
            >
              <Icon />
              <span>{label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}

export function AppLayout() {
  return (
    <SetupProvider>
      <AppShell />
    </SetupProvider>
  );
}

const TAB_KEYS: Record<string, "/live" | "/history" | "/grants" | "/insights" | "/mcp" | "/skills" | "/plugins"> = {
  "1": "/live",
  "2": "/history",
  "3": "/grants",
  "4": "/insights",
  "5": "/mcp",
  "6": "/skills",
  "7": "/plugins",
};

function AppShell() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [palette, setPalette] = useState(false);
  const [chrome, setChrome] = useState<{ fullScreen: boolean; topBarReveal: boolean }>(() => ({
    fullScreen: window.innerHeight >= window.screen.height - 4,
    topBarReveal: false,
  }));
  const [restart, setRestart] = useState<{ name: string; kind: "gui" | "cli"; count: number }[]>([]);
  const [path, setPath] = useState("");
  const { status } = useSetup();
  const grants = useGrantStatus();
  const info = useAppInfo();
  const onSettings = pathname.startsWith("/settings");
  const shownAgents = AGENT_NAV.filter((item) => status?.agents.some((agent) => agent.id === item.id && visibleAgent(agent)));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((open) => !open);
      } else if (event.metaKey && !event.shiftKey && !event.altKey && !event.ctrlKey && event.key in TAB_KEYS) {
        event.preventDefault();
        void navigate({ to: TAB_KEYS[event.key] });
      }
    };
    const onWindowChrome = (event: Event) => {
      const detail = (event as CustomEvent<{ fullScreen: boolean; topBarReveal: boolean }>).detail;
      if (detail) setChrome(detail);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("leash:window-chrome", onWindowChrome);
    const timer = window.setInterval(() => void window.leash.restartNeeded().then(setRestart), 2000);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("leash:window-chrome", onWindowChrome);
      window.clearInterval(timer);
    };
  }, [navigate]);
  useEffect(() => {
    if (info?.build === "dev" && pathname !== "/approval") document.title = "Agentic Leash (dev)";
  }, [info, pathname]);
  useEffect(() => {
    if (pathname === "/approval") return;
    const go = () => void window.leash.takeNav().then((to) => {
      if (to === "/grants") void navigate({ to: "/grants" });
    });
    go();
    return window.leash.onNavigate(go);
  }, [navigate, pathname]);
  if (pathname === "/approval") return <Outlet />;
  if (!status?.ready) return <SetupScreen />;
  const headerGlobalActions = onSettings ? null : (
    <div className="flex items-center gap-2.5">
      <StatusPill
        lockdown={grants.lockdown}
        restart={restart}
        onClearRestart={() => setRestart([])}
      />
      <GlobalActions
        count={grants.count}
        lockdown={grants.lockdown}
      />
    </div>
  );
  return (
    <PageHeaderGlobalActionsContext.Provider value={headerGlobalActions}>
      <SidebarProvider className="h-dvh! min-h-0!" defaultOpen>
        <Sidebar
          side="left"
          collapsible="offcanvas"
          aria-label={onSettings ? "Settings" : "Navigation"}
          resizable={{ minWidth: 232, maxWidth: 360, storageKey: "agentic-leash:sidebar-width" }}
        >
          <SidebarHeader className="gap-0 p-0">
            {/* Dynamically expands to 56px only when hovering the top edge in macOS Fullscreen; 0px otherwise. */}
            <div
              className={cn(
                "drag-region shrink-0 transition-[height] duration-150 ease-out",
                chrome.fullScreen && chrome.topBarReveal ? "h-14" : "h-0",
              )}
            />
            <div
              className={cn(
                "drag-region flex h-14 shrink-0 items-center gap-2.5 border-b border-sidebar-border pr-4 text-lg font-semibold tracking-tight text-foreground transition-[padding] duration-150",
                chrome.fullScreen ? "pl-4" : "pl-22",
              )}
            >
              <LeashMark className="h-6 w-auto shrink-0" />
              <span className="truncate">Agentic Leash</span>
            </div>
          </SidebarHeader>
          <SidebarContent>{onSettings ? <SettingsNav pathname={pathname} /> : <MainNav pathname={pathname} agents={shownAgents} />}</SidebarContent>
          {onSettings ? <UpdatePill toastsOnly /> : (
            <SidebarFooter className="border-t border-sidebar-border px-2.5 py-2.5">
              <SidebarMenu className="gap-1">
                <SidebarMenuItem className="flex items-center gap-2">
                  <SidebarMenuButton className="min-w-0 flex-1" render={<Link to="/settings/$section" params={{ section: "general" }} />}>
                    <Settings />
                    <span>Settings</span>
                  </SidebarMenuButton>
                  <UpdatePill />
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarFooter>
          )}
          <SidebarRail />
        </Sidebar>
        <SidebarInset className="min-h-0 overflow-hidden">
          <div
            className={cn(
              "drag-region shrink-0 transition-[height] duration-150 ease-out",
              chrome.fullScreen && chrome.topBarReveal ? "h-14" : "h-0",
            )}
          />
          {grants.lockdown ? <LockdownBanner /> : null}
          <HealthBanner />
          <StorageBanner />
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <Outlet />
          </div>
        </SidebarInset>
      {palette ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-24"
          onClick={() => setPalette(false)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setPalette(false);
            }
          }}
        >
          <form
            className="dropdown-glass w-[32rem] rounded-xl border border-border p-3 shadow-lg"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              const target = path.trim();
              if (target) {
                void window.leash.createGrant({ agent: "*", path: target, access: "write", ttlSeconds: 3600 }).then(
                  () => toast({ title: "Granted write access", description: `${target} · all agents · 1 hour` }),
                  (error: unknown) => toast({ title: "Couldn't grant access", description: error instanceof Error ? error.message : String(error), tone: "destructive" }),
                );
              }
              setPalette(false);
            }}
          >
            <input className="mb-2 w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm" placeholder="Grant a folder path, then press Return" value={path} onChange={(event) => setPath(event.target.value)} autoFocus />
            <div className="flex flex-col">
              <Button type="submit" variant="ghost" className="justify-start">Grant folder for 1 hour</Button>
              <Button type="button" variant="ghost" className="justify-start" onClick={() => { setPalette(false); void navigate({ to: "/grants" }); }}>Open Access</Button>
              <Button type="button" variant="ghost" className="justify-start" onClick={() => { setPalette(false); void navigate({ to: "/agents/$agentId", params: { agentId: "claude-code" } }); }}>Jump to Claude</Button>
              <ConfirmAction
                trigger={<Button type="button" variant="ghost-destructive" className="justify-start">Revoke all</Button>}
                title="Revoke all grants?"
                description="Every agent loses the folder access it has now."
                effects={REVOKE_ALL_EFFECTS}
                confirmLabel="Revoke all"
                onConfirm={() => {
                  setPalette(false);
                  void window.leash.revokeAll().then((result) => toastRevoked(result.revoked));
                }}
              />
            </div>
          </form>
        </div>
      ) : null}
      <WelcomeDialog />
      <Toaster />
    </SidebarProvider>
    </PageHeaderGlobalActionsContext.Provider>
  );
}
