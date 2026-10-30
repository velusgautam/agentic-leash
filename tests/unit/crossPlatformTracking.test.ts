import { describe, expect, it } from "vitest";
import { ProcTree, type EsEvent } from "../../src/helper/proctree";
import { classify } from "../../src/helper/classify";
import { parseLsof } from "../../src/main/system";
import {
  parseNetstat,
  parseSs,
  parseProcNetTcp,
  pollNetCrossPlatform,
} from "../../src/helper/net";
import {
  formatLinuxEvent,
  formatWindowsEvent,
} from "../../src/helper/tracker";
import {
  helperSystemdUnit,
  sweepSystemdUnit,
  sweepSystemdTimer,
  windowsServiceCommand,
  parseSystemctlStatus,
  parseScQueryStatus,
} from "../../src/main/helperInstall";
import {
  linuxDesktopEntry,
  linuxAutostartPath,
  windowsStartupScript,
  windowsStartupPath,
} from "../../src/main/loginItem";
import { hermesCmd, hermesHookScript } from "../../src/main/hermesHooks";

describe("Cross-Platform Event Format & Classification", () => {
  it("preserves eslogger classification for macOS exactly", () => {
    const tree = new ProcTree();
    tree.apply({
      process: { audit_token: { pid: 101 }, executable: { path: "/usr/local/bin/claude" } },
      event: { exec: { target: { executable: { path: "/usr/local/bin/claude" }, audit_token: { pid: 101 } } } },
    });

    const esOpen: EsEvent = {
      time: "2026-10-27T12:00:00.000Z",
      process: { audit_token: { pid: 101 }, executable: { path: "/usr/local/bin/claude" } },
      event: { open: { file: { path: "/Users/alice/project/main.ts" }, fflag: 1 } },
    };
    const classifiedOpen = classify(esOpen, tree, "/Users/alice");
    expect(classifiedOpen).not.toBeNull();
    expect(classifiedOpen?.agent).toBe("claude");
    expect(classifiedOpen?.kind).toBe("read");
    expect(classifiedOpen?.path).toBe("/Users/alice/project/main.ts");
    expect(classifiedOpen?.source).toBe("eslogger");

    const esCloseWrite: EsEvent = {
      time: "2026-10-27T12:00:01.000Z",
      process: { audit_token: { pid: 101 }, executable: { path: "/usr/local/bin/claude" } },
      event: { close: { modified: true, target: { path: "/Users/alice/project/main.ts" } } },
    };
    const classifiedWrite = classify(esCloseWrite, tree, "/Users/alice");
    expect(classifiedWrite).not.toBeNull();
    expect(classifiedWrite?.kind).toBe("write");
  });

  it("normalizes Linux events into standard EsEvent and classifies accurately", () => {
    const tree = new ProcTree();
    // Simulate Linux process execution for 'claude'
    const execEvent = formatLinuxEvent({
      time: "2026-10-27T12:00:00.000Z",
      pid: 202,
      ppid: 1,
      exe: "/usr/bin/claude",
      type: "exec",
      path: "/usr/bin/claude",
    });
    tree.apply(execEvent);
    expect(tree.has(202)).toBe(true);
    expect(tree.agent(202)).toBe("claude");

    // Linux file read (fanotify FAN_OPEN)
    const readEvent = formatLinuxEvent({
      time: "2026-10-27T12:00:01.000Z",
      pid: 202,
      exe: "/usr/bin/claude",
      type: "open",
      path: "/home/alice/src/index.js",
      flags: 0, // O_RDONLY
    });
    const classifiedRead = classify(readEvent, tree, "/home/alice");
    expect(classifiedRead).not.toBeNull();
    expect(classifiedRead?.agent).toBe("claude");
    expect(classifiedRead?.kind).toBe("read");
    expect(classifiedRead?.path).toBe("/home/alice/src/index.js");

    // Linux file write (fanotify FAN_CLOSE_WRITE)
    const writeEvent = formatLinuxEvent({
      time: "2026-10-27T12:00:02.000Z",
      pid: 202,
      exe: "/usr/bin/claude",
      type: "close_write",
      path: "/home/alice/src/index.js",
      modified: true,
    });
    const classifiedWrite = classify(writeEvent, tree, "/home/alice");
    expect(classifiedWrite).not.toBeNull();
    expect(classifiedWrite?.kind).toBe("write");

    // Linux file unlink / delete
    const unlinkEvent = formatLinuxEvent({
      time: "2026-10-27T12:00:03.000Z",
      pid: 202,
      exe: "/usr/bin/claude",
      type: "unlink",
      path: "/home/alice/src/temp.txt",
    });
    const classifiedUnlink = classify(unlinkEvent, tree, "/home/alice");
    expect(classifiedUnlink?.kind).toBe("delete");

    // Linux file rename / move
    const renameEvent = formatLinuxEvent({
      time: "2026-10-27T12:00:04.000Z",
      pid: 202,
      exe: "/usr/bin/claude",
      type: "rename",
      path: "/home/alice/src/old.txt",
      destPath: "/home/alice/src/new.txt",
    });
    const classifiedRename = classify(renameEvent, tree, "/home/alice");
    expect(classifiedRename?.kind).toBe("rename");
    expect(classifiedRename?.destPath).toBe("/home/alice/src/new.txt");
  });

  it("normalizes Windows ETW events into standard EsEvent and classifies accurately", () => {
    const tree = new ProcTree();
    // Simulate Windows process creation
    const procStart = formatWindowsEvent({
      time: "2026-10-27T12:00:00.000Z",
      pid: 303,
      ppid: 4,
      image: "C:\\Users\\Alice\\AppData\\Local\\Programs\\Claude\\claude.exe",
      type: "ProcessStart",
    });
    tree.apply(procStart);
    expect(tree.has(303)).toBe(true);
    expect(tree.agent(303)).toBe("claude");

    // Windows File Read
    const fileRead = formatWindowsEvent({
      time: "2026-10-27T12:00:01.000Z",
      pid: 303,
      image: "C:\\Users\\Alice\\AppData\\Local\\Programs\\Claude\\claude.exe",
      type: "FileRead",
      path: "C:\\Users\\Alice\\project\\app.ts",
    });
    const classifiedRead = classify(fileRead, tree, "C:/Users/Alice");
    expect(classifiedRead).not.toBeNull();
    expect(classifiedRead?.agent).toBe("claude");
    expect(classifiedRead?.kind).toBe("read");

    // Windows File Write / Close with write
    const fileWrite = formatWindowsEvent({
      time: "2026-10-27T12:00:02.000Z",
      pid: 303,
      image: "C:\\Users\\Alice\\AppData\\Local\\Programs\\Claude\\claude.exe",
      type: "FileWrite",
      path: "C:\\Users\\Alice\\project\\app.ts",
      modified: true,
    });
    const classifiedWrite = classify(fileWrite, tree, "C:/Users/Alice");
    expect(classifiedWrite?.kind).toBe("write");

    // Windows File Delete
    const fileDelete = formatWindowsEvent({
      time: "2026-10-27T12:00:03.000Z",
      pid: 303,
      image: "C:\\Users\\Alice\\AppData\\Local\\Programs\\Claude\\claude.exe",
      type: "FileDelete",
      path: "C:\\Users\\Alice\\project\\temp.tmp",
    });
    const classifiedDelete = classify(fileDelete, tree, "C:/Users/Alice");
    expect(classifiedDelete?.kind).toBe("delete");

    // Windows File Rename
    const fileRename = formatWindowsEvent({
      time: "2026-10-27T12:00:04.000Z",
      pid: 303,
      image: "C:\\Users\\Alice\\AppData\\Local\\Programs\\Claude\\claude.exe",
      type: "FileRename",
      path: "C:\\Users\\Alice\\project\\old.ts",
      destPath: "C:\\Users\\Alice\\project\\renamed.ts",
    });
    const classifiedRename = classify(fileRename, tree, "C:/Users/Alice");
    expect(classifiedRename?.kind).toBe("rename");
    expect(classifiedRename?.destPath).toBe("C:\\Users\\Alice\\project\\renamed.ts");
  });
});

describe("Cross-Platform Network Parsing", () => {
  it("parses macOS lsof output as baseline", () => {
    const sample = "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 12 u 1u IPv4 0t0 TCP 10.0.0.1:1->1.2.3.4:443 (ESTABLISHED)\n";
    expect(parseLsof(sample)).toEqual([{ pid: 12, remote: "1.2.3.4:443" }]);
  });

  it("parses Windows netstat output", () => {
    const sample = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    192.168.1.50:52341     140.82.112.4:443       ESTABLISHED     4500
  TCP    127.0.0.1:8080         0.0.0.0:0              LISTENING       1200
  TCP    192.168.1.50:52345     104.18.2.1:443         TIME_WAIT       0
  TCP    192.168.1.50:52399     api.anthropic.com:443  ESTABLISHED     4500
`;
    const rows = parseNetstat(sample);
    expect(rows).toEqual([
      { pid: 4500, remote: "140.82.112.4:443" },
      { pid: 4500, remote: "api.anthropic.com:443" },
    ]);
  });

  it("parses Linux ss output", () => {
    const sample = `
ESTAB 0 0 192.168.1.15:45234 104.20.10.1:443 users:(("claude",pid=6789,fd=3))
ESTAB 0 0 192.168.1.15:45236 142.250.190.46:443 users:(("node",pid=6789,fd=7))
LISTEN 0 128 127.0.0.1:3000 0.0.0.0:* users:(("server",pid=111,fd=4))
`;
    const rows = parseSs(sample);
    expect(rows).toEqual([
      { pid: 6789, remote: "104.20.10.1:443" },
      { pid: 6789, remote: "142.250.190.46:443" },
    ]);
  });

  it("parses Linux /proc/net/tcp output", () => {
    // 0100007F:01BB = 127.0.0.1:443 (remote address field)
    // state 01 = TCP_ESTABLISHED
    const sample = `
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:B000 0100007F:01BB 01 00000000:00000000 00:00000000 00000000  1000        0 54321 1 0000000000000000 100 0 0 10 0
   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0
`;
    const rows = parseProcNetTcp(sample, new Map([[54321, 8888]]));
    expect(rows).toEqual([{ pid: 8888, remote: "127.0.0.1:443" }]);
  });

  it("polls network cross-platform with deduplication", () => {
    const seen = new Set<string>();
    const events = pollNetCrossPlatform({
      pids: [100],
      seen,
      now: 1000,
      agentFor: () => "claude-code" as const,
      connections: () => [{ pid: 100, remote: "93.184.216.34:443" }],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agent: "claude-code",
      pid: 100,
      kind: "net",
      path: "93.184.216.34:443",
      source: "net",
    });

    // Repeating poll should not duplicate
    const events2 = pollNetCrossPlatform({
      pids: [100],
      seen,
      now: 2000,
      agentFor: () => "claude-code" as const,
      connections: () => [{ pid: 100, remote: "93.184.216.34:443" }],
    });
    expect(events2).toHaveLength(0);
  });
});

describe("Cross-Platform Helper Service & System Lifecycle", () => {
  it("generates systemd service and timer units for Linux", () => {
    const unit = helperSystemdUnit("/usr/bin/agentic-leash", "/usr/share/agentic-leash/leash-helper.js");
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("Description=Agentic Leash Activity Helper");
    expect(unit).toContain("ExecStart=/usr/bin/agentic-leash /usr/share/agentic-leash/leash-helper.js");
    expect(unit).toContain("Environment=ELECTRON_RUN_AS_NODE=1");
    expect(unit).toContain("Restart=always");

    const sweepUnit = sweepSystemdUnit("/usr/bin/agentic-leash", "/usr/share/agentic-leash/leash-helper.js");
    expect(sweepUnit).toContain("--sweep");

    const sweepTimer = sweepSystemdTimer();
    expect(sweepTimer).toContain("[Timer]");
    expect(sweepTimer).toContain("OnCalendar=");
  });

  it("parses systemctl status", () => {
    expect(parseSystemctlStatus("active\n")).toBe("running");
    expect(parseSystemctlStatus("inactive\n")).toBe("stopped");
    expect(parseSystemctlStatus("failed\n")).toBe("stopped");
    expect(parseSystemctlStatus("")).toBe("not installed");
  });

  it("generates Windows Service commands and parses sc.exe query", () => {
    const cmd = windowsServiceCommand("C:\\Program Files\\AgenticLeash\\Agentic Leash.exe", "C:\\Program Files\\AgenticLeash\\leash-helper.js");
    expect(cmd).toContain("sc.exe create AgenticLeashHelper");
    expect(cmd).toContain("start= auto");

    expect(parseScQueryStatus("STATE              : 4  RUNNING")).toBe("running");
    expect(parseScQueryStatus("STATE              : 1  STOPPED")).toBe("stopped");
    expect(parseScQueryStatus("FAILED 1060: The specified service does not exist as an installed service.")).toBe("not installed");
  });
});

describe("Cross-Platform Autostart & Hermes Hooks", () => {
  it("generates XDG desktop autostart entry for Linux", () => {
    const entry = linuxDesktopEntry("/opt/AgenticLeash/agentic-leash");
    expect(entry).toContain("[Desktop Entry]");
    expect(entry).toContain("Type=Application");
    expect(entry).toContain("Name=Agentic Leash");
    expect(entry).toContain("Exec=/opt/AgenticLeash/agentic-leash --hidden");
    expect(entry).toContain("X-GNOME-Autostart-enabled=true");

    expect(linuxAutostartPath("/home/bob")).toBe("/home/bob/.config/autostart/agentic-leash.desktop");
  });

  it("generates Windows startup script and path", () => {
    const script = windowsStartupScript("C:\\Program Files\\AgenticLeash\\Agentic Leash.exe");
    expect(script).toContain('start "" "C:\\Program Files\\AgenticLeash\\Agentic Leash.exe" --hidden');
    expect(windowsStartupPath("C:\\Users\\Bob")).toBe("C:\\Users\\Bob\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\agentic-leash.cmd");
  });

  it("generates Windows Hermes cmd hook wrapper", () => {
    const cmd = hermesCmd("C:\\Program Files\\AgenticLeash\\Agentic Leash.exe", "C:\\Program Files\\AgenticLeash\\leash-hook.js");
    expect(cmd).toContain("@echo off");
    expect(cmd).toContain("set ELECTRON_RUN_AS_NODE=1");
    expect(cmd).toContain("Agentic Leash.exe");

    expect(hermesHookScript("C:/Users/Bob", "win32")).toBe("C:/Users/Bob/.hermes/agent-hooks/agentic-leash.cmd");
    expect(hermesHookScript("/Users/Bob", "darwin")).toBe("/Users/Bob/.hermes/agent-hooks/agentic-leash.sh");
    expect(hermesHookScript("/home/bob", "linux")).toBe("/home/bob/.hermes/agent-hooks/agentic-leash.sh");
  });
});
