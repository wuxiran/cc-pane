# CC-Panes

> Multi-instance split-pane manager for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — a cross-platform desktop app built with Tauri 2.

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)
[![Built with Tauri](https://img.shields.io/badge/Built%20with-Tauri%202-FFC131?logo=tauri)](https://v2.tauri.app/)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript)](https://www.typescriptlang.org/)

[中文文档](README.zh-CN.md)

<!--
<p align="center">
  <img src="docs/assets/images/screenshot-main.png" alt="CC-Panes Main Interface" width="800" />
</p>
-->

## Download

Pre-built Windows installer is available on the [GitHub Releases](https://github.com/wuxiran/cc-pane/releases) page. Download the latest `.exe` installer and run it to get started.

> For other platforms, you can [build from source](#getting-started).

## What is CC-Panes?

CC-Panes lets you run **multiple Claude Code CLI instances** side by side in a split-pane terminal layout. Organize your AI-powered development workflow with workspaces, projects, and tasks — all from a single desktop app.

## Features

- **Split-Pane Terminal** — Run multiple terminals in flexible horizontal/vertical split layouts with drag-to-resize
- **Workspace Management** — Organize projects into workspaces with pinning, hiding, and reordering
- **Built-in Terminal** — Full-featured terminal (xterm.js + PTY) with multi-tab support
- **Claude Code Integration** — Launch Claude Code sessions, resume conversations, manage providers, and self-dialogue mode
- **Git Integration** — Branch status, pull/push/fetch/stash, worktree management, and git clone
- **Session Management** — Track launch history with recent launches panel, clean broken sessions, and resume previous work
- **Local History** — File version tracking with diff view, labels, branch-aware snapshots, and restore
- **File Browser** — Project file tree with search, create, rename, delete, copy, and move operations
- **Code Editor** — Monaco-based editor with 60+ language support, Markdown preview, and image preview
- **Quick Search** — Global file search (Ctrl+K) across all workspace projects
- **Screenshot** — Region capture with global shortcut, multi-monitor support, and clipboard copy
- **Session Journal** — Workspace-level session logging
- **Todo & Plans** — Task management with priorities, subtasks, and plan archiving
- **Memory & Skills** — Manage Claude memories and custom skills per project
- **MCP Server Config** — Configure MCP servers per project
- **Hooks/Workflows** — Workspace-level hook system for automation
- **Provider Management** — Multiple API provider support (Anthropic, Bedrock, Vertex, proxy, config profiles)
- **Directory Scan Import** — Batch import Git repositories from a directory
- **Theme Support** — Light/dark mode with glassmorphism design
- **Borderless, Mini & Fullscreen** — Frameless window mode, compact mini view, and F11 fullscreen toggle
- **System Tray** — Minimize to tray with status monitoring
- **Desktop Notifications** — Session exit, waiting-for-input, and todo reminder alerts with debounce
- **Keyboard Shortcuts** — Customizable shortcuts for all major actions
- **i18n** — English and Chinese (Simplified) interface

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  React Frontend                                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐  │
│  │ Sidebar  │ │ Panes    │ │ Panels   │ │ UI Components │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └───────────────┘  │
│       │             │            │                           │
│  ┌────┴─────────────┴────────────┴────┐                     │
│  │  Services (invoke) + Stores        │                     │
│  └────────────────┬───────────────────┘                     │
├───────────────────┼─────────────────────────────────────────┤
│  Tauri IPC        │                                         │
├───────────────────┼─────────────────────────────────────────┤
│  Rust Backend     │                                         │
│  ┌────────────────┴───────────────────┐                     │
│  │  Commands → Services → Repository  │                     │
│  └────────────────┬───────────────────┘                     │
│  ┌────────────────┴───────────────────┐                     │
│  │  SQLite / File System / PTY        │                     │
│  └────────────────────────────────────┘                     │
└─────────────────────────────────────────────────────────────┘
```

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Desktop Framework | Tauri 2 | Rust backend + system WebView |
| Frontend | React 19 + TypeScript | UI components |
| State Management | Zustand 5 + Immer | Immutable state updates |
| UI Library | shadcn/ui + Radix UI | Component library |
| Styling | Tailwind CSS 4 | Utility-first CSS |
| Terminal | xterm.js + portable-pty | Frontend rendering + backend PTY |
| Split Panes | Allotment | Resizable split layout |
| Data Storage | SQLite (rusqlite) | Local persistence |
| Icons | Lucide React | SVG icons |
| Build Tool | Vite 6 | Frontend bundler |

## Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [Rust](https://rustup.rs/) 1.83+
- Platform-specific dependencies for [Tauri](https://v2.tauri.app/start/prerequisites/)

## Getting Started

```bash
# Clone the repository
git clone https://github.com/wuxiran/cc-pane.git
cd cc-pane

# Install frontend dependencies
npm install

# Run in development mode (frontend + Rust backend)
npm run tauri:dev
```

## Build

```bash
# Build the production app
npm run tauri build
```

The built application will be in `src-tauri/target/release/bundle/`.

## Development

```bash
# Frontend type check
npx tsc --noEmit

# Run frontend tests
npm run test:run

# Rust check
cargo check --workspace

# Rust lint
cargo clippy --workspace -- -D warnings

# Rust format check
cargo fmt --all -- --check

# Run Rust tests
cargo test --workspace
```

### Dev/Release Isolation

Dev and release builds are fully isolated via `cfg!(debug_assertions)` and can run simultaneously:

| | Dev (`npm run tauri:dev`) | Release (`npm run tauri build`) |
|---|---|---|
| Data directory | `~/.cc-panes-dev/` | `~/.cc-panes/` |
| Identifier | `com.ccpanes.dev` | `com.ccpanes.app` |
| Window title | CC-Panes [DEV] | CC-Panes |

## Project Structure

```
cc-panes/
├── web/                    # React frontend source
│   ├── components/         # React components
│   │   ├── panes/          # Split-pane terminal components
│   │   ├── sidebar/        # Sidebar components
│   │   ├── providers/      # Provider management UI
│   │   └── ui/             # shadcn/ui base components
│   ├── stores/             # Zustand state management
│   ├── services/           # Frontend service layer (invoke wrappers)
│   ├── hooks/              # Custom React hooks
│   ├── types/              # TypeScript type definitions
│   ├── i18n/               # Internationalization
│   ├── lib/                # Shared frontend helpers
│   └── utils/              # Utility functions
│
├── src-tauri/              # Tauri Rust backend
│   └── src/
│       ├── commands/        # Tauri IPC command handlers
│       ├── services/        # Business logic layer
│       ├── repository/      # Data access layer (SQLite)
│       ├── models/          # Data models
│       └── utils/           # Utilities (AppPaths, AppError)
│
├── cc-panes-*/             # Shared Rust workspace crates
└── docs/                   # Architecture docs, examples, and assets
```

Frontend imports use the `@/` alias, which resolves to `web/`.

<!--
## Screenshots

<details>
<summary>More screenshots</summary>

| Split Pane Layout | Panel View |
|:-:|:-:|
| ![Split Pane](docs/assets/images/screenshot-no-layout.png) | ![Panel](docs/assets/images/screenshot-panel.png) |

| Todo List | New UI |
|:-:|:-:|
| ![Todo](docs/assets/images/screenshot-todolist.png) | ![New UI](docs/assets/images/screenshot-new-ui.png) |

</details>
-->

## Feedback

Found a bug or have a suggestion? Join the WeChat group:

<img src="docs/assets/images/wechat-group.png" alt="WeChat Group: cc-pane" width="200" />

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the [GNU General Public License v3.0](LICENSE).

## Acknowledgments

- [Tauri](https://tauri.app/) — Desktop application framework
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — AI coding assistant by Anthropic
- [xterm.js](https://xtermjs.org/) — Terminal emulator for the web
- [shadcn/ui](https://ui.shadcn.com/) — UI component library
- [LINUX DO](https://linux.do/) — A sincere, friendly, united, and professional ideal community


