import { useEffect, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Database, Lock, RotateCw, Settings, ShieldOff, X } from "lucide-react";
import { ConfirmAction, REVOKE_ALL_EFFECTS } from "~/components/ConfirmAction";
import { AgentIcon, LeashMark } from "~/components/Icons";
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
import { needsAgentBanner, visibleAgent } from "../../../shared/setup";
import { WelcomeDialog } from "~/components/WelcomeDialog";
import { formatCap, type StorageWarning } from "../../../shared/storage";
import { useLeashData } from "~/hooks/useLeash";
import { SetupScreen } from "~/components/SetupScreen";
import { UpdatePill } from "~/components/UpdatePill";
import { useGrantStatus } from "~/components/useGrantStatus";
import { SetupProvider, useSetup } from "~/components/useSetup";
import { AGENT_NAV, MAIN_NAV, SETTINGS_SECTIONS } from "~/nav";

function RevokeAll({ count }: { count: number }) {
  return (
    <ConfirmAction
      trigger={
        <Button size="sm" variant="outline" className="border-destructive/30 text-destructive hover:bg-destructive/10 disabled:opacity-40" disabled={count === 0}>
          <ShieldOff />
          {count === 0 ? "Nothing to revoke" : `Revoke all (${count})`}
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

function LockdownBanner() {
  return (
    <div role="status" className="mx-5 mb-2 flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/10 py-1.5 pr-1.5 pl-3 text-sm">
      <Lock className="size-4 shrink-0 text-destructive" aria-hidden />
      <span className="min-w-0 flex-1">Lockdown is on. Every agent tool call is blocked.</span>
      <Button size="sm" variant="outline" onClick={() => void window.leash.unlock()}>End lockdown</Button>
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
      <SidebarGroup className="pt-3 pb-2">
        <SidebarMenu className="gap-1.5">
          {MAIN_NAV.map(({ to, label, icon: Icon }) => (
            <SidebarMenuItem key={to}>
              <SidebarMenuButton className="h-9" isActive={pathname === to} render={<Link to={to} />}>
                <Icon />
                {label}
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroup>
      <div className="mx-3 border-t border-sidebar-border" role="separator" />
      <SidebarGroup className="pt-3 pb-2">
        <div className="px-2.5 pt-1 pb-2 text-[11px] font-medium tracking-wide text-muted-foreground">Agents</div>
        <SidebarMenu className="gap-1.5">
          {agents.map(({ id, label }) => (
            <SidebarMenuItem key={id}>
              <SidebarMenuButton
                className="h-9"
                isActive={pathname === `/agents/${id}`}
                render={<Link to="/agents/$agentId" params={{ agentId: id }} />}
              >
                <AgentIcon agent={id} />
                {label}
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
    <SidebarGroup className="pt-3">
      <SidebarMenu className="gap-1.5">
        <SidebarMenuItem>
            <SidebarMenuButton className="h-9" render={<Link to="/live" />}>
            <ArrowLeft />
            Back
          </SidebarMenuButton>
        </SidebarMenuItem>
        {SETTINGS_SECTIONS.map(({ id, label, icon: Icon }) => (
          <SidebarMenuItem key={id}>
            <SidebarMenuButton
              className="h-9"
              isActive={pathname === `/settings/${id}`}
              render={<Link to="/settings/$section" params={{ section: id }} />}
            >
              <Icon />
              {label}
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

const TAB_KEYS: Record<string, "/live" | "/grants" | "/history"> = { "1": "/live", "2": "/grants", "3": "/history" };

function AppShell() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [palette, setPalette] = useState(false);
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
    window.addEventListener("keydown", onKey);
    const timer = window.setInterval(() => void window.leash.restartNeeded().then(setRestart), 2000);
    return () => {
      window.removeEventListener("keydown", onKey);
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
  return (
    <SidebarProvider className="h-dvh! min-h-0!" defaultOpen>
      <Sidebar
        side="left"
        collapsible="offcanvas"
        aria-label={onSettings ? "Settings" : "Navigation"}
        resizable={{ minWidth: 232, maxWidth: 360, storageKey: "agentic-leash:sidebar-width" }}
      >
        <SidebarHeader className="gap-0 p-0">
          {/* Traffic lights sit in this strip and hide in fullscreen, so the brand stays left. */}
          <div className="drag-region h-13 shrink-0" />
          <div className="drag-region flex items-center gap-3 border-b border-sidebar-border px-[calc(var(--sidebar-content-inset)+var(--sidebar-row-content-inset))] py-3 text-base font-semibold tracking-tight">
            <LeashMark className="h-7 w-auto shrink-0" />
            <span className="truncate">Agentic Leash</span>
          </div>
        </SidebarHeader>
        <SidebarContent>{onSettings ? <SettingsNav pathname={pathname} /> : <MainNav pathname={pathname} agents={shownAgents} />}</SidebarContent>
        {onSettings ? <UpdatePill toastsOnly /> : (
          <SidebarFooter className="border-t border-sidebar-border pt-2">
            <SidebarMenu className="gap-1.5">
              <SidebarMenuItem className="flex items-center gap-2">
                <SidebarMenuButton className="h-9 min-w-0 flex-1" render={<Link to="/settings/$section" params={{ section: "general" }} />}>
                  <Settings />
                  Settings
                </SidebarMenuButton>
                <UpdatePill />
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        )}
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="min-h-0 overflow-hidden">
        <div className="drag-region flex h-13 shrink-0 items-center justify-end gap-3 px-5">{onSettings || pathname === "/grants" ? null : <RevokeAll count={grants.count} />}</div>
        {status && needsAgentBanner(status.agents) ? (
          <div role="status" className="mx-5 mb-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
            Install Claude, Cursor, Codex, Gemini, or Hermes to start tracking.
          </div>
        ) : null}
        {grants.lockdown ? <LockdownBanner /> : null}
        {restart.length ? (
          <div role="status" className="mx-5 mb-2 flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 py-1.5 pr-1.5 pl-3 text-sm">
            <RotateCw className="size-4 shrink-0 text-amber-500" aria-hidden />
            <span className="min-w-0 flex-1">
              {restart.map((item) => item.name).join(", ")} {restart.length === 1 ? "is" : "are"} running with the old settings. Restart to pick up your change.
            </span>
            <ConfirmAction
              trigger={<Button size="sm" variant="outline">Restart</Button>}
              title="Restart these agents?"
              description="Unsaved work in them may be lost."
              effects={restart.map((item) =>
                item.kind === "gui"
                  ? `Quits ${item.name}. Open it again yourself.`
                  : `Stops ${item.count} ${item.name} ${item.count === 1 ? "session" : "sessions"}. Start ${item.count === 1 ? "it" : "them"} again in the terminal${item.name === "Claude" ? " (claude --continue resumes)" : ""}.`,
              )}
              confirmLabel="Restart"
              onConfirm={() => void window.leash.restartAgents().then(() => setRestart([]))}
            />
            <Button size="icon-sm" variant="ghost" aria-label="Dismiss" onClick={() => void window.leash.dismissRestart().then(() => setRestart([]))}>
              <X />
            </Button>
          </div>
        ) : null}
        <StorageBanner />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <Outlet />
        </div>
      </SidebarInset>
      {palette ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-24" onClick={() => setPalette(false)}>
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
  );
}
