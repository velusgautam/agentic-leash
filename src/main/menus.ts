import type { MenuItemConstructorOptions } from "electron";
import { agentLabel } from "../shared/pendingNotice";

export function appMenuTemplate({ hide, dev }: { hide: () => void; dev: boolean }): MenuItemConstructorOptions[] {
  return [
    {
      label: "Agentic Leash",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { id: "hide-to-menu-bar", label: "Hide to Menu Bar", accelerator: "Command+Q", click: hide },
      ],
    },
    { role: "editMenu" },
    ...(dev ? [{ role: "viewMenu" } as const] : []),
    { role: "windowMenu" },
  ];
}

export interface TrayGrant {
  id: number;
  agent: string;
  label: string;
  expiresAt: number | null;
  session: boolean;
}

export interface TrayStatus {
  grants: TrayGrant[];
  /** The latest secret or startup-file touch, if any. */
  alert: { agent: string; path: string; verb: string; ts: number } | null;
  today: { prompts: number; auto: number; blocked: number };
}

const tilde = (path: string) => path.replace(/^\/(Users|home)\/[^/]+/, "~");

/**
 * Shortens long file paths for display in menus using a middle ellipsis (…),
 * keeping the start (e.g. ~ or root) and the file/leaf name whenever possible.
 */
export function shortenPath(path: string, maxLen = 36): string {
  if (path.length <= maxLen) return path;

  const parts = path.split("/");
  const isAbs = path.startsWith("/");
  const minParts = isAbs ? 4 : 3;

  if (parts.length >= minParts) {
    let startIdx = isAbs ? 2 : 1;
    let endIdx = parts.length - 1;

    const start = parts.slice(0, startIdx).join("/");
    const end = parts.slice(endIdx).join("/");
    const baseCandidate = `${start}/…/${end}`;

    if (baseCandidate.length <= maxLen) {
      let best = baseCandidate;
      while (endIdx - startIdx > 1) {
        // Prefer expanding towards the leaf (closer to the filename)
        const nextEnd = parts.slice(endIdx - 1).join("/");
        const candidateEnd = `${parts.slice(0, startIdx).join("/")}/…/${nextEnd}`;
        if (candidateEnd.length <= maxLen) {
          endIdx--;
          best = candidateEnd;
          continue;
        }

        // Try expanding the root/prefix
        const nextStart = parts.slice(0, startIdx + 1).join("/");
        const candidateStart = `${nextStart}/…/${parts.slice(endIdx).join("/")}`;
        if (candidateStart.length <= maxLen) {
          startIdx++;
          best = candidateStart;
          continue;
        }

        break;
      }
      return best;
    }
  }

  // Fallback for paths with few segments or where leaf alone exceeds maxLen:
  const head = Math.ceil((maxLen - 1) / 2);
  const tail = Math.floor((maxLen - 1) / 2);
  return `${path.slice(0, head)}…${path.slice(-tail)}`;
}

function ago(ts: number, now: number): string {
  const minutes = Math.round((now - ts) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

function left(grant: TrayGrant, now: number): string {
  if (grant.expiresAt === null) return "always";
  const minutes = Math.max(1, Math.round((grant.expiresAt - now) / 60_000));
  const time = minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
  return grant.session ? `this session, ${time} until idle` : `${time} left`;
}

/** Text beside the menu-bar icon: lockdown, a recent secret touch, and how many requests wait. */
export function trayTitle({ lockdown, pending, alert }: { lockdown: boolean; pending: number; alert: boolean }): string {
  return [lockdown ? "🔒" : "", alert ? "⚠" : "", pending ? String(pending) : ""].filter(Boolean).join(" ");
}

export function trayMenuTemplate({
  open,
  quit,
  pending = 0,
  revokeAll,
  review,
  lockdown = false,
  unlock,
  status,
  now = Date.now(),
  endGrant,
  endTemporary,
  openRoute,
  update,
}: {
  open: () => void;
  quit: () => void;
  pending?: number;
  revokeAll?: () => void;
  review: () => void;
  lockdown?: boolean;
  unlock?: () => void;
  status?: TrayStatus;
  now?: number;
  endGrant?: (id: number) => void;
  /** Ends timed and session grants, for one agent or all. Always and Always in repo stay. */
  endTemporary?: (agent?: string) => void;
  openRoute?: (route: string) => void;
  update?: { label: string; click: () => void } | null;
}): MenuItemConstructorOptions[] {
  const agents = [...new Set(status?.grants.map((grant) => grant.agent) ?? [])];
  const temporary = status?.grants.filter((grant) => grant.expiresAt !== null).length ?? 0;
  const grantItems: MenuItemConstructorOptions[] = agents.map((agent) => {
    const grants = status!.grants.filter((grant) => grant.agent === agent);
    const timed = grants.filter((grant) => grant.expiresAt !== null).length;
    return {
      id: `agent-${agent}`,
      label: `${agentLabel(agent)} · ${grants.length} active ${grants.length === 1 ? "grant" : "grants"}`,
      submenu: [
        ...grants.map((grant): MenuItemConstructorOptions => ({
          id: `grant-${grant.id}`,
          label: `End ${shortenPath(tilde(grant.label))} (${left(grant, now)})`,
          toolTip: `End ${tilde(grant.label)} (${left(grant, now)})`,
          click: () => endGrant?.(grant.id),
        })),
        { type: "separator" },
        { id: `end-agent-${agent}`, label: `End temporary access for ${agentLabel(agent)}`, enabled: timed > 0, click: () => endTemporary?.(agent) },
      ],
    };
  });
  const alert = status?.alert;
  const today = status?.today;
  return [
    ...(lockdown ? [{ id: "lockdown", label: "Lockdown is on", enabled: false }, { id: "end-lockdown", label: "End lockdown", click: unlock }, { type: "separator" } as const] : []),
    { id: "pending", label: pending ? `${pending} ${pending === 1 ? "request" : "requests"} waiting` : "No requests waiting", enabled: pending > 0, click: review },
    ...(status
      ? [
          { type: "separator" } as const,
          ...(grantItems.length ? grantItems : [{ id: "no-grants", label: "No active grants", enabled: false }]),
          { type: "separator" } as const,
          ...(alert
            ? [
                {
                  id: "alert",
                  label: `⚠ ${agentLabel(alert.agent)} ${alert.verb} ${shortenPath(tilde(alert.path))} · ${ago(alert.ts, now)}`,
                  toolTip: `${agentLabel(alert.agent)} ${alert.verb} ${tilde(alert.path)} · ${ago(alert.ts, now)}`,
                  click: () => openRoute?.("/history"),
                },
              ]
            : []),
          ...(today ? [{ id: "today", label: `Today: ${today.prompts} prompts · ${today.auto} allowed · ${today.blocked} blocked`, enabled: false }] : []),
          { type: "separator" } as const,
          { id: "end-temporary", label: "End all temporary access", toolTip: "Keeps Always and Always in repo", enabled: temporary > 0, click: () => endTemporary?.() },
        ]
      : []),
    { id: "revoke-all", label: "Lockdown (revoke everything)", click: revokeAll },
    { type: "separator" },
    ...(update ? [{ id: "update", label: update.label, click: update.click }] : []),
    { id: "open", label: "Open Agentic Leash", click: open },
    { type: "separator" },
    { id: "quit", label: "Quit Agentic Leash", click: quit },
  ];
}
