# CC-Panes

> A local-first desktop workspace for multi-CLI AI development on Windows and beyond.
>
> If `tmux` is the command-line answer to session multiplexing, **CC-Panes** is trying to become the desktop answer for multi-project, multi-pane, multi-model AI coding workflows.

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)
[![Built with Tauri](https://img.shields.io/badge/Built%20with-Tauri%202-FFC131?logo=tauri)](https://v2.tauri.app/)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript)](https://www.typescriptlang.org/)

[简体中文](README.zh-CN.md)

<p align="center">
  <img src="xuexi/cc-pane/docs/assets/images/current-ui.png" alt="CC-Panes main interface" width="980" />
</p>

CC-Panes is more than a split terminal application. It is a desktop workbench that brings together AI coding sessions, project organization, workspace metadata, local history, MCP automation, and cross-terminal collaboration.

## Why CC-Panes

Once AI coding becomes part of daily work, the same pain points appear quickly:

- too many terminal windows, with no stable way to keep important sessions visible
- repeated `cd` and launch steps across multiple repositories and environments
- project folders slowly filling up with tool-specific metadata and caches
- weak collaboration between concurrent CLI sessions
- awkward switching between Windows and WSL workflows

CC-Panes is designed to compress those scattered problems into one structured workspace.

## What Makes It Different

- Workspace-first project organization instead of directly polluting code repositories
- Stable multi-tab, multi-pane terminal layouts with pinning and splitting
- Unified launch entry points for AI coding CLIs
- MCP-exposed terminal and workspace capabilities for AI-driven automation
- Native awareness of mixed Windows and WSL workflows
- Git, files, editor, history, todo, plans, specs, memory, and skills inside one app

## Interface Highlights

### Workspace-first structure

The real code stays where it already lives, while prompts, workspace metadata, workflow docs, and AI context are gathered around it in a dedicated workspace layer. That keeps repositories cleaner and makes cross-project organization easier.

<p align="center">
  <img src="xuexi/cc-pane/docs/assets/images/community/workspace-overview.png" alt="Workspace overview" width="760" />
</p>

Workspaces can also hold AI-readable context such as `CLAUDE.md`:

<p align="center">
  <img src="xuexi/cc-pane/docs/assets/images/community/workspace-claude-md.png" alt="Workspace CLAUDE.md example" width="760" />
</p>

### Pinned tabs and split panes

Tabs are not just disposable shells. They can be pinned, renamed, moved, and split into more stable layouts, which helps protect long-running or high-value sessions.

<p align="center">
  <img src="xuexi/cc-pane/docs/assets/images/community/pin-menu.png" alt="Pinned tab and split menu" width="260" />
</p>

### Unified project launcher

Project menus do more than open folders. They can also act as launch surfaces for common AI coding CLIs, reducing repetitive setup work.

<p align="center">
  <img src="xuexi/cc-pane/docs/assets/images/community/cli-menu.png" alt="Project launcher menu" width="280" />
</p>

### MCP as a core capability

One of the strongest differentiators in CC-Panes is that terminal and workspace actions are exposed as **MCP (Model Context Protocol) capabilities**. AI sessions can inspect session state, write commands to other sessions, create workspaces, import projects, dispatch tasks, and interact with files and panes.

<p align="center">
  <img src="xuexi/cc-pane/docs/assets/images/community/mcp-overview.png" alt="MCP capability overview" width="980" />
</p>

Covered MCP capability areas include:

- task management
- PTY sessions
- workspace management
- todo flows
- task bindings
- file operations
- pane management
- history access

### Plan -> Codex workflow

CC-Panes also fits a multi-agent or team-style pattern where one model plans and another implements. A typical flow is:

- let Claude produce the plan
- use `launch_task` to hand execution to Codex
- monitor and continue the work from another session

That is not just “opening two terminals”; it is a structured planning-to-implementation workflow.

<p align="center">
  <img src="xuexi/cc-pane/docs/assets/images/community/plan-to-codex.png" alt="Plan to Codex workflow" width="760" />
</p>

### WSL-aware development

Many Windows AI coding workflows eventually cross into WSL. CC-Panes treats that as a first-class scenario by keeping Windows paths and WSL path mappings inside the same workspace model.

<p align="center">
  <img src="xuexi/cc-pane/docs/assets/images/community/workspace-wsl.png" alt="Workspace with local and WSL projects" width="520" />
</p>

<p align="center">
  <img src="xuexi/cc-pane/docs/assets/images/community/self-dialogue.png" alt="WSL and model state view" width="760" />
</p>

That makes hybrid workflows much more realistic:

- edit and inspect code inside WSL
- build, run, or debug from Windows
- manage all sessions from one visual workbench

### Todo as part of the workflow

The todo panel is not just a notes list. It supports state, priority, filtering, right-side editing, and tight connections with projects, labels, and active sessions. In practice, it behaves more like a task-dispatch layer for AI-assisted work.

<p align="center">
  <img src="xuexi/cc-pane/docs/assets/images/community/todo-board.png" alt="Todo board" width="980" />
</p>

## Who It Is For

CC-Panes is especially compelling for people who:

- do AI coding on Windows
- manage many terminals and projects at once
- regularly use tools like Claude Code or Codex CLI
- want AI workflows that are reusable, collaborative, and splittable
- care a lot about keeping source repositories clean

## What Stands Out Right Now

- workspace-based organization that avoids polluting real repositories
- unified multi-CLI launch entry points, including WSL-aware scenarios
- pinned multi-pane terminal layouts for session stability
- MCP exposure for cross-terminal collaboration
- a visible Plan -> Codex execution pattern
- todo, specs, skills, and memory features converging into a fuller workflow layer
- unusually strong focus on Windows-first AI terminal workflows

## Where It Can Grow

Based on the current codebase and available materials, the most promising next directions include:

- fuller SSH project support
- stronger remote session recovery
- broader MCP automation capabilities
- more complete team-programming workflows
- more consistent multi-model, multi-tool collaboration

## Supported CLI Tools

The repository already includes a dedicated adapter layer in [`xuexi/cc-pane/cc-cli-adapters/`](xuexi/cc-pane/cc-cli-adapters/) with confirmed adapters for:

- `Claude Code`
- `Codex CLI`
- `Gemini CLI`
- `OpenCode`

Claude Code and Codex currently have the deepest integration paths.

## Core Feature Areas

- multi-pane terminal layouts with drag resizing
- workspace and project organization, including SSH and WSL-aware flows
- launch history and session restore
- Git integration with fetch, pull, push, stash, clone, and worktree support
- file browser, Monaco editor, markdown preview, and image preview
- local history with diff, labels, branch-aware snapshots, and restore
- todo, plans, specs, memory, skills, and workflow artifacts
- hooks, orchestrator services, MCP configuration, and shared MCP support
- tray mode, mini mode, fullscreen, notifications, screenshots, and shortcuts
- English and Simplified Chinese UI

## Architecture

CC-Panes is a small monorepo centered around a Tauri desktop shell:

- `web/`
  React frontend with Zustand stores, xterm.js terminal rendering, Monaco, and Tauri invoke wrappers.
- `src-tauri/`
  Tauri application shell for windows, tray integration, screenshots, updater wiring, and IPC registration.
- `cc-panes-core/`
  Framework-independent business logic for terminals, workspaces, history, providers, hooks, todo, plans, specs, SSH, settings, and MCP-related services.

Supporting Rust crates include:

- `cc-cli-adapters/`
- `cc-memory/`
- `cc-memory-mcp/`
- `cc-panes-api/`
- `cc-panes-web/`
- `cc-panes-hook/`
- `cc-notify/`

## Repository Layout

```text
cc-pane/
|-- web/                 # React frontend
|-- src-tauri/           # Tauri shell and native integrations
|-- cc-panes-core/       # Core domain logic
|-- cc-cli-adapters/     # AI CLI adapters
|-- cc-memory/           # Memory storage
|-- cc-memory-mcp/       # Memory MCP service
|-- cc-panes-api/        # HTTP/WebSocket adapter layer
|-- cc-panes-web/        # Web terminal server
|-- cc-panes-hook/       # Hook binary
|-- cc-notify/           # Notification abstractions
|-- docs/                # Docs and assets
|-- scripts/             # Development helpers
|-- package.json         # Frontend scripts
`-- Cargo.toml           # Rust workspace
```

## Data Model

CC-Panes revolves around a `workspace -> project -> task/session` model.

- release app data lives under `~/.cc-panes/`
- development app data lives under `~/.cc-panes-dev/`
- project-level workflow data lives under `<project>/.ccpanes/`

Common project-level directories include:

- `history/`
- `journal/`
- `plans/`
- `prompts/`
- `specs/`
- `workflow.md`

## Tech Stack

| Layer | Technology |
| --- | --- |
| Desktop shell | Tauri 2 |
| Frontend | React 19 + TypeScript |
| State management | Zustand 5 + Immer |
| Styling | Tailwind CSS 4 |
| UI primitives | shadcn/ui + Radix UI |
| Terminal | xterm.js + portable-pty |
| Editor | Monaco Editor |
| Persistence | SQLite via `rusqlite` |
| Build tooling | Vite 6 |

## Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [Rust](https://rustup.rs/) 1.83+
- Platform-specific dependencies required by [Tauri 2](https://v2.tauri.app/start/prerequisites/)

## Getting Started

```bash
git clone https://github.com/wuxiran/cc-pane.git
cd cc-pane
npm install
npm run tauri:dev
```

To build a desktop package:

```bash
npm run tauri build
```

## Development Commands

```bash
# frontend
npm run tauri:dev
npm run test:run
npx tsc --noEmit

# Rust workspace
cargo check --workspace
cargo test --workspace
cargo clippy --workspace -- -D warnings
cargo fmt --all -- --check
```

## WSL Notes

For Linux-native development inside WSL, prefer cloning into the Linux filesystem instead of `/mnt/c/...` or `/mnt/d/...`:

```bash
./scripts/setup-wsl-dev.sh
```

## Dev/Release Isolation

Development and release builds intentionally use different identifiers and data directories, so they can run side by side without conflicting:

| Mode | App identifier | Data directory |
| --- | --- | --- |
| Dev (`npm run tauri:dev`) | `com.ccpanes.dev` | `~/.cc-panes-dev/` |
| Release (`npm run tauri build`) | `com.ccpanes.app` | `~/.cc-panes/` |

## Docs

[`xuexi/cc-pane/docs/`](xuexi/cc-pane/docs/) contains implementation notes and design documents for major subsystems, including:

- workspace and project foundations
- provider and platform adaptation
- local history
- skill system
- memory system
- GUI evolution and packaging

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](xuexi/cc-pane/CONTRIBUTING.md) for project guidelines.

## License

This project is licensed under the [GNU General Public License v3.0](xuexi/cc-pane/LICENSE).
