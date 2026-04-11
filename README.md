# CC-Panes

> A local-first desktop workspace for AI coding CLIs, designed for multi-project, multi-pane, MCP-driven development on Windows and beyond.

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)
[![Built with Tauri](https://img.shields.io/badge/Built%20with-Tauri%202-FFC131?logo=tauri)](https://v2.tauri.app/)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript)](https://www.typescriptlang.org/)

[简体中文](README.zh-CN.md)

<p align="center">
  <img src="docs/assets/images/current-ui.png" alt="CC-Panes main interface" width="980" />
</p>

CC-Panes is not just a split terminal app. It is a desktop workbench for organizing AI coding sessions, projects, workspace metadata, local history, MCP automation, and cross-terminal collaboration in one place.

## Why CC-Panes

Modern AI-assisted development often breaks down into the same pain points:

- too many terminal windows, with no stable way to keep important sessions in view
- repeated `cd` and launch steps across multiple repositories and environments
- project folders slowly filling up with tool-specific metadata and temporary files
- weak collaboration between concurrent CLI sessions
- awkward Windows and WSL switching for mixed local and Linux-native workflows

CC-Panes addresses those issues with a workspace-first design, multi-pane terminals, pinned tabs, project tools, and MCP-powered orchestration.

## What Makes It Different

- Workspace-first project organization that helps keep source repositories clean
- Multi-pane terminal layouts with tab pinning, splitting, and session recovery
- Built-in launcher flows for supported AI coding CLIs
- MCP-exposed terminal and workspace capabilities for AI-driven automation
- WSL-aware project handling for mixed Windows and Linux development
- Git, file browser, editor, local history, journal, todo, plans, specs, memories, and skills in one app

## Interface Highlights

### Workspace-first structure

Keep the real code where it belongs, and place workspace metadata, prompts, docs, and automation context around it.

<p align="center">
  <img src="docs/assets/images/community/workspace-overview.png" alt="Workspace overview" width="760" />
</p>

Workspace metadata can also include AI-readable context such as `CLAUDE.md`:

<p align="center">
  <img src="docs/assets/images/community/workspace-claude-md.png" alt="Workspace CLAUDE.md example" width="760" />
</p>

### Pinned tabs and split panes

Important sessions can be pinned, renamed, moved, or split into stable layouts so they are less likely to get lost in a busy workflow.

<p align="center">
  <img src="docs/assets/images/community/pin-menu.png" alt="Pinned tab menu" width="260" />
</p>

### Project launcher experience

Projects can expose launch actions directly from the workspace UI, reducing repetitive terminal setup work.

<p align="center">
  <img src="docs/assets/images/community/cli-menu.png" alt="Project launcher menu" width="280" />
</p>

### MCP-powered operations

CC-Panes exposes terminal and workspace actions through MCP-oriented services, making it possible to inspect sessions, write to them, launch tasks, manage todos, and work with open files programmatically.

<p align="center">
  <img src="docs/assets/images/community/mcp-overview.png" alt="MCP capability overview" width="980" />
</p>

### Plan-to-implementation workflows

The workflow can bridge planning and execution across tools and panes, for example by using one session to plan and another to implement.

<p align="center">
  <img src="docs/assets/images/community/plan-to-codex.png" alt="Plan to Codex workflow" width="760" />
</p>

### WSL-aware workspaces

Local and WSL projects can live under the same workspace, which is especially helpful for Windows-first setups that still rely on Linux-native tooling.

<p align="center">
  <img src="docs/assets/images/community/workspace-wsl.png" alt="Workspace with WSL projects" width="520" />
</p>

### Todo as part of the workflow

Todo management is built into the product rather than treated as an external tool, making it easier to connect active sessions, task planning, and project execution.

<p align="center">
  <img src="docs/assets/images/community/todo-board.png" alt="Todo board" width="980" />
</p>

## Supported CLI Tools

The repository currently includes a dedicated adapter layer in [`cc-cli-adapters/`](cc-cli-adapters/) and built-in adapters for:

- `Claude Code`
- `Codex CLI`
- `Gemini CLI`
- `OpenCode`

Among them, Claude Code and Codex currently have the deepest integration paths in the codebase.

## Core Feature Areas

- Split-pane terminal management with drag resizing
- Workspace and project organization, including SSH- and WSL-aware project flows
- Launch history and session restore
- Git integration with fetch, pull, push, stash, clone, and worktree management
- File browser, Monaco editor, markdown preview, and image preview
- Local history with diff, labels, branch-aware snapshots, and restore
- Todo, plans, specs, memory, skills, and project workflow artifacts
- Hooks, orchestrator services, MCP configuration, and shared MCP support
- Tray mode, mini mode, fullscreen, notifications, screenshots, and shortcuts
- English and Simplified Chinese UI

## Architecture

CC-Panes is organized as a small monorepo around a Tauri desktop shell:

- `web/`
  React frontend with Zustand stores, xterm.js, Monaco, and Tauri invoke wrappers.
- `src-tauri/`
  Tauri application shell, native windowing, tray integration, screenshot flow, updater wiring, and IPC registration.
- `cc-panes-core/`
  Framework-independent business logic for terminals, workspaces, local history, providers, hooks, todo, plans, specs, SSH, settings, and MCP-related services.

Supporting crates in the workspace include:

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
|-- cc-memory-mcp/       # Memory MCP server
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

- global app data is stored under `~/.cc-panes/` for release builds
- development builds use `~/.cc-panes-dev/`
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

To build a production desktop package:

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

For native Linux development inside WSL, prefer cloning the repository into the Linux filesystem instead of `/mnt/c/...` or `/mnt/d/...`.

```bash
./scripts/setup-wsl-dev.sh
```

## Dev/Release Isolation

Development and release builds intentionally use different identifiers and data directories.

| Mode | App identifier | Data directory |
| --- | --- | --- |
| Dev (`npm run tauri:dev`) | `com.ccpanes.dev` | `~/.cc-panes-dev/` |
| Release (`npm run tauri build`) | `com.ccpanes.app` | `~/.cc-panes/` |

## Docs

The [`docs/`](docs/) directory contains implementation notes and design documents covering major subsystems such as:

- workspace and project foundations
- provider and platform adaptation
- local history
- skill system
- memory system
- GUI evolution and packaging

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the [GNU General Public License v3.0](LICENSE).
