import { shellWords, type ShellWord } from "./paths";

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
