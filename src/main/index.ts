import { join, resolve } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, nativeImage, nativeTheme, powerMonitor, shell, Tray } from "electron";
import { windowVibrancy } from "../shared/windowGlass";
import appIcon from "../../resources/icon.png?asset";
import trayIcon from "../../resources/trayTemplate.png?asset";
import type { OpenAtLoginState } from "../shared/bridge";
import { buildKind } from "../shared/appInfo";
import type { AppInfo } from "../shared/types";
import { isOpenAtLogin, setOpenAtLogin } from "./loginItem";
import { appMenuTemplate, trayMenuTemplate, trayTitle, type TrayStatus } from "./menus";
import { pendingNotice } from "../shared/pendingNotice";
import { allowText } from "../shared/presets";
import { resolveUpdateButtonAction } from "../shared/updater";
import { startRuntime } from "./runtime";
import { readUiState, writeUiState } from "./uiState";
import { startUpdater, type UpdaterController } from "./updater";

const isMac = process.platform === "darwin";

if (process.env.AGENTIC_LEASH_USER_DATA) app.setPath("userData", process.env.AGENTIC_LEASH_USER_DATA);

let win: BrowserWindow | null = null;
// Default matches glass 80. Hide clears vibrancy; show puts this back.
let glassVibrancy: "sidebar" | null = "sidebar";
let approval: BrowserWindow | null = null;
// Module scope on purpose: a garbage-collected Tray vanishes from the menu bar.
let tray: Tray | null = null;
let quitting = false;
let pendingCount = 0;
let pendingNav: string | null = null;
let lockdown = false;
// Module scope on purpose: a garbage-collected Notification never fires its action events.
const pendingNotes = new Map<string, Notification>();
let revokeAll = (): { revoked: number } => ({ revoked: 0 });
let onLock = (): void => undefined;
let unlock = (): void => undefined;
let trayStatus = (): TrayStatus | undefined => undefined;
let endGrant = (_id: number): void => undefined;
let endTemporary = (_agent?: string): void => undefined;
let updater: UpdaterController | null = null;
// The menu-bar title shows ⚠ for a while after a secret or startup file is touched.
const ALERT_BADGE_MS = 2 * 60 * 1000;
let alertUntil = 0;

function createWindow(visible: boolean): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 840,
    minHeight: 620,
    show: false,
    title: "Agentic Leash",
    ...(isMac
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 16, y: 19 },
          transparent: true,
          vibrancy: "sidebar" as const,
          visualEffectState: "active" as const,
          backgroundColor: "#00000000",
        }
      : { backgroundColor: nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff" }),
    webPreferences: { preload: join(__dirname, "../preload/index.js"), sandbox: true, contextIsolation: true },
  });
  if (visible) window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  loadRenderer(window);
  return window;
}

function loadRenderer(window: BrowserWindow, hash = ""): void {
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}${hash}`);
  else void window.loadFile(join(__dirname, "../renderer/index.html"), hash ? { hash: hash.slice(1) } : undefined);
}

function refreshTray(): void {
  if (!tray) return;
  const alert = Date.now() < alertUntil;
  tray.setTitle(trayTitle({ lockdown, pending: pendingCount, alert }));
  tray.setToolTip(lockdown ? "Agentic Leash — lockdown on" : alert ? "Agentic Leash — a secret or startup file was just touched" : "Agentic Leash");
}

// Built when opened, so grant times and today's counts are current.
function trayMenu(): Menu {
  const updateState = updater?.getState() ?? null;
  const updateAction = updateState ? resolveUpdateButtonAction(updateState) : "none";
  const updateItem =
    updateAction === "install" && updateState?.downloadedVersion
      ? {
          label: `Restart to update to v${updateState.downloadedVersion}`,
          click: () => void updater?.install(),
        }
      : updateAction === "download" && updateState?.availableVersion
        ? {
            label: `Update available (v${updateState.availableVersion})…`,
            click: () => {
              showWindow();
              void updater?.download();
            },
          }
        : null;
  return Menu.buildFromTemplate(
    trayMenuTemplate({
      open: showWindow,
      quit: () => app.quit(),
      pending: pendingCount,
      review: pendingCount ? openApproval : showGrants,
      revokeAll: () => void confirmRevokeAll(),
      lockdown,
      unlock,
      status: trayStatus(),
      endGrant,
      endTemporary,
      openRoute: showRoute,
      update: updateItem,
    }),
  );
}

async function confirmRevokeAll(): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: "warning",
    message: "Revoke all grants?",
    detail: "Unmarks Claude's trusted folders (a .bak is written first), removes Cursor allow rules, deletes Agentic Leash grants, and turns lockdown on until you end it on the Grants page.",
    buttons: ["Revoke all", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  });
  if (response === 0) revokeAll();
}

// app.hide() is how macOS hands focus back to the app that was frontmost before the popup.
let returnFocus = false;
let presentingApproval = false;

function closeApproval(): void {
  if (approval && !approval.isDestroyed()) approval.hide();
  if (isMac && returnFocus) app.hide();
  presentingApproval = false;
  returnFocus = false;
}

const APPROVAL_WIDTH = 520;

// A new window in a fullscreen app gets its own Space unless it is an auxiliary panel.
function presentApproval(window: BrowserWindow): void {
  presentingApproval = true;
  if (!BrowserWindow.getFocusedWindow()) returnFocus = true;
  if (window.isFullScreen()) window.setFullScreen(false);
  window.setFullScreenable(false);
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.setAlwaysOnTop(true, "floating");
  app.focus({ steal: true });
  window.show();
  window.focus();
  if (!win?.isVisible()) {
    app.dock?.hide();
    setImmediate(() => {
      if (presentingApproval && !win?.isVisible()) app.dock?.hide();
    });
  }
}

function openApproval(): void {
  if (approval && !approval.isDestroyed()) {
    presentApproval(approval);
    return;
  }
  const bounds = tray?.getBounds() ?? { x: 0, y: 0, width: 0, height: 0 };
  approval = new BrowserWindow({
    width: APPROVAL_WIDTH,
    height: 410,
    // Windows/Linux trays sit at the bottom, so anchoring below would go off-screen; let Electron center it.
    ...(isMac ? { x: Math.round(bounds.x + bounds.width / 2 - APPROVAL_WIDTH / 2), y: bounds.y + bounds.height + 4 } : {}),
    frame: false,
    fullscreenable: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff",
    webPreferences: { preload: join(__dirname, "../preload/index.js"), sandbox: true, contextIsolation: true },
  });
  loadRenderer(approval, "#/approval");
  presentApproval(approval);
  approval.on("closed", () => {
    approval = null;
    presentingApproval = false;
  });
}

function showWindow(): void {
  if (!win) return;
  void app.dock?.show();
  if (isMac) win.setVibrancy(glassVibrancy);
  win.show();
  win.focus();
}

function showRoute(route: string): void {
  showWindow();
  pendingNav = route;
  if (!win || win.isDestroyed()) return;
  const send = () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send("nav:open");
  };
  if (win.webContents.isLoading()) win.webContents.once("did-finish-load", send);
  else send();
}

function showGrants(): void {
  showRoute("/grants");
}

function hideToMenuBar(): void {
  if (!win) return;
  // Hiding a vibrancy window never returns on the GitHub macOS runner.
  if (isMac) win.setVibrancy(null);
  win.hide();
  app.dock?.hide();
  const dir = app.getPath("userData");
  const state = readUiState(dir);
  if (state.hideNoticeShown) return;
  new Notification({
    title: "Agentic Leash is still running",
    body: "It stays in the menu bar. Quit from the menu bar icon.",
  }).show();
  writeUiState(dir, { ...state, hideNoticeShown: true });
}

// <bundle>.app/Contents/MacOS/<exe> → <bundle>.app
const appBundlePath = () => resolve(process.execPath, "../../..");

// Electron has no login-item API on Linux.
const loginItemSupported = () => app.isPackaged && process.platform !== "linux";
const openAtLogin = () => (isMac ? isOpenAtLogin() : app.getLoginItemSettings().openAtLogin);
const applyOpenAtLogin = (enabled: boolean) => (isMac ? setOpenAtLogin(enabled, appBundlePath()) : app.setLoginItemSettings({ openAtLogin: enabled, args: ["--hidden"] }));

function loginItemState(): OpenAtLoginState {
  return { available: loginItemSupported(), enabled: loginItemSupported() && openAtLogin() };
}

function applyWindowGlass(glass: number): void {
  if (!win || win.isDestroyed() || !isMac || !Number.isFinite(glass)) return;
  glassVibrancy = windowVibrancy(glass);
  win.setBackgroundColor(glassVibrancy ? "#00000000" : nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff");
  win.setVibrancy(glassVibrancy);
}

ipcMain.handle("appearance:glass", (_event, glass: number) => applyWindowGlass(glass));

ipcMain.handle("shell:open-external", async (_event, url: string) => {
  if (typeof url === "string" && /^https:\/\//i.test(url)) {
    await shell.openExternal(url);
  }
});

ipcMain.handle("nav:take", () => {
  const next = pendingNav;
  pendingNav = null;
  return next;
});

ipcMain.handle(
  "app:info",
  (): AppInfo => ({
    version: app.getVersion(),
    build: buildKind(app.isPackaged, process.env.ELECTRON_RENDERER_URL),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
  }),
);

function registerLoginItem(): void {
  ipcMain.handle("login-item:get", () => loginItemState());
  ipcMain.handle("login-item:set", (_event, enabled: boolean) => {
    if (loginItemSupported()) applyOpenAtLogin(enabled);
    return loginItemState();
  });
  const dir = app.getPath("userData");
  const state = readUiState(dir);
  if (loginItemSupported() && !state.loginItemConfigured) {
    applyOpenAtLogin(true);
    writeUiState(dir, { ...state, loginItemConfigured: true });
  }
}

// Cmd+Q is a native terminate, so the Hide menu accelerator never sees it.
// JS app.quit() (tray Quit, tests) sets the flag first. Dock Quit is the same event as Cmd+Q.
const nativeQuit = app.quit.bind(app);
app.quit = () => {
  quitting = true;
  nativeQuit();
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("activate", () => {
    if (presentingApproval || (approval && !approval.isDestroyed() && approval.isVisible())) return;
    showWindow();
  });
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    hideToMenuBar();
  });

  void app.whenReady().then(() => {
    // Locking or sleeping ends temporary access, per Settings.
    powerMonitor.on("lock-screen", () => onLock());
    powerMonitor.on("suspend", () => onLock());
    powerMonitor.on("shutdown", () => {
      quitting = true;
    });
    registerLoginItem();
    if (!app.isPackaged) app.dock?.setIcon(appIcon);
    tray = new Tray(isMac ? trayIcon : nativeImage.createFromPath(appIcon).resize({ width: 16, height: 16 }));
    tray.setToolTip("Agentic Leash");
    // macOS opens the menu on click; Windows and Linux open the window and keep the menu on right-click.
    tray.on("click", () => (isMac ? tray?.popUpContextMenu(trayMenu()) : showWindow()));
    tray.on("right-click", () => tray?.popUpContextMenu(trayMenu()));
    ({ revokeAll, unlock, onLock, trayStatus, endGrant, endTemporary } = startRuntime({
      userData: app.getPath("userData"),
      openApproval,
      closeApproval,
      setPending: (count) => {
        pendingCount = count;
        refreshTray();
      },
      onAlert: () => {
        alertUntil = Date.now() + ALERT_BADGE_MS;
        refreshTray();
        setTimeout(refreshTray, ALERT_BADGE_MS + 100);
      },
      onStatus: (status) => {
        lockdown = status.lockdown;
        refreshTray();
      },
      notifyPending: (item, decide) => {
        const allowLabel = allowText(item.policy?.preset ?? "once", item.policy?.repo ?? null);
        const note = new Notification({ ...pendingNotice(item), actions: [{ type: "button", text: allowLabel }, { type: "button", text: "Deny" }] });
        pendingNotes.set(item.id, note);
        note.on("action", (_event, index) => decide(index === 0 ? "allow" : "deny"));
        note.on("click", openApproval);
        note.show();
        return () => {
          pendingNotes.delete(item.id);
          note.close();
        };
      },
      notify: (title, body) => new Notification({ title, body }).show(),
      disableLoginItem: () => {
        if (loginItemSupported()) applyOpenAtLogin(false);
      },
      finishUninstall: () => {
        quitting = true;
        const done = () => app.quit();
        if (app.isPackaged && isMac) void shell.trashItem(appBundlePath()).catch(() => undefined).finally(done);
        else done();
      },
    }));
    const hidden = process.argv.includes("--hidden");
    win = createWindow(!hidden);
    win.on("close", (event) => {
      if (quitting) return;
      event.preventDefault();
      hideToMenuBar();
    });
    if (hidden) app.dock?.hide();
    updater = startUpdater({
      currentVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      broadcast: (channel, payload) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.webContents.isDestroyed()) window.webContents.send(channel, payload);
        }
      },
      prepareQuit: () => {
        quitting = true;
      },
      notifyAvailable: (version) => {
        if (!win?.isVisible()) {
          const note = new Notification({
            title: "Agentic Leash update available",
            body: `Version ${version} is ready to download.`,
          });
          note.on("click", showWindow);
          note.show();
        }
      },
    });
    ipcMain.handle("update:get", () => updater!.getState());
    ipcMain.handle("update:check", () => updater!.check());
    ipcMain.handle("update:download", () => updater!.download());
    ipcMain.handle("update:install", () => updater!.install());
    Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate({ hide: hideToMenuBar, dev: !app.isPackaged })));
    refreshTray();
  });
}
