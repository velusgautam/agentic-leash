import { describe, expect, it } from "vitest";
import {
  parseWindowsProcessList,
  restartTargets,
  formatGracefulQuitCommand,
} from "../../src/main/system";
import { desktopAppPresent } from "../../src/shared/setup";
import { uninstallLeftoversForPlatform } from "../../src/main/uninstall";

describe("Cross-Platform Process Discovery & Graceful Quitting", () => {
  it("parses Windows process CSV output into PsRows", () => {
    const csv = `Node,CommandLine,ParentProcessId,ProcessId
DESKTOP,"C:\\Users\\Bob\\AppData\\Local\\Programs\\cursor\\Cursor.exe" --type=renderer,1000,2000
DESKTOP,"C:\\Users\\Bob\\AppData\\Local\\Programs\\cursor\\Cursor.exe",500,1000
DESKTOP,"C:\\Program Files\\Claude\\Claude.exe",500,3000
DESKTOP,node.exe C:\\Users\\Bob\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js,1000,4000
`;
    const rows = parseWindowsProcessList(csv);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({
      pid: 2000,
      ppid: 1000,
      args: '"C:\\Users\\Bob\\AppData\\Local\\Programs\\cursor\\Cursor.exe" --type=renderer',
    });
    expect(rows[1]).toEqual({
      pid: 1000,
      ppid: 500,
      args: '"C:\\Users\\Bob\\AppData\\Local\\Programs\\cursor\\Cursor.exe"',
    });
  });

  it("detects GUI restart targets across macOS, Linux, and Windows executables", () => {
    const mixedRows = [
      // macOS
      { pid: 10, ppid: 1, args: "/Applications/Cursor.app/Contents/MacOS/Cursor" },
      // Linux
      { pid: 20, ppid: 1, args: "/opt/Cursor/cursor --no-sandbox" },
      { pid: 21, ppid: 1, args: "/usr/bin/claude" },
      // Windows
      { pid: 30, ppid: 1, args: "C:\\Users\\Bob\\AppData\\Local\\Programs\\cursor\\Cursor.exe" },
      { pid: 31, ppid: 1, args: "C:\\Program Files\\Claude\\Claude.exe" },
      { pid: 32, ppid: 1, args: "C:\\Users\\Bob\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe" },
    ];

    const targets = restartTargets(mixedRows);
    const targetAgents = targets.map((t) => `${t.agent}:${t.kind}:${t.pid}`);
    expect(targetAgents).toContain("cursor:gui:10");
    expect(targetAgents).toContain("cursor:gui:20");
    expect(targetAgents).toContain("claude-code:cli:21");
    expect(targetAgents).toContain("cursor:gui:30");
    expect(targetAgents).toContain("claude-code:gui:31");
    expect(targetAgents).toContain("antigravity:gui:32");
  });

  it("generates platform-specific graceful termination commands", () => {
    // macOS uses AppleScript
    const macCmd = formatGracefulQuitCommand(1234, "com.todesktop.230313mzl4w4u92", "darwin");
    expect(macCmd).toContain("tell application id");
    expect(macCmd).toContain("com.todesktop.230313mzl4w4u92");

    // Windows uses taskkill (without /F for graceful WM_CLOSE)
    const winCmd = formatGracefulQuitCommand(1234, undefined, "win32");
    expect(winCmd).toBe("taskkill /PID 1234");

    // Linux uses SIGTERM for graceful exit
    const linuxCmd = formatGracefulQuitCommand(1234, undefined, "linux");
    expect(linuxCmd).toBe("kill -TERM 1234");
  });
});

describe("Cross-Platform Desktop Agent Installation Discovery", () => {
  it("detects apps in macOS standard folders", () => {
    const mockFs = new Set(["/Applications/Cursor.app", "/Users/alice/Applications/Claude.app"]);
    expect(desktopAppPresent("Cursor", "/Users/alice", (p) => mockFs.has(p), "darwin")).toBe(true);
    expect(desktopAppPresent("Claude", "/Users/alice", (p) => mockFs.has(p), "darwin")).toBe(true);
    expect(desktopAppPresent("Antigravity", "/Users/alice", (p) => mockFs.has(p), "darwin")).toBe(false);
  });

  it("detects apps in Linux standard directories and XDG desktop entries", () => {
    const mockFs = new Set([
      "/usr/share/applications/cursor.desktop",
      "/opt/Antigravity/antigravity",
      "/home/alice/.local/share/applications/claude.desktop",
    ]);
    expect(desktopAppPresent("Cursor", "/home/alice", (p) => mockFs.has(p), "linux")).toBe(true);
    expect(desktopAppPresent("Antigravity", "/home/alice", (p) => mockFs.has(p), "linux")).toBe(true);
    expect(desktopAppPresent("Claude", "/home/alice", (p) => mockFs.has(p), "linux")).toBe(true);
    expect(desktopAppPresent("NonExistent", "/home/alice", (p) => mockFs.has(p), "linux")).toBe(false);
  });

  it("detects apps in Windows LocalAppData and Program Files", () => {
    const mockFs = new Set([
      "C:\\Users\\alice\\AppData\\Local\\Programs\\cursor\\Cursor.exe",
      "C:\\Program Files\\Antigravity\\Antigravity.exe",
    ]);
    expect(desktopAppPresent("Cursor", "C:\\Users\\alice", (p) => mockFs.has(p), "win32")).toBe(true);
    expect(desktopAppPresent("Antigravity", "C:\\Users\\alice", (p) => mockFs.has(p), "win32")).toBe(true);
    expect(desktopAppPresent("Claude", "C:\\Users\\alice", (p) => mockFs.has(p), "win32")).toBe(false);
  });
});

describe("Cross-Platform Uninstaller Leftovers Cleanup", () => {
  it("cleans Linux XDG config, cache, and data directories", () => {
    const paths = uninstallLeftoversForPlatform({
      home: "/home/alice",
      claudeRoot: "/home/alice/.claude",
      userData: "/home/alice/.config/agentic-leash-electron",
      historyDir: "/var/lib/agentic-leash",
      systemHistory: "/var/lib/agentic-leash",
      platform: "linux",
    });
    expect(paths).toContain("/home/alice/.config/agentic-leash");
    expect(paths).toContain("/home/alice/.cache/agentic-leash");
    expect(paths).toContain("/home/alice/.local/share/agentic-leash");
    expect(paths).toContain("/home/alice/.config/autostart/agentic-leash.desktop");
    // Should NOT contain macOS Library paths
    expect(paths.some((p) => p.includes("Library/Preferences"))).toBe(false);
  });

  it("cleans Windows AppData Roaming and Local paths", () => {
    const paths = uninstallLeftoversForPlatform({
      home: "C:\\Users\\alice",
      claudeRoot: "C:\\Users\\alice\\.claude",
      userData: "C:\\Users\\alice\\AppData\\Roaming\\AgenticLeash",
      historyDir: "C:\\ProgramData\\AgenticLeash",
      systemHistory: "C:\\ProgramData\\AgenticLeash",
      platform: "win32",
    });
    expect(paths).toContain("C:\\Users\\alice\\AppData\\Roaming\\AgenticLeash");
    expect(paths).toContain("C:\\Users\\alice\\AppData\\Local\\AgenticLeash");
    expect(paths).toContain("C:\\Users\\alice\\AppData\\Local\\Programs\\AgenticLeash");
    expect(paths).toContain("C:\\Users\\alice\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\agentic-leash.cmd");
  });
});
