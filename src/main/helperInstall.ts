import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const escapeXml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function helperPlist(execPath: string, scriptPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.agenticleash.helper</string>
  <key>ProgramArguments</key><array>
    <string>${execPath}</string>
    <string>${scriptPath}</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>ELECTRON_RUN_AS_NODE</key><string>1</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
`;
}

export function sweepPlist(execPath: string, scriptPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.agenticleash.sweep</string>
  <key>ProgramArguments</key><array>
    <string>${escapeXml(execPath)}</string>
    <string>${escapeXml(scriptPath)}</string>
    <string>--sweep</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>ELECTRON_RUN_AS_NODE</key><string>1</string></dict>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
</dict></plist>
`;
}

export function helperInstallScript(execPath: string, scriptPath: string): string {
  const plist = "/Library/LaunchDaemons/com.agenticleash.helper.plist";
  const body = Buffer.from(helperPlist(execPath, scriptPath)).toString("base64");
  return `do shell script "/bin/mkdir -p '/Library/Application Support/AgenticLeash' && /bin/echo ${body} | /usr/bin/base64 -d > '${plist}' && /usr/sbin/chown root:wheel '${plist}' '/Library/Application Support/AgenticLeash' && /bin/chmod 644 '${plist}' && /bin/chmod 755 '/Library/Application Support/AgenticLeash' && (/bin/launchctl bootout system '${plist}' || true) && /bin/launchctl bootstrap system '${plist}'" with administrator privileges`;
}

export function helperUninstallScript(): string {
  const plist = "/Library/LaunchDaemons/com.agenticleash.helper.plist";
  const dir = "/Library/Application Support/AgenticLeash";
  return `do shell script "/bin/launchctl bootout system '${plist}' || true; /bin/rm -f '${plist}'; /bin/rm -rf '${dir}'" with administrator privileges`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function helperMaintenanceCommand(
  execPath: string,
  scriptPath: string,
  args: string[],
  tools: { launchctl?: string; env?: string; plist?: string } = {},
): string {
  const plist = tools.plist ?? "/Library/LaunchDaemons/com.agenticleash.helper.plist";
  const service = "system/com.agenticleash.helper";
  const launchctl = shellQuote(tools.launchctl ?? "/bin/launchctl");
  const env = shellQuote(tools.env ?? "/usr/bin/env");
  return `if ${launchctl} print ${service} >/dev/null 2>&1; then ${launchctl} bootout system ${shellQuote(plist)} || exit $?; fi; result=0; ${env} ELECTRON_RUN_AS_NODE=1 ${shellQuote(execPath)} ${shellQuote(scriptPath)} ${args.map(shellQuote).join(" ")} || result=$?; restart=0; ${launchctl} bootstrap system ${shellQuote(plist)} || restart=$?; if [ "$result" -ne 0 ]; then exit $result; fi; exit $restart`;
}

export function helperMaintenanceScript(execPath: string, scriptPath: string, args: string[]): string {
  const command = helperMaintenanceCommand(execPath, scriptPath, args);
  return `do shell script "${command.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" with administrator privileges`;
}

export function sweepAgentPath(home = homedir()): string {
  return join(home, "Library", "LaunchAgents", "com.agenticleash.sweep.plist");
}

export function installSweepAgent(execPath: string, scriptPath: string, home = homedir()): string {
  const path = sweepAgentPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, sweepPlist(execPath, scriptPath));
  return path;
}

export function sweepServiceTarget(uid: number): string {
  return `gui/${uid}/com.agenticleash.sweep`;
}

export interface HelperMeta {
  startedAt: number | null;
  pid: number | null;
  scriptMtime: number | null;
}

export function parseLaunchdPid(stdout: string): number | null {
  const match = /pid\s*=\s*(\d+)/.exec(stdout);
  return match ? Number(match[1]) : null;
}

export function readHelperMeta(historyPath: string): HelperMeta {
  try {
    if (!existsSync(historyPath)) return { startedAt: null, pid: null, scriptMtime: null };
    const db = new DatabaseSync(historyPath, { readOnly: true });
    try {
      const rows = db.prepare("SELECT key, value FROM meta WHERE key IN ('helper_started_at', 'helper_pid', 'helper_script_mtime')").all() as { key: string; value: string }[];
      const map = new Map(rows.map((r) => [r.key, r.value]));
      return {
        startedAt: map.has("helper_started_at") ? Number(map.get("helper_started_at")) : null,
        pid: map.has("helper_pid") ? Number(map.get("helper_pid")) : null,
        scriptMtime: map.has("helper_script_mtime") ? Number(map.get("helper_script_mtime")) : null,
      };
    } finally {
      db.close();
    }
  } catch {
    return { startedAt: null, pid: null, scriptMtime: null };
  }
}

export function isHelperRestartNeeded(options: {
  scriptMtime: number;
  meta: HelperMeta;
  runningPid: number | null;
  pidStartedAt: number | null;
}): boolean {
  const { scriptMtime, meta, runningPid, pidStartedAt } = options;
  if (!scriptMtime) return false;
  if (meta.scriptMtime !== null && meta.scriptMtime > 0 && meta.scriptMtime < scriptMtime) {
    return true;
  }
  if (runningPid !== null) {
    const effectiveStartedAt = meta.pid === runningPid && meta.startedAt !== null ? meta.startedAt : pidStartedAt;
    if (effectiveStartedAt !== null && effectiveStartedAt < scriptMtime) {
      return true;
    }
  }
  return false;
}

