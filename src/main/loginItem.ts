import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// LaunchAgent, not app.setLoginItemSettings: login items silently fail for non-notarized apps.
export const LOGIN_AGENT_LABEL = "com.agenticleash.app";

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function loginAgentPath(home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${LOGIN_AGENT_LABEL}.plist`);
}

export function loginAgentPlist(appBundlePath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LOGIN_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-g</string>
    <string>-a</string>
    <string>${escapeXml(appBundlePath)}</string>
    <string>--args</string>
    <string>--hidden</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict>
</plist>
`;
}

/* ---------------- Linux XDG autostart support ---------------- */

export function linuxDesktopEntry(appPath: string): string {
  return `[Desktop Entry]
Type=Application
Name=Agentic Leash
Exec=${appPath} --hidden
Terminal=false
Categories=Utility;
X-GNOME-Autostart-enabled=true
`;
}

export function linuxAutostartPath(home = homedir()): string {
  return join(home, ".config", "autostart", "agentic-leash.desktop");
}

/* ---------------- Windows startup support ---------------- */

export function windowsStartupScript(appPath: string): string {
  return `@echo off\nstart "" "${appPath}" --hidden\n`;
}

export function windowsStartupPath(home = homedir()): string {
  const base = home.replace(/\//g, "\\");
  return `${base}\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\agentic-leash.cmd`;
}

/* ---------------- Cross-platform autostart management ---------------- */

export function autostartPathForPlatform(home = homedir(), platform = process.platform): string {
  if (platform === "linux") return linuxAutostartPath(home);
  if (platform === "win32") return windowsStartupPath(home);
  return loginAgentPath(home);
}

export function isOpenAtLogin(home?: string, platform = process.platform): boolean {
  return existsSync(autostartPathForPlatform(home, platform));
}

export function setOpenAtLogin(enabled: boolean, appPath: string, home?: string, platform = process.platform): void {
  const path = autostartPathForPlatform(home, platform);
  if (!enabled) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  if (platform === "linux") {
    writeFileSync(path, linuxDesktopEntry(appPath));
  } else if (platform === "win32") {
    writeFileSync(path, windowsStartupScript(appPath));
  } else {
    writeFileSync(path, loginAgentPlist(appPath));
  }
}
