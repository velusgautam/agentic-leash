<p align="center">
  <img src="docs/media/banner.png" alt="Agentic Leash — Your AI agents. On a leash." />
</p>

<h1 align="center">Agentic Leash</h1>

<p align="center">
  <strong>Zero-friction security &amp; live observability for AI coding agents on macOS.</strong><br/>
  Let Claude, Cursor, Codex, Gemini CLI, Hermes, and Antigravity code at full speed — while your keys, secrets, and personal files stay protected.
</p>

<p align="center">
  <a href="https://github.com/velusgautam/agentic-leash/releases/latest"><img src="https://img.shields.io/github/v/release/velusgautam/agentic-leash?label=release" alt="Latest release" /></a>
  <img src="https://img.shields.io/badge/status-beta-blue" alt="Status: Beta" />
  <a href="https://github.com/velusgautam/agentic-leash/releases"><img src="https://img.shields.io/github/downloads/velusgautam/agentic-leash/total" alt="Downloads" /></a>
  <a href="https://github.com/velusgautam/agentic-leash/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/velusgautam/agentic-leash/ci.yml?label=ci" alt="CI" /></a>
  <img src="https://img.shields.io/badge/platform-macOS-black" alt="Platform: macOS" />
  <a href="LICENSE"><img src="https://img.shields.io/github/license/velusgautam/agentic-leash" alt="MIT License" /></a>
</p>

<p align="center">
  <a href="#why-agentic-leash">Why Agentic Leash?</a> ·
  <a href="#download">Download</a> ·
  <a href="#supported-agents">Supported agents</a> ·
  <a href="#features">Features</a> ·
  <a href="#how-it-hooks-in">How it works</a> ·
  <a href="#build-from-source">Build from source</a>
</p>

---

## Why Agentic Leash?

AI coding agents are fast, autonomous, and run with **your full user permissions**. One bad prompt, runaway loop, or indirect prompt injection can read your SSH keys (`~/.ssh`), cloud credentials (`~/.aws`), and `.env` secrets, or run destructive shell commands.

In the wild, unconstrained agents have caused catastrophic data loss — from [Claude CLI wiping a home directory](https://www.reddit.com/r/ClaudeAI/comments/1pgxckk/claude_cli_deleted_my_entire_home_directory_wiped/) to [Antigravity deleting drive contents](https://www.reddit.com/r/google_antigravity/comments/1p82or6/google_antigravity_just_deleted_the_contents_of/).

**Agentic Leash flips the model from noisy popups to smart boundaries:**
- **Work freely everywhere else** — Everything outside your **Secure Areas** is auto-accepted and audited quietly.
- **Gate what actually matters** — Independent **Read** and **Write** rules (`Allow`, `Ask`, `Block`) for Secrets, `.env` files, Personal folders, Notes, and Startup configs.
- **Stop dangerous surprises** — Automatic guards catch `rm -rf`, `git push --force`, `sudo`, and outbound network calls right after reading a secret.
- **100% local & zero telemetry** — Every rule, Unix socket, SQLite database, and audit diff stays on your Mac.

---

## Download

Install in one line on macOS (Apple Silicon):

```bash
curl -fsSL https://github.com/velusgautam/agentic-leash/releases/latest/download/install.sh | bash
```

Or grab the signed & notarized `.dmg` from the [latest release](https://github.com/velusgautam/agentic-leash/releases/latest).

| Platform | Installer | Status |
| --- | --- | --- |
| macOS (Apple Silicon) | `.dmg`, signed & notarized | Supported (Beta) |

---

## Supported agents

| Agent | Hook events |
| --- | --- |
| **Antigravity** (IDE & `agy` CLI) | `PreToolUse` |
| **Claude** (Desktop app & `claude` CLI) | `PreToolUse` |
| **Codex** | `PreToolUse` |
| **Cursor** | `preToolUse`, `beforeReadFile`, `beforeShellExecution`, `beforeMCPExecution` |
| **Gemini CLI** | `BeforeTool` |
| **Hermes** | `pre_tool_call` |

---

## Features

### 🔒 Secure Areas with Read & Write Rules

![Secure Areas configuration with independent Read and Write rules](docs/media/secure-areas.png)

Protect your Mac in seconds with pre-configured **Secure Areas**:
- **Secrets** (`~/.ssh`, `~/.aws`, `~/.gnupg`, tokens)
- **Project secrets** (`.env*`, `*.pem`, `*.key`, `*.p12`)
- **Notes & personal data** (Apple Notes, Obsidian vaults, Photos, Contacts)
- **Personal folders** (`Desktop`, `Downloads`, `Documents`, `iCloud Drive`)
- **Always blocked** (Browser profiles, Keychains, Messages, Mail)
- **Startup & agent config** (`.zshrc`, `LaunchAgents`, `.git/hooks`)

Add any custom folder or file, or click **🔒 Protect** straight from any Live or History row.

---

### ⚡ Rare, High-Context Approval Prompts

![High-risk approval prompt for a Secure Area read](docs/media/approval.png)

Normal coding never gets interrupted. Only when an agent touches an `Ask` Secure Area or triggers a safety guard does a crisp, keyboard-first prompt appear:
- Shows the **agent**, **risk level**, **matched Secure Area & rule**, **path**, and **command**
- Choose **Allow once** (`1`), **Allow this session** (`2`), **Allow today** (`3`), or **Deny** (`Esc`, auto-denies in 120s)
- Sticky action bar keeps controls visible even on long commands or multi-path requests

---

### 🚨 Live Activity & Inline Secret Detection

![Live activity feed highlighting sensitive reads](docs/media/live-sensitive.png)

Watch every file read, write, exec, and network call across all connected agents in real time. Secure Area hits and inline secrets (`sk-`, `ghp_`, `github_pat_`, `AKIA`, `xoxb-`, PEM keys) light up in red and automatically arm the **Network after a secret** egress guard.

---

### 🧬 Full Write Diffs & ~98.5% Noise Reduction

![History view showing a write diff and the grant that allowed it](docs/media/history-diff.png)

History filters out build artifacts, system noise, and non-sensitive raw reads, collapses 50+ file recursive scans into clean summaries, merges duplicate hook/filesystem writes with **side-by-side before/after diffs**, and lets you restore previous file versions in one click.

---

### 🛡️ Session Allows, Automatic Guards & Live Grants

![Access page with session allows, automatic guards, and live grants](docs/media/grants.png)

Inspect every active **Session Allow** and **Live Grant** sorted by expiry, toggle **Destructive commands** and **Network after a secret** guards, or revoke individual permissions on the spot.

---

### 🛑 Pause with Lockdown or Permanently Revoke

![Revoke all and lockdown confirmation dialog](docs/media/revoke.png)

Full control when you need to hit the brakes:
- **Lockdown** — Temporarily blocks all agent calls and pauses active grants; click **End lockdown** to restore them.
- **Revoke all** — Permanently clears all active grants and session allows without locking down.
- **Revoke & lockdown** — Permanently clears all grants *and* blocks every agent until you end lockdown (`⌃⌥⌘L`).

---

### 🧩 Skills, Plugins & MCP per Agent

Browse and filter **Skills**, **Plugins**, and **MCP Servers** across **Claude Code**, **Antigravity**, **Cursor**, **Codex**, **Gemini CLI**, and **Hermes**, with per-agent skill usage counts.

---

### 🎨 Light, Dark & Custom Palettes

![Appearance settings showing Light mode, palettes, contrast and transparency](docs/media/appearance.png)

System, Light, or Dark mode with 6 built-in palettes (**Plain**, **Leash**, **Signal**, **Clear**, **Watch**, **Lock**) plus adjustable contrast, transparency, and density.

---

## How it hooks in

```mermaid
flowchart TB
  subgraph gate ["Blocks the tool call"]
    direction TB
    antigravity["Antigravity<br>PreToolUse"]
    claude["Claude<br>PreToolUse"]
    codex["Codex<br>PreToolUse"]
    cursor["Cursor<br>preToolUse · beforeReadFile<br>beforeShellExecution · beforeMCPExecution"]
    gemini["Gemini CLI<br>BeforeTool"]
    hermes["Hermes<br>pre_tool_call"]
    hook["leash-hook<br>fail closed"]
    broker["Broker"]
    rules["Secure Areas · Guards<br>Session Allows · Lockdown"]
    popup["Approval popup"]
    allow["Allow"]
    deny["Deny"]
    antigravity --> hook
    claude --> hook
    codex --> hook
    cursor --> hook
    gemini --> hook
    hermes --> hook
    hook --> broker --> rules
    rules --> allow
    rules --> deny
    rules --> popup
    popup --> allow
    popup --> deny
  end

  subgraph record ["Records what happened"]
    direction TB
    es["System Events<br>eslogger (macOS)"]
    helper["Activity Helper Daemon"]
    db[("history.db<br>writes, diffs, secret scans")]
    ui["Live · History · Secure Areas"]
    es --> helper --> db --> ui
  end

  rules -.-> ui

  classDef antigravity fill:#1e293b,stroke:#38bdf8,color:#fff
  classDef claude fill:#4a2c1a,stroke:#e8a87c,color:#fff
  classDef cursor fill:#1a2744,stroke:#7eb6ff,color:#fff
  classDef codex fill:#1a3324,stroke:#7dcea0,color:#fff
  classDef gemini fill:#2a1a3a,stroke:#d7a3ff,color:#fff
  classDef hermes fill:#3a2a14,stroke:#f0c36a,color:#fff
  classDef core fill:#3a1214,stroke:#ff8a7a,color:#fff
  classDef ok fill:#12301c,stroke:#86efac,color:#fff
  classDef no fill:#3f1515,stroke:#fca5a5,color:#fff
  classDef watch fill:#12182e,stroke:#a5b4fc,color:#fff
  class antigravity antigravity
  class claude claude
  class cursor cursor
  class codex codex
  class gemini gemini
  class hermes hermes
  class hook,broker,rules,popup core
  class allow ok
  class deny no
  class es,helper,db,ui watch
```

Setup installs the hook into each enabled agent and walks you through **Secure Areas**. Calls outside Secure Areas are allowed and logged; `Ask` Secure Areas, destructive commands, and network calls after a secret pause on the approval popup; `Block` Secure Areas and Lockdown deny immediately.

Separately, the system activity helper tails macOS `eslogger` streams, deduplicates hook/filesystem writes, collapses recursive scans, and writes structured activity into `history.db` (90-day retention for sensitive rows, 14-day retention for ordinary activity, 500 MB cap).

---

## Build from source

Requires Node 24 and pnpm 12 on macOS.

```bash
pnpm install
pnpm dev
```

| Command | What it does |
| --- | --- |
| `pnpm test` | Runs the unit tests |
| `pnpm test:e2e` | Builds the app and runs the Playwright tests |
| `pnpm dist` | Builds the signed macOS installer into `dist/` |

### Capturing marketing screenshots

```bash
pnpm build
SCREENSHOTS=1 pnpm exec playwright test tests/e2e/marketing.e2e.ts -g "marketing screenshots"
```

## License

[MIT](LICENSE). Code copied from other projects keeps its own license, listed in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
