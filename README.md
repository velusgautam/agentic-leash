<p align="center">
  <img src="docs/media/banner.png" alt="Agentic Leash. Your AI agents. On a leash." />
</p>

<h1 align="center">Agentic Leash</h1>

<p align="center">See and control what AI coding agents can touch on your Mac.</p>

<p align="center">
  <a href="https://github.com/velusgautam/agentic-leash/releases/latest"><img src="https://img.shields.io/github/v/release/velusgautam/agentic-leash?label=release" alt="Latest release" /></a>
  <a href="https://github.com/velusgautam/agentic-leash/releases"><img src="https://img.shields.io/github/downloads/velusgautam/agentic-leash/total" alt="Downloads" /></a>
  <a href="https://github.com/velusgautam/agentic-leash/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/velusgautam/agentic-leash/ci.yml?label=ci" alt="CI" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20(Apple%20Silicon)-black" alt="Platform: macOS on Apple Silicon" />
  <a href="LICENSE"><img src="https://img.shields.io/github/license/velusgautam/agentic-leash" alt="MIT License" /></a>
</p>

<p align="center">
  <a href="#download">Download</a> ·
  <a href="#features">Features</a> ·
  <a href="#how-it-hooks-in">How it works</a> ·
  <a href="#build-from-source">Build from source</a> ·
  <a href="https://github.com/velusgautam/agentic-leash/releases">Changelog</a>
</p>

Claude, Cursor, Codex, Gemini CLI and Hermes keep working. Agentic Leash watches the files they read and write, asks before they reach a folder you have not allowed, and flags sensitive paths like `~/.ssh` the moment they are touched.

## Download

Install from the terminal on macOS (Apple Silicon) or Linux (x64):

```bash
curl -fsSL https://github.com/velusgautam/agentic-leash/releases/latest/download/install.sh | bash
```

Or get the installer for your platform from the [latest release](https://github.com/velusgautam/agentic-leash/releases/latest).

| Platform | Installer | Status |
| --- | --- | --- |
| macOS, Apple Silicon | `.dmg`, signed and notarized | Supported |
| Windows x64 | `.exe` | Preview |
| Linux x64 | `.AppImage` | Preview |

On Windows and Linux, approvals and grants work, but the file-activity history does not. It relies on macOS `eslogger`.

Release notes for every version are on the [releases page](https://github.com/velusgautam/agentic-leash/releases).

## Supported agents

| Agent | Hook events |
| --- | --- |
| Claude (desktop app and `claude` CLI) | `PreToolUse` |
| Codex | `PreToolUse` |
| Cursor | `preToolUse`, `beforeReadFile`, `beforeShellExecution`, `beforeMCPExecution` |
| Gemini CLI | `BeforeTool` |
| Hermes | `pre_tool_call` |

## Features

### Grants on a timer

![Grants filtered and sorted by expiry](docs/media/grants.png)

A grant can last one call, a session, a day, or forever. The Access page lists every live grant with its time left. Filter the list by agent and sort it by when it was approved or when it expires.

### Revoke, then lock down

![Revoke all confirmation](docs/media/revoke.png)

Revoke a single grant, or revoke every grant at once. Revoke all turns lockdown on, so the next tool call is blocked until you end it.

### Every write keeps its diff

![History with a write diff and the grant that allowed it](docs/media/history-diff.png)

History stores the before and after of each write. Open it later and the diff is still there, next to the grant that allowed the path.

### Sensitive paths turn red

![Live activity with sensitive reads highlighted](docs/media/live-sensitive.png)

Reads of `~/.ssh`, `~/.aws` and other secret paths are marked in red on Live and in History, with a count on the Sensitive filter.

### Ask before a new folder

![Approval popup for a Cursor write to a new folder](docs/media/approval.png)

A tool call outside an existing grant opens this popup. Allow it once, for this session or for today, widen it to the whole folder, or deny it. Never blocks it for good. The same choices are on the Access page while a request is waiting.

### Appearance

![Appearance settings for theme, contrast, transparency and density](docs/media/appearance.png)

System, light, or dark. Contrast, transparency, and density apply across the app.

## How it hooks in

```mermaid
flowchart TB
  subgraph gate ["Blocks the tool call"]
    direction TB
    claude["Claude<br>PreToolUse"]
    codex["Codex<br>PreToolUse"]
    cursor["Cursor<br>preToolUse · beforeReadFile<br>beforeShellExecution · beforeMCPExecution"]
    gemini["Gemini CLI<br>BeforeTool"]
    hermes["Hermes<br>pre_tool_call"]
    hook["leash-hook<br>fail closed"]
    broker["Broker"]
    rules["Grants · TTL · lockdown"]
    popup["Approval popup"]
    allow["Allow"]
    deny["Deny"]
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
    es["eslogger"]
    helper["Root helper"]
    db[("history.db<br>writes, diffs, sensitive flags")]
    ui["Live · History · Grants"]
    es --> helper --> db --> ui
  end

  rules -.-> ui

  classDef claude fill:#4a2c1a,stroke:#e8a87c,color:#fff
  classDef cursor fill:#1a2744,stroke:#7eb6ff,color:#fff
  classDef codex fill:#1a3324,stroke:#7dcea0,color:#fff
  classDef gemini fill:#2a1a3a,stroke:#d7a3ff,color:#fff
  classDef hermes fill:#3a2a14,stroke:#f0c36a,color:#fff
  classDef core fill:#3a1214,stroke:#ff8a7a,color:#fff
  classDef ok fill:#12301c,stroke:#86efac,color:#fff
  classDef no fill:#3f1515,stroke:#fca5a5,color:#fff
  classDef watch fill:#12182e,stroke:#a5b4fc,color:#fff
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

Setup installs the hook into each agent that is turned on. The hook asks the broker before the tool runs. A matching grant that has not expired is allowed. Lockdown denies. Anything else waits on the approval popup.

Separately, a root helper tails `eslogger` and writes file activity into `history.db`, including the before and after of writes and a sensitive flag. Live and History read that database. The grant shown beside a write is the one whose folder covers the path.

## First run

The first open stays on setup until the history helper is running and Full Disk Access is granted. The helper is a root LaunchDaemon, so macOS asks for an administrator password once. Turning an agent off in Settings hides it and removes its hooks.

## Build from source

Needs macOS on Apple Silicon, Node 24 and pnpm 12.

```bash
pnpm install
pnpm dev
```

| Command | What it does |
| --- | --- |
| `pnpm test` | Runs the unit tests |
| `pnpm test:e2e` | Builds the app and runs the Playwright tests against the window |
| `pnpm dist` | Builds the signed macOS installer into `dist/` |
| `pnpm dist:win`, `pnpm dist:linux` | Build the Windows and Linux installers |

In a dev build the helper step in setup reads "Available in the installed app".

### Screenshots

```bash
pnpm build
SCREENSHOTS=1 pnpm exec playwright test tests/e2e/marketing.e2e.ts -g walkthrough
pnpm exec node docs/media/launch/record-stills.mjs
```

The first command builds the app. The second captures the app frames into `docs/media/walkthrough`. The third turns those frames into the banner and the feature images.

## License

[MIT](LICENSE). Code copied from other projects keeps its own license, listed in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
