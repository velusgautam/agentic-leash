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

export function isOpenAtLogin(home?: string): boolean {
  return existsSync(loginAgentPath(home));
}

export function setOpenAtLogin(enabled: boolean, appPath: string, home?: string): void {
  const path = loginAgentPath(home);
  if (!enabled) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, loginAgentPlist(appPath));
}
