import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { appMenuTemplate, trayMenuTemplate, trayTitle, type TrayStatus } from "../../src/main/menus";

const click = (item: MenuItemConstructorOptions | undefined) => item?.click?.({} as never, undefined, {} as never);

describe("appMenuTemplate", () => {
  it("binds Command+Q to hide, and has no quit role", () => {
    const hide = vi.fn();
    const items = appMenuTemplate({ hide, dev: false })[0]!.submenu as MenuItemConstructorOptions[];
    expect(items.some((i) => i.role === "quit")).toBe(false);
    const item = items.find((i) => i.accelerator === "Command+Q");
    expect(item?.id).toBe("hide-to-menu-bar");
    click(item);
    expect(hide).toHaveBeenCalledOnce();
  });

  it("adds the View menu only in development", () => {
    expect(appMenuTemplate({ hide: vi.fn(), dev: true }).some((m) => m.role === "viewMenu")).toBe(true);
    expect(appMenuTemplate({ hide: vi.fn(), dev: false }).some((m) => m.role === "viewMenu")).toBe(false);
  });
});

describe("trayMenuTemplate", () => {
  it("opens from Open and quits only from Quit", () => {
    const actions = { open: vi.fn(), quit: vi.fn(), review: vi.fn() };
    const items = trayMenuTemplate(actions);
    click(items.find((i) => i.id === "open"));
    expect(actions.open).toHaveBeenCalledOnce();
    expect(actions.quit).not.toHaveBeenCalled();
    const quit = items.find((i) => i.id === "quit");
    expect(quit?.label).toBe("Quit Agentic Leash");
    click(quit);
    expect(actions.quit).toHaveBeenCalledOnce();
  });

  it("opens the review target from the waiting line", () => {
    const actions = { open: vi.fn(), quit: vi.fn(), review: vi.fn() };
    const pending = trayMenuTemplate({ ...actions, pending: 2 }).find((item) => item.id === "pending");
    expect(pending?.enabled).toBe(true);
    expect(pending?.label).toBe("2 requests waiting");
    click(pending);
    expect(actions.review).toHaveBeenCalledOnce();
    expect(actions.open).not.toHaveBeenCalled();
  });

  it("offers End lockdown only while lockdown is on", () => {
    const actions = { open: vi.fn(), quit: vi.fn(), review: vi.fn(), unlock: vi.fn() };
    expect(trayMenuTemplate({ ...actions, lockdown: false }).some((item) => item.id === "end-lockdown")).toBe(false);
    const items = trayMenuTemplate({ ...actions, lockdown: true });
    expect(items.find((item) => item.id === "lockdown")?.enabled).toBe(false);
    click(items.find((item) => item.id === "end-lockdown"));
    expect(actions.unlock).toHaveBeenCalledOnce();
    expect(items.some((item) => item.id === "revoke-all")).toBe(true);
  });
});

describe("tray status", () => {
  const now = 1_000_000_000;
  const status: TrayStatus = {
    grants: [
      { id: 1, agent: "claude-code", label: "/Users/me/agentic-leash", expiresAt: now + 22 * 60_000, session: true },
      { id: 2, agent: "claude-code", label: "/Users/me/work/api", expiresAt: null, session: false },
      { id: 3, agent: "cursor", label: "/tmp/x", expiresAt: now + 90 * 60_000, session: false },
    ],
    alert: { agent: "claude-code", path: "/Users/me/.ssh/config", verb: "read", ts: now - 4 * 60_000 },
    today: { prompts: 6, auto: 212, blocked: 1 },
  };
  const actions = { open: vi.fn(), quit: vi.fn(), review: vi.fn() };

  it("lists each agent's grants with time left, and ends one grant or an agent's temporary access", () => {
    const endGrant = vi.fn();
    const endTemporary = vi.fn();
    const items = trayMenuTemplate({ ...actions, status, now, endGrant, endTemporary });
    const claude = items.find((item) => item.id === "agent-claude-code");
    expect(claude?.label).toBe("Claude Code · 2 active grants");
    const sub = claude?.submenu as MenuItemConstructorOptions[];
    expect(sub.map((item) => item.label).filter(Boolean)).toEqual(["End ~/agentic-leash (this session, 22 min until idle)", "End ~/work/api (always)", "End temporary access for Claude Code"]);
    click(sub[0]);
    expect(endGrant).toHaveBeenCalledWith(1);
    click(sub.find((item) => item.id === "end-agent-claude-code"));
    expect(endTemporary).toHaveBeenCalledWith("claude-code");
    expect((items.find((item) => item.id === "agent-cursor")?.submenu as MenuItemConstructorOptions[])[0]?.label).toBe("End /tmp/x (1 h 30 min left)");
  });

  it("shows the latest alert and today's counts, and ends all temporary access", () => {
    const endTemporary = vi.fn();
    const openRoute = vi.fn();
    const items = trayMenuTemplate({ ...actions, status, now, endTemporary, openRoute });
    expect(items.find((item) => item.id === "alert")?.label).toBe("⚠ Claude Code read ~/.ssh/config · 4 min ago");
    click(items.find((item) => item.id === "alert"));
    expect(openRoute).toHaveBeenCalledWith("/history");
    expect(items.find((item) => item.id === "today")?.label).toBe("Today: 6 prompts · 212 allowed · 1 blocked");
    click(items.find((item) => item.id === "end-temporary"));
    expect(endTemporary).toHaveBeenCalledWith();
    click(items.find((item) => item.id === "insights"));
    expect(openRoute).toHaveBeenCalledWith("/insights");
  });

  it("disables ending temporary access when only Always grants are live", () => {
    const items = trayMenuTemplate({ ...actions, now, status: { ...status, grants: [status.grants[1]!] } });
    expect(items.find((item) => item.id === "end-temporary")?.enabled).toBe(false);
    expect(trayMenuTemplate({ ...actions, now, status: { ...status, grants: [] } }).find((item) => item.id === "no-grants")?.label).toBe("No active grants");
  });

  it("puts lockdown, an alert and the waiting count beside the icon", () => {
    expect(trayTitle({ lockdown: false, pending: 0, alert: false })).toBe("");
    expect(trayTitle({ lockdown: false, pending: 2, alert: false })).toBe("2");
    expect(trayTitle({ lockdown: true, pending: 2, alert: true })).toBe("🔒 ⚠ 2");
  });

  it("includes the update menu item when an update is available or downloaded", () => {
    const onUpdate = vi.fn();
    const items = trayMenuTemplate({
      open: vi.fn(),
      quit: vi.fn(),
      review: vi.fn(),
      update: { label: "Restart to update to v0.4.0", click: onUpdate },
    });
    const updateItem = items.find((item) => item.id === "update");
    expect(updateItem?.label).toBe("Restart to update to v0.4.0");
    click(updateItem);
    expect(onUpdate).toHaveBeenCalledOnce();
  });
});
