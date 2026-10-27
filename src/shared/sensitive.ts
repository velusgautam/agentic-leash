// One catalog for macOS, Linux and Windows. Paths are compared with forward slashes.

const SECRET_DIRS: [string, string][] = [
  [".ssh", "SSH keys"],
  [".gnupg", "GPG keys"],
  [".aws", "AWS credentials"],
  [".azure", "Azure credentials"],
  [".oci", "Oracle Cloud credentials"],
  [".kube", "Kubernetes credentials"],
  [".config/gcloud", "Google Cloud credentials"],
  [".config/op", "1Password CLI"],
  [".password-store", "Password store"],
  [".local/share/keyrings", "Keyring"],
  ["Library/Keychains", "Keychain"],
  ["Library/Messages", "Messages"],
  ["Library/Mail", "Mail"],
  ["Library/Application Support/AddressBook", "Contacts"],
  ["Library/Application Support/Google/Chrome", "Browser profile"],
  ["Library/Application Support/BraveSoftware", "Browser profile"],
  ["Library/Application Support/Microsoft Edge", "Browser profile"],
  ["Library/Application Support/Firefox", "Browser profile"],
  ["Library/Application Support/Arc", "Browser profile"],
  ["Library/Safari", "Browser profile"],
  [".mozilla", "Browser profile"],
  [".config/google-chrome", "Browser profile"],
  [".config/chromium", "Browser profile"],
  [".config/BraveSoftware", "Browser profile"],
  ["AppData/Roaming/Microsoft/Credentials", "Windows credentials"],
  ["AppData/Local/Microsoft/Credentials", "Windows credentials"],
  ["AppData/Roaming/Microsoft/Protect", "Windows credentials"],
  ["AppData/Roaming/Microsoft/Crypto", "Windows credentials"],
  ["AppData/Roaming/gnupg", "GPG keys"],
  ["AppData/Local/Google/Chrome/User Data", "Browser profile"],
  ["AppData/Local/Microsoft/Edge/User Data", "Browser profile"],
  ["AppData/Roaming/Mozilla/Firefox", "Browser profile"],
];

const SECRET_FILES: [string, string][] = [
  [".docker/config.json", "Docker credentials"],
  [".npmrc", "Package token"],
  [".pypirc", "Package token"],
  [".gem/credentials", "Package token"],
  [".cargo/credentials", "Package token"],
  [".cargo/credentials.toml", "Package token"],
  [".m2/settings.xml", "Package token"],
  [".gradle/gradle.properties", "Package token"],
  [".nuget/NuGet/NuGet.Config", "Package token"],
  [".git-credentials", "Git credentials"],
  [".netrc", "Login credentials"],
  ["_netrc", "Login credentials"],
  [".pgpass", "Database password"],
  [".my.cnf", "Database password"],
  [".boto", "Cloud credentials"],
  [".s3cfg", "Cloud credentials"],
  [".vault-token", "Vault token"],
  [".config/gh/hosts.yml", "GitHub token"],
  [".config/hub", "GitHub token"],
  [".terraform.d/credentials.tfrc.json", "Terraform token"],
  [".zsh_history", "Shell history"],
  [".bash_history", "Shell history"],
  [".python_history", "Shell history"],
  [".node_repl_history", "Shell history"],
  [".psql_history", "Shell history"],
  [".mysql_history", "Shell history"],
  ["AppData/Roaming/Microsoft/Windows/PowerShell/PSReadLine/ConsoleHost_history.txt", "Shell history"],
];

const SECRET_NAMES = new Set([".git-credentials", ".netrc", "_netrc", ".htpasswd", ".pgpass", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "id_ecdsa_sk", "id_ed25519_sk", "credentials.json", "secrets.json", "secrets.yml", "secrets.yaml"]);
const SECRET_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".kdbx", ".ppk", ".tfstate", ".tfstate.backup"];
const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template", ".env.dist", ".env.defaults"]);
const PUBLIC_NAMES = new Set(["cacert.pem", "cert.pem", "ca-bundle.pem", "ca-certificates.pem"]);
// Certificate bundles and vendored test fixtures, read by every TLS client.
const PATTERN_EXEMPT = ["/etc/", "/private/etc/", "/usr/", "/System/", "/Library/", "/opt/homebrew/", "/Applications/"];
const VENDOR_SEGMENTS = ["/node_modules/", "/site-packages/", "/.venv/", "/vendor/", "/Library/Caches/"];
// Atomic safe-buffer transaction files created by macOS Security framework when committing keychain changes
export const KEYCHAIN_SAFE_BUFFER = /(?:^|\/)Library\/Keychains\/.*\.keychain(?:-db)?\.sb-[0-9a-fA-F]+-[0-9a-zA-Z]+$/;

const PERSONAL_DIRS = ["Desktop", "Documents", "Downloads", "Pictures", "Movies", "Music", "Videos", "Public", "Library/Mobile Documents", "Library/CloudStorage", "Dropbox", "OneDrive", "Google Drive", "iCloudDrive"];

const STARTUP_FILES = [".zshrc", ".zshenv", ".zprofile", ".zlogin", ".bashrc", ".bash_profile", ".bash_login", ".profile", ".config/fish/config.fish", ".ssh/authorized_keys", ".ssh/rc", ".gitconfig"];
const STARTUP_DIRS = ["Library/LaunchAgents", ".config/autostart", ".config/systemd/user", "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup", "Documents/PowerShell", "Documents/WindowsPowerShell"];
const SYSTEM_STARTUP = ["/Library/LaunchAgents", "/Library/LaunchDaemons", "/etc/cron.d", "/etc/crontab", "/var/at/tabs", "/var/spool/cron", "/etc/systemd/system"];
// Agent and editor config that can run commands on the next start.
const STARTUP_SEGMENTS = ["/.git/hooks"];
const AGENT_CONFIG = [".claude/settings.json", ".claude/settings.local.json", ".cursor/hooks.json", ".cursor/mcp.json", ".codex/config.toml", ".codex/hooks.json", ".gemini/settings.json", ".gemini/config/hooks.json", ".gemini/config/mcp_config.json", ".gemini/antigravity-cli/settings.json", ".agents/hooks.json", ".hermes/config.yaml", ".mcp.json"];

function slashed(path: string): string {
  return path.replace(/\\/g, "/");
}

function within(file: string, root: string): boolean {
  if (process.platform === "win32") {
    file = file.toLowerCase();
    root = root.toLowerCase();
  }
  return file === root || file.startsWith(`${root}/`);
}

function baseName(file: string): string {
  return file.slice(file.lastIndexOf("/") + 1);
}

/** True for a file name that holds a secret wherever it sits, like `.env` or `id_ed25519`. */
export function isSecretName(name: string): boolean {
  if (PUBLIC_NAMES.has(name)) return false;
  if (name === ".env" || (name.startsWith(".env.") && !ENV_TEMPLATES.has(name))) return true;
  if (SECRET_NAMES.has(name)) return true;
  if (/^service-account.*\.json$/.test(name)) return true;
  return SECRET_EXTENSIONS.some((ext) => name.endsWith(ext) && name.length > ext.length);
}

/** Why a path holds secrets, or null. `file` is absolute and already normalised. */
export function secretKind(file: string, home: string): string | null {
  const path = slashed(file);
  const base = slashed(home);
  if (KEYCHAIN_SAFE_BUFFER.test(path)) return null;
  for (const [rel, label] of SECRET_DIRS) if (within(path, `${base}/${rel}`)) return label;
  for (const [rel, label] of SECRET_FILES) if (within(path, `${base}/${rel}`)) return label;
  if (PATTERN_EXEMPT.some((prefix) => path.startsWith(prefix)) || VENDOR_SEGMENTS.some((part) => path.includes(part))) return null;
  if (path === `${base}/.git/config` || path.endsWith("/.git/config")) return "Git config";
  return isSecretName(baseName(path)) ? "Secret file" : null;
}

/** Personal folders like Documents or iCloud Drive, or null. */
export function personalKind(file: string, home: string): string | null {
  const path = slashed(file);
  const base = slashed(home);
  const hit = PERSONAL_DIRS.find((rel) => within(path, `${base}/${rel}`));
  return hit ? hit.split("/").pop()! : null;
}

/** Files and folders that run code at login, shell start, or the next agent start. */
export function startupKind(file: string, home: string): string | null {
  const path = slashed(file);
  const base = slashed(home);
  if (STARTUP_FILES.some((rel) => path === `${base}/${rel}`)) return "Shell or login startup";
  if (STARTUP_DIRS.some((rel) => within(path, `${base}/${rel}`)) || SYSTEM_STARTUP.some((root) => within(path, root))) return "Login item";
  if (STARTUP_SEGMENTS.some((part) => path.includes(`${part}/`) || path.endsWith(part))) return "Git hook";
  if (AGENT_CONFIG.some((rel) => path === `${base}/${rel}` || path.endsWith(`/${rel}`))) return "Agent config";
  return null;
}
