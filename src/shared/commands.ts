import { shellWords, type ShellWord } from "./paths";

export { shellWords, type ShellWord };

// Commands that only look. Anything that can write, run another program, or print env vars stays out.
const PLAIN = new Set([
  "cd", "pwd", "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "file", "stat", "du", "df",
  "which", "whoami", "id", "uname", "hostname", "date", "basename", "dirname", "realpath", "readlink",
  "diff", "cmp", "cut", "tr", "uniq", "nl", "column", "echo", "printf", "true", "false", "jq", "sw_vers",
]);

const BLOCKED_FLAGS: Record<string, (arg: string) => boolean> = {
  find: (arg) => ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"].includes(arg),
  rg: (arg) => arg === "--pre" || arg.startsWith("--pre="),
  tree: (arg) => arg === "-o",
  sort: (arg) => arg === "-o" || arg.startsWith("--output"),
};

const GIT_READS = new Set(["status", "diff", "log", "show", "blame", "rev-parse", "ls-files", "ls-tree", "describe", "shortlog", "grep", "cat-file", "merge-base", "whatchanged"]);
const GIT_LIST_FLAGS = new Set(["-a", "-r", "-v", "-vv", "-l", "--list", "--all", "--remotes", "--show-current", "--verbose"]);
const VERSION_FLAGS = new Set(["-v", "-V", "--version", "version"]);

function git(args: string[]): boolean {
  let index = 0;
  while (args[index] === "--no-pager" || args[index] === "-P") index += 1;
  const sub = args[index];
  const rest = args.slice(index + 1);
  if (!sub) return false;
  if (rest.some((arg) => arg.startsWith("--output") || arg === "--ext-diff")) return false;
  if (sub === "--version" || GIT_READS.has(sub)) return true;
  if (sub === "branch" || sub === "tag") return rest.every((arg) => GIT_LIST_FLAGS.has(arg));
  if (sub === "remote") return rest.every((arg) => arg === "-v" || arg === "--verbose");
  if (sub === "stash" || sub === "worktree") return rest[0] === "list";
  if (sub === "config") return ["--get", "--get-all", "--list", "-l", "--get-regexp"].includes(rest[0] ?? "");
  return false;
}

function readOnlySegment(words: string[]): boolean {
  const [name, ...args] = words;
  if (!name) return true;
  // `FOO=1 git diff` can swap the diff or pager program.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(name)) return false;
  if (name === "git") return git(args);
  if (["node", "python", "python3", "ruby", "go", "rustc", "cargo", "deno", "bun", "java"].includes(name)) return args.length === 1 && VERSION_FLAGS.has(args[0]!);
  if (["npm", "pnpm", "yarn"].includes(name)) return args.length >= 1 && (VERSION_FLAGS.has(args[0]!) || ["ls", "list", "why", "outdated"].includes(args[0]!));
  if (name in BLOCKED_FLAGS) return !args.some(BLOCKED_FLAGS[name]!);
  return PLAIN.has(name);
}

const PIPE_OK = new Set(["|", "&&", "||", ";", "2>&1"]);

/** Substitutions run even inside double quotes; only single quotes hide them. */
function hasSubstitution(command: string): boolean {
  let double = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (char === "\\") index += 1;
    else if (char === "'" && !double) index = command.indexOf("'", index + 1) < 0 ? command.length : command.indexOf("'", index + 1);
    else if (char === '"') double = !double;
    else if (char === "`" || ((char === "$" || char === "<" || char === ">") && command[index + 1] === "(")) return true;
  }
  return false;
}

/** True when every part of a shell line only reads. Redirects go only to /dev/null. */
export function isReadOnlyCommand(command: string): boolean {
  if (hasSubstitution(command)) return false;
  const parts: ShellWord[] = shellWords(command.trim());
  if (!parts.length) return false;
  let segment: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const { text, op } = parts[index]!;
    if (!op) {
      segment.push(text);
      continue;
    }
    if (text === ">" || text === "2>" || text === "&>") {
      const target = parts[index + 1];
      if (!target || target.op || target.text !== "/dev/null") return false;
      index += 1;
      continue;
    }
    if (!PIPE_OK.has(text)) return false;
    if (text === "2>&1") continue;
    if (!readOnlySegment(segment)) return false;
    segment = [];
  }
  return readOnlySegment(segment);
}

const EGRESS = new Set(["curl", "wget", "nc", "ncat", "netcat", "socat", "telnet", "ftp", "sftp", "scp", "rsync", "ssh", "http", "https", "xh"]);

/** Shell lines that can send data off the machine. */
export function isEgressCommand(command: string): boolean {
  const words = shellWords(command).filter((word) => !word.op).map((word) => word.text.split("/").pop() ?? word.text);
  return words.some((word, index) => {
    if (EGRESS.has(word)) return true;
    const next = words[index + 1];
    if (word === "git" && next === "push") return true;
    if ((word === "npm" || word === "pnpm" || word === "yarn") && next === "publish") return true;
    return word === "gh" && (next === "api" || next === "gist");
  });
}

const GIT_RESET_HARD = /(?:^|[\s;&|])git\s+([^;&|]+\s+)?reset\b[^;&|]*\s--hard(\s|$|;)/;
const GIT_CLEAN_FORCE = /(?:^|[\s;&|])git\s+([^;&|]+\s+)?clean\b[^;&|]*\s(-[a-zA-Z]*f[a-zA-Z]*|--force)(\s|$|;)/;

/** Matches local destructive git actions: git reset --hard and git clean -f (ignoring force push). */
export function isGitDestructiveLocalCommand(command: string): boolean {
  return GIT_RESET_HARD.test(command) || GIT_CLEAN_FORCE.test(command);
}

// ---------------------------------------------------------------------------
// Extended command analysis (compound splitting, severity, host trust)
// ---------------------------------------------------------------------------

export const DEFAULT_TRUSTED_HOSTS: readonly string[] = [
  "github.com",
  "api.github.com",
  "gist.github.com",
  "raw.githubusercontent.com",
  "gitlab.com",
  "bitbucket.org",
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "proxy.golang.org",
  "localhost",
  "127.0.0.1",
];

export type CommandSeverity =
  | "read_only"
  | "safe"
  | "egress_trusted"
  | "egress_unknown"
  | "destructive"
  | "pipe_to_shell";

export interface CommandSegmentAnalysis {
  segment: string;
  severity: CommandSeverity;
  reason: string | null;
  hosts: string[];
  isEgress: boolean;
  isDestructive: boolean;
  isPipeToShell: boolean;
}

export interface CommandAnalysis {
  highestSeverity: CommandSeverity;
  segments: CommandSegmentAnalysis[];
  hosts: string[];
  unknownHosts: string[];
  trustedHostsMatched: string[];
  isDestructive: boolean;
  isPipeToShell: boolean;
  hasUnknownEgress: boolean;
  hasTrustedEgressOnly: boolean;
  reasons: string[];
}

const SEVERITY_RANK: Record<CommandSeverity, number> = {
  read_only: 0,
  safe: 1,
  egress_trusted: 2,
  egress_unknown: 3,
  destructive: 4,
  pipe_to_shell: 5,
};

/** Advance past `$(...)`, `<(...)`, or `>(...)` starting at the `(` index. */
function skipParenSubstitution(command: string, openParenIndex: number): number {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  let index = openParenIndex + 1;
  while (index < command.length && depth > 0) {
    const ch = command[index]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      index += 1;
      continue;
    }
    if (ch === "\\") {
      index += 2;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
        index += 1;
        continue;
      }
      if ((ch === "$" || ch === "<" || ch === ">") && command[index + 1] === "(") {
        index = skipParenSubstitution(command, index + 1);
        continue;
      }
      index += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      index += 1;
    } else if (ch === "(") {
      depth += 1;
      index += 1;
    } else if (ch === ")") {
      depth -= 1;
      index += 1;
    } else {
      index += 1;
    }
  }
  return index;
}

/**
 * Quote-aware, escape-aware, and substitution-aware splitter on `&&`, `||`, `;`, and unquoted newlines.
 * Keeps pipelines (`|`) intact inside each segment.
 */
export function splitShellCommands(command: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;

  const pushSegment = (end: number) => {
    const trimmed = command.slice(start, end).trim();
    if (trimmed) segments.push(trimmed);
  };

  for (let index = 0; index < command.length; ) {
    const ch = command[index]!;

    if (quote === "'") {
      if (ch === "'") quote = null;
      index += 1;
      continue;
    }

    if (ch === "\\") {
      index += index + 1 < command.length ? 2 : 1;
      continue;
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = null;
        index += 1;
        continue;
      }
      if ((ch === "$" || ch === "<" || ch === ">") && command[index + 1] === "(") {
        index = skipParenSubstitution(command, index + 1);
        continue;
      }
      index += 1;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      index += 1;
      continue;
    }

    if ((ch === "$" || ch === "<" || ch === ">") && command[index + 1] === "(") {
      index = skipParenSubstitution(command, index + 1);
      continue;
    }

    if (command.startsWith("&&", index) || command.startsWith("||", index)) {
      pushSegment(index);
      index += 2;
      start = index;
      continue;
    }

    if (ch === ";" || ch === "\n") {
      pushSegment(index);
      index += 1;
      start = index;
      continue;
    }

    if (ch === "\r" && command[index + 1] === "\n") {
      pushSegment(index);
      index += 2;
      start = index;
      continue;
    }

    index += 1;
  }

  pushSegment(command.length);
  return segments;
}

/** Normalize a host string by stripping brackets, trailing `:port`, trailing dot, and lowercasing. */
function normalizeHost(raw: string): string {
  let host = raw.trim().toLowerCase();
  if (!host) return "";
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(host);
  if (bracketed) {
    host = bracketed[1]!;
  } else {
    const hostPort = /^([^:]+):(\d+)$/.exec(host);
    if (hostPort) host = hostPort[1]!;
  }
  return host.replace(/\.+$/, "");
}

/** Case-insensitive exact or `*.domain.com` wildcard host check. */
export function isHostTrusted(host: string, trustedHosts: readonly string[] = DEFAULT_TRUSTED_HOSTS): boolean {
  const normalized = normalizeHost(host);
  if (!normalized) return false;
  for (const rawPattern of trustedHosts) {
    const pattern = rawPattern.trim().toLowerCase().replace(/\.+$/, "");
    if (!pattern) continue;
    if (pattern.startsWith("*.")) {
      const domain = pattern.slice(2);
      if (!domain) continue;
      if (normalized === domain || normalized.endsWith(`.${domain}`)) return true;
    } else {
      const normalizedPattern = normalizeHost(pattern);
      if (normalizedPattern && normalized === normalizedPattern) return true;
    }
  }
  return false;
}

const WRAPPER_COMMANDS = new Set(["command", "builtin", "nohup", "exec", "sudo", "time"]);
const XARGS_ARG_FLAGS = new Set(["-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a"]);

interface ParsedStage {
  raw: string;
  exe: string;
  args: string[];
  words: string[];
}

/** Split a shell segment on unquoted pipe operators (`|` and `|&`), keeping substitutions intact. */
function splitPipelineStages(segment: string): string[] {
  const stages: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < segment.length; ) {
    const ch = segment[index]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      index += 1;
      continue;
    }
    if (ch === "\\") {
      index += index + 1 < segment.length ? 2 : 1;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if ((ch === "$" || ch === "<" || ch === ">") && segment[index + 1] === "(") {
        index = skipParenSubstitution(segment, index + 1);
        continue;
      }
      index += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      index += 1;
      continue;
    }
    if ((ch === "$" || ch === "<" || ch === ">") && segment[index + 1] === "(") {
      index = skipParenSubstitution(segment, index + 1);
      continue;
    }
    if (ch === "|" && segment[index + 1] !== "|") {
      const part = segment.slice(start, index).trim();
      if (part) stages.push(part);
      index += segment[index + 1] === "&" ? 2 : 1;
      start = index;
      continue;
    }
    index += 1;
  }

  const tail = segment.slice(start).trim();
  if (tail) stages.push(tail);
  return stages;
}

/** Strip leading env assignments and wrapper prefixes (`sudo`, `env`, `command`, `nohup`, `exec`) for command inspection. */
function parseStage(stageText: string, unwrapSudoAndEnv = true): ParsedStage {
  const rawTokens = shellWords(stageText)
    .filter((w) => !w.op)
    .map((w) => w.text);
  let idx = 0;
  while (idx < rawTokens.length) {
    const tok = rawTokens[idx]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      idx += 1;
      continue;
    }
    const base = tok.split("/").pop() ?? tok;
    if (unwrapSudoAndEnv && (WRAPPER_COMMANDS.has(base) || base === "env")) {
      idx += 1;
      while (idx < rawTokens.length && (rawTokens[idx]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rawTokens[idx]!))) {
        idx += 1;
      }
      continue;
    }
    if (unwrapSudoAndEnv && base === "xargs") {
      idx += 1;
      while (idx < rawTokens.length && rawTokens[idx]!.startsWith("-")) {
        const flag = rawTokens[idx]!;
        idx += XARGS_ARG_FLAGS.has(flag) ? 2 : 1;
      }
      continue;
    }
    break;
  }
  const rest = rawTokens.slice(idx);
  const rawExe = rest[0] ?? "";
  const exe = (rawExe.split("/").pop() ?? rawExe).replace(/^[()]+|[()]+$/g, "");
  return { raw: stageText, exe, args: rest.slice(1), words: rest };
}

/** Extract a clean host from a URL authority or raw host token; returns null for variables or invalid hosts. */
function cleanExtractedHost(raw: string): string | null {
  let candidate = raw.trim();
  if (!candidate) return null;
  const atIdx = candidate.lastIndexOf("@");
  if (atIdx >= 0) candidate = candidate.slice(atIdx + 1);
  if (!candidate || /[$`{}()]/.test(candidate)) return null;
  const host = normalizeHost(candidate);
  if (!host || /[$`{}()\s]/.test(host)) return null;
  return host;
}

const URL_REGEX = /(?:https?|ssh|git|ftp):\/\/([^\s/'"`<>|;&()?#,]+)/gi;
const SCP_REGEX = /(?:^|[\s'"`=,])([A-Za-z0-9._-]+)@(\[[^\]]+\]|[A-Za-z0-9.-]+):(?=\S|$|['"])/g;

const SSH_ARG_FLAGS = new Set(["-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-P", "-Q", "-R", "-S", "-W", "-w"]);
const NC_ARG_FLAGS = new Set(["-p", "-s", "-w", "-T", "-X", "-x", "-e", "-c", "-i", "-o", "-I", "-O", "-P", "-q", "-G", "-g", "--proxy", "--proxy-type", "--source-port", "--wait"]);
const TELNET_ARG_FLAGS = new Set(["-b", "-e", "-l", "-n", "-s"]);

function extractPositionalHost(exe: string, args: string[]): string[] {
  const out: string[] = [];
  if (exe === "ssh" || exe === "sftp") {
    let i = 0;
    while (i < args.length) {
      const arg = args[i]!;
      if (arg === "--") {
        i += 1;
        break;
      }
      if (arg === "-J" && i + 1 < args.length) {
        const jumpHost = cleanExtractedHost(args[i + 1]!);
        if (jumpHost) out.push(jumpHost);
        i += 2;
        continue;
      }
      if (SSH_ARG_FLAGS.has(arg)) {
        i += 2;
        continue;
      }
      if (arg.startsWith("-")) {
        i += 1;
        continue;
      }
      break;
    }
    if (i < args.length) {
      const target = args[i]!;
      if (!target.includes("://")) {
        const host = cleanExtractedHost(target);
        if (host && !/^\d+$/.test(host)) out.push(host);
      }
    }
    return out;
  }

  if (exe === "nc" || exe === "ncat" || exe === "netcat" || exe === "telnet" || exe === "ftp") {
    const argFlags = exe === "telnet" ? TELNET_ARG_FLAGS : exe === "ftp" ? new Set<string>() : NC_ARG_FLAGS;
    let listenMode = false;
    let i = 0;
    while (i < args.length) {
      const arg = args[i]!;
      if (arg === "--") {
        i += 1;
        break;
      }
      if (arg === "-l" || arg === "--listen" || (/^-[a-zA-Z]*l/.test(arg) && !arg.startsWith("--"))) {
        listenMode = true;
      }
      if (argFlags.has(arg)) {
        i += 2;
        continue;
      }
      if (arg.startsWith("-")) {
        i += 1;
        continue;
      }
      break;
    }
    if (!listenMode && i < args.length) {
      const host = cleanExtractedHost(args[i]!);
      if (host && !/^\d+$/.test(host)) out.push(host);
    }
    return out;
  }

  if (exe === "socat") {
    for (const arg of args) {
      const match = /^(?:TCP|TCP4|TCP6|UDP|UDP4|UDP6|SSL|OPENSSL):(\[[^\]]+\]|[^:,\s]+):\d+/i.exec(arg);
      if (match) {
        const host = cleanExtractedHost(match[1]!);
        if (host) out.push(host);
      }
    }
    return out;
  }

  if (exe === "scp" || exe === "rsync") {
    for (const arg of args) {
      if (arg.startsWith("-") || arg.includes("://") || arg.startsWith("/") || arg.startsWith(".")) continue;
      const match = /^([A-Za-z0-9._-]+@)?(\[[^\]]+\]|[A-Za-z0-9][A-Za-z0-9.-]*):/.exec(arg);
      if (match) {
        const host = cleanExtractedHost(match[2]!);
        if (host) out.push(host);
      }
    }
  }

  return out;
}

/**
 * Extract hostnames/IPs from URLs (`http://`, `https://`, `ssh://`, `git://`, `ftp://`),
 * SCP/git SSH syntax (`git@github.com:org/repo`, `user@host:/path`), and host args to
 * `ssh`, `nc`, `ncat`, `netcat`, `telnet` (plus `ftp`, `scp`, `rsync`, `socat`).
 */
export function extractHostsFromCommand(command: string): string[] {
  const hosts: string[] = [];
  const seen = new Set<string>();
  const add = (host: string | null) => {
    if (!host || seen.has(host)) return;
    seen.add(host);
    hosts.push(host);
  };

  for (const match of command.matchAll(URL_REGEX)) {
    add(cleanExtractedHost(match[1]!));
  }

  for (const match of command.matchAll(SCP_REGEX)) {
    const prefixStart = Math.max(0, (match.index ?? 0) - 6);
    const preceding = command.slice(prefixStart, (match.index ?? 0) + match[0].length);
    if (preceding.includes("://")) continue;
    add(cleanExtractedHost(match[2]!));
  }

  for (const segment of splitShellCommands(command)) {
    for (const stageText of splitPipelineStages(segment)) {
      const stage = parseStage(stageText);
      for (const host of extractPositionalHost(stage.exe, stage.args)) {
        add(host);
      }
    }
  }

  return hosts;
}

const SHELL_INTERPRETERS = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "ash", "fish", "csh", "tcsh",
  "python", "python2", "python3", "node", "nodejs", "perl", "ruby",
]);

function isShellInterpreter(exe: string): boolean {
  return SHELL_INTERPRETERS.has(exe) || /^python[23](?:\.\d+)*$/.test(exe);
}

const DOWNLOAD_EXES = new Set(["curl", "wget", "http", "https", "xh"]);

function isBase64DecodeStage(stage: ParsedStage): boolean {
  if (stage.exe !== "base64") return false;
  return stage.args.some(
    (arg) => arg === "-d" || arg === "-D" || arg === "--decode" || (/^-[a-zA-Z]*[dD]/.test(arg) && !arg.startsWith("--")),
  );
}

/** Extract `$(...)`, `<(...)`, and backtick bodies outside single quotes for recursive pipe-to-shell checks. */
function extractCommandSubstitutions(command: string): string[] {
  const bodies: string[] = [];
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; ) {
    const ch = command[index]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      index += 1;
      continue;
    }
    if (ch === "\\") {
      index += 2;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
        index += 1;
        continue;
      }
      if ((ch === "$" || ch === "<" || ch === ">") && command[index + 1] === "(") {
        const end = skipParenSubstitution(command, index + 1);
        bodies.push(command.slice(index + 2, Math.max(index + 2, end - 1)));
        index = end;
        continue;
      }
      if (ch === "`") {
        const end = findClosingBacktick(command, index + 1);
        bodies.push(command.slice(index + 1, end));
        index = end + 1;
        continue;
      }
      index += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      index += 1;
      continue;
    }
    if ((ch === "$" || ch === "<" || ch === ">") && command[index + 1] === "(") {
      const end = skipParenSubstitution(command, index + 1);
      bodies.push(command.slice(index + 2, Math.max(index + 2, end - 1)));
      index = end;
      continue;
    }
    if (ch === "`") {
      const end = findClosingBacktick(command, index + 1);
      bodies.push(command.slice(index + 1, end));
      index = end + 1;
      continue;
    }
    index += 1;
  }
  return bodies;
}

function findClosingBacktick(command: string, start: number): number {
  for (let i = start; i < command.length; i += 1) {
    if (command[i] === "\\") {
      i += 1;
      continue;
    }
    if (command[i] === "`") return i;
  }
  return command.length;
}

function containsDownloader(text: string): boolean {
  for (const seg of splitShellCommands(text)) {
    for (const stageText of splitPipelineStages(seg)) {
      const stage = parseStage(stageText);
      if (DOWNLOAD_EXES.has(stage.exe)) return true;
    }
  }
  return false;
}

function isSingleSegmentPipeToShell(segment: string): boolean {
  const stages = splitPipelineStages(segment).map((s) => parseStage(s));
  let sawSource = false;
  for (const stage of stages) {
    if (DOWNLOAD_EXES.has(stage.exe) || isBase64DecodeStage(stage)) {
      sawSource = true;
      continue;
    }
    if (sawSource && isShellInterpreter(stage.exe)) {
      return true;
    }
  }

  for (const stage of stages) {
    const isEvalOrSource = stage.exe === "eval" || stage.exe === "source" || stage.exe === ".";
    const isInterpreter = isShellInterpreter(stage.exe);
    if (isEvalOrSource || isInterpreter) {
      const subs = extractCommandSubstitutions(stage.raw);
      if (subs.some((sub) => containsDownloader(sub))) {
        return true;
      }
    }
  }

  // Recurse into unquoted/double-quoted substitutions in case a pipeline runs inside `$(...)`.
  const subs = extractCommandSubstitutions(segment);
  return subs.some((sub) => isPipeToShellCommand(sub));
}

/**
 * Detects pipe-to-shell and download-and-execute patterns:
 * `curl|wget ... | sh/bash/...`, `eval $(curl|wget ...)`, `bash <(curl|wget ...)`, `base64 -d|--decode | sh/bash`.
 */
export function isPipeToShellCommand(command: string): boolean {
  return splitShellCommands(command).some((seg) => isSingleSegmentPipeToShell(seg));
}

function parseGitCommand(args: string[]): { sub: string | null; rest: string[] } {
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === "-C" || arg === "-c" || arg === "--git-dir" || arg === "--work-tree" || arg === "--namespace") {
      i += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      i += 1;
      continue;
    }
    return { sub: arg, rest: args.slice(i + 1) };
  }
  return { sub: null, rest: [] };
}

function argsBeforeDoubleDash(args: string[]): string[] {
  const idx = args.indexOf("--");
  return idx >= 0 ? args.slice(0, idx) : args;
}

function isStageDestructive(stageText: string): string | null {
  const rawTokens = shellWords(stageText).filter((w) => !w.op).map((w) => w.text);
  let idx = 0;
  while (idx < rawTokens.length) {
    const tok = rawTokens[idx]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      idx += 1;
      continue;
    }
    const base = (tok.split("/").pop() ?? tok).replace(/^[()]+|[()]+$/g, "");
    if (base === "sudo") return "Runs command with elevated privileges (sudo)";
    if (["command", "builtin", "nohup", "exec", "time"].includes(base)) {
      idx += 1;
      continue;
    }
    if (base === "xargs") {
      idx += 1;
      while (idx < rawTokens.length && rawTokens[idx]!.startsWith("-")) {
        const flag = rawTokens[idx]!;
        idx += XARGS_ARG_FLAGS.has(flag) ? 2 : 1;
      }
      continue;
    }
    break;
  }

  if (idx >= rawTokens.length) return null;
  const rawExe = rawTokens[idx]!;
  const exe = (rawExe.split("/").pop() ?? rawExe).replace(/^[()]+|[()]+$/g, "");
  const args = rawTokens.slice(idx + 1);

  if (exe === "mkfs" || exe.startsWith("mkfs.")) return "Formats a filesystem (mkfs)";
  if (exe === "dd" && args.some((a) => a.startsWith("if="))) return "Raw disk/block operation (dd)";

  if (exe === "rm") {
    const flagArgs = argsBeforeDoubleDash(args);
    const hasR = flagArgs.some((a) => a === "-r" || a === "-R" || a === "--recursive" || (/^-[a-zA-Z]*[rR]/.test(a) && !a.startsWith("--")));
    const hasF = flagArgs.some((a) => a === "-f" || a === "--force" || (/^-[a-zA-Z]*f/.test(a) && !a.startsWith("--")));
    if (hasR || hasF) return "Force or recursive deletion (rm)";
  }

  if (exe === "chmod" || exe === "chown") {
    const flagArgs = argsBeforeDoubleDash(args);
    if (flagArgs.some((a) => a === "-R" || a === "--recursive" || (/^-[a-zA-Z]*R/.test(a) && !a.startsWith("--")))) {
      return `Recursive permission/ownership change (${exe} -R)`;
    }
  }

  if (exe === "git") {
    const { sub, rest } = parseGitCommand(args);
    if (sub === "push" && rest.some((a) => a === "--force" || a === "-f" || a === "--force-with-lease" || a.startsWith("--force-with-lease="))) {
      return "Force-pushes git branch";
    }
    if (sub === "reset" && rest.some((a) => a === "--hard")) {
      return "Discards uncommitted changes (git reset --hard)";
    }
    if (sub === "clean" && rest.some((a) => a === "-f" || a === "--force" || (/^-[a-zA-Z]*f/.test(a) && !a.startsWith("--")))) {
      return "Deletes untracked files (git clean -f)";
    }
  }

  return null;
}

/** Detects destructive operations inside a single command segment (including pipelines and substitutions). */
export function isDestructiveSegment(segment: string): { destructive: boolean; reason: string | null } {
  for (const stageText of splitPipelineStages(segment)) {
    const reason = isStageDestructive(stageText);
    if (reason) return { destructive: true, reason };
  }
  for (const sub of extractCommandSubstitutions(segment)) {
    for (const subSeg of splitShellCommands(sub)) {
      const res = isDestructiveSegment(subSeg);
      if (res.destructive) return res;
    }
  }
  return { destructive: false, reason: null };
}

const RAW_SOCKET_TOOLS = new Set(["nc", "ncat", "netcat", "socat", "telnet", "ftp"]);
const HOST_EGRESS_TOOLS = new Set(["curl", "wget", "http", "https", "xh", "ssh", "scp", "rsync", "sftp"]);
const GH_EGRESS_SUBS = new Set(["pr", "api", "gist", "release"]);
const GIT_NETWORK_SUBS = new Set(["push", "clone", "fetch", "pull", "ls-remote"]);

function isStageNetworkTool(stage: ParsedStage): boolean {
  if (RAW_SOCKET_TOOLS.has(stage.exe) || HOST_EGRESS_TOOLS.has(stage.exe)) return true;
  if (stage.exe === "git") {
    const { sub } = parseGitCommand(stage.args);
    return sub !== null && GIT_NETWORK_SUBS.has(sub);
  }
  if (stage.exe === "gh") return GH_EGRESS_SUBS.has(stage.args[0] ?? "");
  if (stage.exe === "npm" || stage.exe === "pnpm" || stage.exe === "yarn") return stage.args[0] === "publish";
  return false;
}

function classifyEgressStage(
  stage: ParsedStage,
  trustedHosts: readonly string[],
): { trusted: boolean; hosts: string[]; untrustedHosts: string[]; reason: string } | null {
  if (!isStageNetworkTool(stage)) return null;
  const stageHosts = extractHostsFromCommand(stage.raw);
  const untrusted = stageHosts.filter((h) => !isHostTrusted(h, trustedHosts));

  if (RAW_SOCKET_TOOLS.has(stage.exe)) {
    const loopbackOnly =
      stageHosts.length > 0 &&
      stageHosts.every((h) => (h === "localhost" || h === "127.0.0.1") && isHostTrusted(h, trustedHosts));
    if (loopbackOnly) {
      return { trusted: true, hosts: stageHosts, untrustedHosts: [], reason: `Egress to trusted local host (${stageHosts.join(", ")})` };
    }
    return {
      trusted: false,
      hosts: stageHosts,
      untrustedHosts: untrusted,
      reason: stageHosts.length > 0
        ? `Raw network tool (${stage.exe}) targeting ${stageHosts.join(", ")}`
        : `Raw network tool (${stage.exe})`,
    };
  }

  if (stage.exe === "git") {
    const { sub } = parseGitCommand(stage.args);
    if (sub === "push") {
      if (stageHosts.length === 0) {
        return { trusted: true, hosts: [], untrustedHosts: [], reason: "Git push to configured remote" };
      }
      if (untrusted.length === 0) {
        return { trusted: true, hosts: stageHosts, untrustedHosts: [], reason: `Git push to trusted host (${stageHosts.join(", ")})` };
      }
      return { trusted: false, hosts: stageHosts, untrustedHosts: untrusted, reason: `Git push to untrusted host (${untrusted.join(", ")})` };
    }
    if (stageHosts.length > 0) {
      if (untrusted.length === 0) {
        return { trusted: true, hosts: stageHosts, untrustedHosts: [], reason: `Git ${sub} from trusted host (${stageHosts.join(", ")})` };
      }
      return { trusted: false, hosts: stageHosts, untrustedHosts: untrusted, reason: `Git ${sub} from untrusted host (${untrusted.join(", ")})` };
    }
    return null;
  }

  if (stage.exe === "gh") {
    const ghTrusted = isHostTrusted("github.com", trustedHosts) || isHostTrusted("api.github.com", trustedHosts);
    if (untrusted.length > 0) {
      return { trusted: false, hosts: stageHosts, untrustedHosts: untrusted, reason: `gh CLI targeting untrusted host (${untrusted.join(", ")})` };
    }
    if (!ghTrusted) {
      return { trusted: false, hosts: stageHosts, untrustedHosts: untrusted, reason: "gh CLI used while GitHub hosts are not trusted" };
    }
    return { trusted: true, hosts: stageHosts, untrustedHosts: [], reason: "GitHub CLI egress (trusted)" };
  }

  if (stage.exe === "npm" || stage.exe === "pnpm" || stage.exe === "yarn") {
    if (untrusted.length > 0) {
      return { trusted: false, hosts: stageHosts, untrustedHosts: untrusted, reason: `Package publish to untrusted registry (${untrusted.join(", ")})` };
    }
    if (!isHostTrusted("registry.npmjs.org", trustedHosts)) {
      return { trusted: false, hosts: stageHosts, untrustedHosts: untrusted, reason: "Package publish while registry.npmjs.org is not trusted" };
    }
    return { trusted: true, hosts: stageHosts, untrustedHosts: [], reason: "Package publish to trusted npm registry" };
  }

  // curl, wget, http, https, xh, ssh, scp, rsync, sftp
  if (stageHosts.length > 0 && untrusted.length === 0) {
    return { trusted: true, hosts: stageHosts, untrustedHosts: [], reason: `Egress to trusted host (${stageHosts.join(", ")})` };
  }
  if (untrusted.length > 0) {
    return { trusted: false, hosts: stageHosts, untrustedHosts: untrusted, reason: `Egress to untrusted host (${untrusted.join(", ")})` };
  }
  return { trusted: false, hosts: [], untrustedHosts: [], reason: `Egress via ${stage.exe} with unresolved host` };
}

function analyzeSegment(segment: string, trustedHosts: readonly string[]): CommandSegmentAnalysis {
  const hosts = extractHostsFromCommand(segment);
  const pipeToShell = isPipeToShellCommand(segment);
  const destructiveCheck = isDestructiveSegment(segment);
  const stages = splitPipelineStages(segment).map((s) => parseStage(s));
  const subStages = extractCommandSubstitutions(segment).flatMap((sub) =>
    splitShellCommands(sub).flatMap((s) => splitPipelineStages(s).map((st) => parseStage(st))),
  );
  const allStages = [...stages, ...subStages];
  const egressResults = allStages
    .map((stage) => classifyEgressStage(stage, trustedHosts))
    .filter((res): res is NonNullable<typeof res> => res !== null);

  const isEgress = egressResults.length > 0;

  if (pipeToShell) {
    return {
      segment,
      severity: "pipe_to_shell",
      reason: "Downloads or decodes content and executes it in a shell or interpreter",
      hosts,
      isEgress: isEgress || isEgressCommand(segment) || hosts.length > 0,
      isDestructive: destructiveCheck.destructive,
      isPipeToShell: true,
    };
  }

  if (destructiveCheck.destructive) {
    return {
      segment,
      severity: "destructive",
      reason: destructiveCheck.reason,
      hosts,
      isEgress,
      isDestructive: true,
      isPipeToShell: false,
    };
  }

  if (isEgress) {
    const anyUntrusted = egressResults.some((r) => !r.trusted);
    if (anyUntrusted) {
      const untrustedReason = egressResults.find((r) => !r.trusted)?.reason ?? "Egress to unknown or untrusted host";
      return {
        segment,
        severity: "egress_unknown",
        reason: untrustedReason,
        hosts,
        isEgress: true,
        isDestructive: false,
        isPipeToShell: false,
      };
    }
    const trustedReason = egressResults[0]?.reason ?? `Egress to trusted host (${hosts.join(", ")})`;
    return {
      segment,
      severity: "egress_trusted",
      reason: trustedReason,
      hosts,
      isEgress: true,
      isDestructive: false,
      isPipeToShell: false,
    };
  }

  if (isReadOnlyCommand(segment)) {
    return {
      segment,
      severity: "read_only",
      reason: null,
      hosts,
      isEgress: false,
      isDestructive: false,
      isPipeToShell: false,
    };
  }

  return {
    segment,
    severity: "safe",
    reason: null,
    hosts,
    isEgress: false,
    isDestructive: false,
    isPipeToShell: false,
  };
}

/**
 * Splits a shell command into sub-commands, classifies each segment, and aggregates
 * severity, host trust, destructiveness, and pipe-to-shell indicators.
 */
export function analyzeCommand(command: string, trustedHosts: readonly string[] = DEFAULT_TRUSTED_HOSTS): CommandAnalysis {
  const rawSegments = splitShellCommands(command);
  const segments = rawSegments.map((seg) => analyzeSegment(seg, trustedHosts));

  let highestSeverity: CommandSeverity = "read_only";
  const allHosts: string[] = [];
  const hostSet = new Set<string>();
  const unknownHosts: string[] = [];
  const unknownSet = new Set<string>();
  const trustedHostsMatched: string[] = [];
  const trustedSet = new Set<string>();
  const reasons: string[] = [];
  const reasonSet = new Set<string>();

  for (const seg of segments) {
    if (SEVERITY_RANK[seg.severity] > SEVERITY_RANK[highestSeverity]) {
      highestSeverity = seg.severity;
    }
    for (const host of seg.hosts) {
      if (!hostSet.has(host)) {
        hostSet.add(host);
        allHosts.push(host);
      }
      if (isHostTrusted(host, trustedHosts)) {
        if (!trustedSet.has(host)) {
          trustedSet.add(host);
          trustedHostsMatched.push(host);
        }
      } else if (!unknownSet.has(host)) {
        unknownSet.add(host);
        unknownHosts.push(host);
      }
    }
    if (seg.reason && !reasonSet.has(seg.reason)) {
      reasonSet.add(seg.reason);
      reasons.push(seg.reason);
    }
  }

  const isDestructive = segments.some((s) => s.isDestructive);
  const isPipeToShell = segments.some((s) => s.isPipeToShell);
  const hasUnknownEgress = segments.some((s) => s.severity === "egress_unknown" || s.severity === "pipe_to_shell");
  const hasTrustedEgressOnly =
    segments.some((s) => s.severity === "egress_trusted") &&
    unknownHosts.length === 0 &&
    !hasUnknownEgress;

  return {
    highestSeverity,
    segments,
    hosts: allHosts,
    unknownHosts,
    trustedHostsMatched,
    isDestructive,
    isPipeToShell,
    hasUnknownEgress,
    hasTrustedEgressOnly,
    reasons,
  };
}
