import type { Access, SecureArea, SecureAreaGroup, SecureAreaRule } from "./types";

export type { SecureArea, SecureAreaGroup, SecureAreaRule };

export interface BuiltinSecureAreaDef {
  pattern: string;
  label: string;
  group: SecureAreaGroup;
  readRule: SecureAreaRule;
  writeRule: SecureAreaRule;
}

export const ENV_EXCLUDED_BASENAMES = new Set([".env.example", ".env.sample", ".env.template"]);

export const SECURE_AREA_GROUP_INFO: Record<
  SecureAreaGroup,
  { title: string; description: string; order: number }
> = {
  secrets: {
    title: "Secrets",
    description: "SSH keys, cloud credentials, and auth tokens. Agents ask before reading or writing here.",
    order: 1,
  },
  project_secrets: {
    title: "Project secrets",
    description: "Environment files (.env*) and private keys (*.pem, *.key, *.p12). Ask on read, allow on write.",
    order: 2,
  },
  notes_personal: {
    title: "Notes & personal data",
    description: "Apple Notes, Obsidian vaults, Photos Library, and Contacts. Agents ask on read and write.",
    order: 3,
  },
  personal_folders: {
    title: "Personal folders",
    description: "Desktop, Downloads, Documents, and iCloud Drive. Ask on read, allow on write.",
    order: 4,
  },
  blocked: {
    title: "Always blocked",
    description: "Browser profiles, Keychains, Messages, and Mail. Agents are always blocked from reading or writing.",
    order: 5,
  },
  startup: {
    title: "Startup & agent config",
    description: "Shell profiles, LaunchAgents, .git/hooks, and agent settings. Allow on read, ask on write.",
    order: 6,
  },
  custom: {
    title: "Custom",
    description: "Folders, files, or patterns you protected manually.",
    order: 7,
  },
};

export const BUILTIN_SECURE_AREAS: BuiltinSecureAreaDef[] = [
  // secrets (Read: ask, Write: ask)
  { pattern: "~/.ssh", label: "SSH keys", group: "secrets", readRule: "ask", writeRule: "ask" },
  { pattern: "~/.gnupg", label: "GPG keys", group: "secrets", readRule: "ask", writeRule: "ask" },
  { pattern: "~/.aws", label: "AWS credentials", group: "secrets", readRule: "ask", writeRule: "ask" },
  { pattern: "~/.config/gcloud", label: "Google Cloud credentials", group: "secrets", readRule: "ask", writeRule: "ask" },
  { pattern: "~/.kube", label: "Kubernetes credentials", group: "secrets", readRule: "ask", writeRule: "ask" },
  { pattern: "~/.azure", label: "Azure credentials", group: "secrets", readRule: "ask", writeRule: "ask" },
  { pattern: "~/.config/gh", label: "GitHub CLI tokens", group: "secrets", readRule: "ask", writeRule: "ask" },
  { pattern: "~/.netrc", label: "Login credentials (.netrc)", group: "secrets", readRule: "ask", writeRule: "ask" },
  { pattern: "~/.npmrc", label: "npm token (.npmrc)", group: "secrets", readRule: "ask", writeRule: "ask" },
  { pattern: "~/.git-credentials", label: "Git credentials", group: "secrets", readRule: "ask", writeRule: "ask" },

  // project_secrets (Read: ask, Write: allow)
  { pattern: ".env*", label: "Environment files (.env*)", group: "project_secrets", readRule: "ask", writeRule: "allow" },
  { pattern: "*.pem", label: "Certificates & keys (*.pem)", group: "project_secrets", readRule: "ask", writeRule: "allow" },
  { pattern: "*.key", label: "Private keys (*.key)", group: "project_secrets", readRule: "ask", writeRule: "allow" },
  { pattern: "*.p12", label: "PKCS#12 certificates (*.p12)", group: "project_secrets", readRule: "ask", writeRule: "allow" },

  // notes_personal (Read: ask, Write: ask)
  { pattern: "~/Library/Group Containers/group.com.apple.notes", label: "Apple Notes", group: "notes_personal", readRule: "ask", writeRule: "ask" },
  { pattern: "~/Library/Application Support/obsidian", label: "Obsidian vaults", group: "notes_personal", readRule: "ask", writeRule: "ask" },
  { pattern: "~/Pictures/Photos Library.photoslibrary", label: "Photos Library", group: "notes_personal", readRule: "ask", writeRule: "ask" },
  { pattern: "~/Library/Application Support/AddressBook", label: "Contacts", group: "notes_personal", readRule: "ask", writeRule: "ask" },

  // personal_folders (Read: ask, Write: allow)
  { pattern: "~/Desktop", label: "Desktop", group: "personal_folders", readRule: "ask", writeRule: "allow" },
  { pattern: "~/Downloads", label: "Downloads", group: "personal_folders", readRule: "ask", writeRule: "allow" },
  { pattern: "~/Documents", label: "Documents", group: "personal_folders", readRule: "ask", writeRule: "allow" },
  { pattern: "~/Library/Mobile Documents", label: "iCloud Drive", group: "personal_folders", readRule: "ask", writeRule: "allow" },

  // blocked (Read: block, Write: block)
  { pattern: "~/Library/Application Support/Google/Chrome", label: "Google Chrome profile", group: "blocked", readRule: "block", writeRule: "block" },
  { pattern: "~/Library/Application Support/BraveSoftware", label: "Brave profile", group: "blocked", readRule: "block", writeRule: "block" },
  { pattern: "~/Library/Application Support/Arc", label: "Arc profile", group: "blocked", readRule: "block", writeRule: "block" },
  { pattern: "~/Library/Application Support/Firefox", label: "Firefox profile", group: "blocked", readRule: "block", writeRule: "block" },
  { pattern: "~/Library/Application Support/Microsoft Edge", label: "Microsoft Edge profile", group: "blocked", readRule: "block", writeRule: "block" },
  { pattern: "~/Library/Keychains", label: "macOS Keychains", group: "blocked", readRule: "block", writeRule: "block" },
  { pattern: "~/Library/Messages", label: "Messages", group: "blocked", readRule: "block", writeRule: "block" },
  { pattern: "~/Library/Mail", label: "Mail", group: "blocked", readRule: "block", writeRule: "block" },

  // startup (Read: allow, Write: ask)
  { pattern: "~/.zshrc", label: "Zsh startup (.zshrc)", group: "startup", readRule: "allow", writeRule: "ask" },
  { pattern: "~/.bashrc", label: "Bash startup (.bashrc)", group: "startup", readRule: "allow", writeRule: "ask" },
  { pattern: "~/Library/LaunchAgents", label: "LaunchAgents", group: "startup", readRule: "allow", writeRule: "ask" },
  { pattern: ".git/hooks", label: "Git hooks (.git/hooks)", group: "startup", readRule: "allow", writeRule: "ask" },
  { pattern: "~/.claude/settings.json", label: "Claude settings", group: "startup", readRule: "allow", writeRule: "ask" },
  { pattern: "~/.cursor/mcp.json", label: "Cursor MCP config", group: "startup", readRule: "allow", writeRule: "ask" },
  { pattern: "~/.gemini/settings.json", label: "Gemini settings", group: "startup", readRule: "allow", writeRule: "ask" },
];

const RULE_RANK: Record<SecureAreaRule, number> = {
  allow: 1,
  ask: 2,
  block: 3,
};

function slashPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function normalizePosix(raw: string, home: string): string {
  let path = slashPath(raw).trim();
  const cleanHome = slashPath(home).replace(/\/+$/, "");
  if (path === "~") path = cleanHome || "~";
  else if (path.startsWith("~/")) path = cleanHome ? `${cleanHome}${path.slice(1)}` : path;

  const isAbs = path.startsWith("/");
  const parts = path.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") stack.pop();
      else if (!isAbs) stack.push("..");
      continue;
    }
    stack.push(part);
  }
  const joined = stack.join("/");
  return isAbs ? `/${joined}` : joined;
}

function isUnderPath(target: string, root: string): boolean {
  if (target === root) return true;
  const prefix = root === "/" ? "/" : `${root}/`;
  return target.startsWith(prefix);
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function matchesPattern(normalizedTarget: string, pattern: string, home: string): boolean {
  const cleaned = slashPath(pattern).trim().replace(/\/+$/, "");
  if (!cleaned) return false;

  // Absolute or home-relative directory/file prefix
  if (cleaned.startsWith("~/") || cleaned === "~" || cleaned.startsWith("/")) {
    if ((cleaned === "~" || cleaned.startsWith("~/")) && !home) return false;
    const expanded = normalizePosix(cleaned, home);
    return isUnderPath(normalizedTarget, expanded);
  }

  const baseIdx = normalizedTarget.lastIndexOf("/");
  const base = baseIdx >= 0 ? normalizedTarget.slice(baseIdx + 1) : normalizedTarget;

  // Basename glob (e.g. `.env*`, `*.pem`, `*.key`, `*.p12`)
  if (!cleaned.includes("/") && (cleaned.includes("*") || cleaned.includes("?"))) {
    if (cleaned === ".env*" && ENV_EXCLUDED_BASENAMES.has(base)) return false;
    return globToRegExp(cleaned).test(base);
  }

  // Subpath (e.g. `.git/hooks`)
  return (
    normalizedTarget === cleaned ||
    normalizedTarget.endsWith(`/${cleaned}`) ||
    normalizedTarget.includes(`/${cleaned}/`)
  );
}

export interface SecureAreaMatch {
  area: SecureArea;
  rule: SecureAreaRule;
}

/**
 * Finds the strictest enabled Secure Area matching `targetPath` for `access`.
 * Strictness order: `block` > `ask` > `allow`.
 */
export function matchSecureArea(
  targetPath: string,
  access: Access,
  home: string,
  areas: readonly SecureArea[],
): SecureAreaMatch | null {
  if (!targetPath) return null;
  const normalizedTarget = normalizePosix(targetPath, home);
  let best: SecureAreaMatch | null = null;

  for (const area of areas) {
    if (!area.enabled) continue;
    if (!matchesPattern(normalizedTarget, area.pattern, home)) continue;
    const rule = access === "write" ? area.writeRule : area.readRule;
    if (!best || RULE_RANK[rule] > RULE_RANK[best.rule]) {
      best = { area, rule };
    }
  }

  return best;
}

export function describeRule(rule: SecureAreaRule, access: Access): string {
  const verb = access === "write" ? "modifying" : "opening";
  if (rule === "block") return `Block on ${access}: agents are always denied before ${verb} files here.`;
  if (rule === "ask") return `Ask on ${access}: agents must ask before ${verb} files here.`;
  return `Allow on ${access}: agents can ${access === "write" ? "modify" : "open"} files here without asking.`;
}
