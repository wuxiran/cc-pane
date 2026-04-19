# CC-Panes Agent Guide

> Multi-instance split-pane manager for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — a cross-platform desktop app built with Tauri 2.

This document provides essential information for AI coding agents working on the CC-Panes codebase.

## Project Overview

CC-Panes is a desktop application that lets users run multiple Claude Code CLI instances side by side in a split-pane terminal layout. It organizes AI-powered development workflows with workspaces, projects, and tasks — all from a single desktop app.

### Key Features

- **Split-Pane Terminal** — Run multiple terminals in flexible horizontal/vertical split layouts
- **Workspace Management** — Organize projects into workspaces with pinning, hiding, and reordering
- **Built-in Terminal** — Full-featured terminal (xterm.js + PTY) with multi-tab support
- **Claude Code Integration** — Launch Claude Code sessions, resume conversations, manage providers
- **Git Integration** — Branch status, pull/push/fetch/stash, worktree management, git clone
- **Session Management** — Track launch history, clean broken sessions, resume previous work
- **Local History** — File version tracking with diff view, labels, branch-aware snapshots
- **File Browser** — Project file tree with search, create, rename, delete, copy, move operations
- **Code Editor** — Monaco-based editor with 60+ language support, Markdown preview, image preview
- **Screenshot** — Region capture with global shortcut, multi-monitor support
- **MCP Server Config** — Configure MCP servers per project

## Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Desktop Framework | Tauri 2 | Rust backend + system WebView |
| Frontend | React 19 + TypeScript 5.6 | UI components |
| State Management | Zustand 5 + Immer | Immutable state updates |
| UI Library | shadcn/ui + Radix UI | Component library |
| Styling | Tailwind CSS 4 | Utility-first CSS |
| Terminal | xterm.js + portable-pty | Frontend rendering + backend PTY |
| Split Panes | Allotment | Resizable split layout |
| Data Storage | SQLite (rusqlite) | Local persistence |
| Build Tool | Vite 6 | Frontend bundler |
| Testing | Vitest + jsdom | Frontend tests |
| Testing | Built-in Rust test | Backend tests |

## Architecture

### Data Flow

```
React Component → Zustand Store → Service (invoke) → Tauri IPC → Command → Service → Repository → SQLite/FS
```

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

### Workspace Crate Structure

The Rust backend is organized as a Cargo workspace:

| Crate | Purpose |
|-------|---------|
| `src-tauri` | Tauri application entry point, command handlers |
| `cc-panes-core` | Core business logic, framework-independent |
| `cc-panes-api` | HTTP/WebSocket API adapter |
| `cc-panes-web` | Web terminal server for Docker deployment |
| `cc-panes-cli-hook` | Shared CLI hook runner source directory |
| `cc-memory` | Memory system for Claude memories |
| `cc-memory-mcp` | MCP server for memory system |
| `cc-notify` | Push notification system |
| `cc-cli-adapters` | CLI tool adapter layer |

## Project Structure

```
cc-panes/
├── web/                    # React frontend source
│   ├── components/         # React components
│   │   ├── panes/          # Split-pane terminal components
│   │   ├── sidebar/        # Sidebar components
│   │   ├── settings/       # Settings sub-components
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
├── cc-panes-core/          # Core business logic crate
├── cc-panes-api/           # HTTP API adapter crate
├── cc-panes-web/           # Web server for Docker deployment
├── cc-panes-cli-hook/      # Shared CLI hook runner source
├── cc-memory/              # Memory system crate
├── cc-memory-mcp/          # MCP server for memory
├── cc-notify/              # Push notification crate
├── cc-cli-adapters/        # CLI adapters crate
│
├── docs/                   # Architecture documentation
├── .claude/                # Claude Code commands, agents, hooks
└── scripts/                # Build and utility scripts
```

Frontend imports use the `@/` alias, which resolves to `web/`.

## Build and Test Commands

### Prerequisites

- Node.js 22+
- Rust 1.83+
- Platform-specific Tauri 2 dependencies

### Development

```bash
# Install frontend dependencies
npm install

# Run in development mode (frontend + Rust backend)
npm run tauri:dev

# Build frontend only
npm run build

# Build the production app
npm run tauri build
```

### Frontend Testing & Checks

```bash
# TypeScript type check
npx tsc --noEmit

# Run tests
npm run test:run

# Run tests with coverage
npm run test:coverage

# Run tests with UI
npm run test:ui
```

### Rust Testing & Checks

```bash
# Check formatting
cargo fmt --all -- --check

# Build hook binary (required before tauri build)
cargo build -p cc-panes-cli-hook --release
node scripts/copy-hook.cjs

# Cargo check
cargo check --workspace

# Lint (zero warnings policy)
cargo clippy --workspace -- -D warnings

# Run tests
cargo test --workspace
```

## Code Style Guidelines

### TypeScript (Frontend)

- **Functional components + Hooks** — No class components
- **Zustand + Immer** for immutable state updates: `set((state) => { state.x = y })`
- **Service layer** — Wrap all `invoke()` calls in services; components must not call Tauri APIs directly
- **Path alias** — Use `@/` which maps to `web/`
- **Co-located tests** — Place test files next to implementation (`*.test.ts`)
- Keep files under 800 lines, functions under 50 lines
- Handle errors explicitly; never silently swallow them

### Rust (Backend)

- **`AppResult<T>`** — Use `Result<T, AppError>` for unified error handling
- **State injection** — Inject services via `State<'_, Arc<XxxService>>`
- **Layered architecture** — Maintain Command → Service → Repository separation
- **In-memory SQLite** — Use `:memory:` for tests
- Keep files under 800 lines, functions under 50 lines

### Commit Message Format

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <description>

[optional body]
```

| Type | Description |
|------|-------------|
| `feat` | A new feature |
| `fix` | A bug fix |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `docs` | Documentation only changes |
| `test` | Adding or correcting tests |
| `chore` | Maintenance tasks (deps, config, etc.) |
| `perf` | Performance improvements |
| `ci` | CI/CD changes |

## Testing Instructions

### Frontend Tests

- Uses Vitest with jsdom environment
- Tests located in `web/**/*.test.{ts,tsx}`
- Coverage thresholds: 80% for statements, branches, functions, lines
- Tauri APIs are mocked in `web/test/setup.ts`

### Rust Tests

- Uses built-in Rust test framework
- Tests co-located with source files or in `tests/` directories
- In-memory SQLite for repository tests

### Running Full Test Suite

```bash
# Frontend
npm run test:run

# Rust
cargo test --workspace
```

## Dev/Release Isolation

Dev and release builds are fully isolated via `cfg!(debug_assertions)`:

| | Dev (`npm run tauri:dev`) | Release (`npm run tauri build`) |
|---|---|---|
| Data directory | `~/.cc-panes-dev/` | `~/.cc-panes/` |
| Identifier | `com.ccpanes.dev` | `com.ccpanes.app` |
| Window title | CC-Panes [DEV] | CC-Panes |
| Screenshot shortcut | `Ctrl+Alt+Shift+S` | `Ctrl+Shift+S` |

The dev build uses `--config src-tauri/tauri.dev.conf.json` to override settings.

## New Feature Workflow (7 Steps)

1. **Model**: `src-tauri/src/models/` (Rust) + `web/types/` (TS)
2. **Repository**: `src-tauri/src/repository/`
3. **Service (Rust)**: `src-tauri/src/services/`
4. **Command**: `src-tauri/src/commands/` + register in `lib.rs`
5. **Service (TS)**: `web/services/`
6. **Store**: `web/stores/` (Zustand + Immer)
7. **Component**: `web/components/`

## Security Considerations

### CSP Configuration

Content Security Policy is defined in `src-tauri/tauri.conf.json`:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
worker-src 'self' blob:; img-src 'self' asset: http://asset.localhost blob: data:;
connect-src 'self' ipc: http://ipc.localhost http://localhost:* https:
```

### Asset Protocol

Asset protocol is enabled with scope `**` for file access. Be cautious when handling user-provided paths.

### Input Validation

- Validate all inputs at system boundaries
- Use type-safe APIs between frontend and backend
- Sanitize file paths before filesystem operations

### Secrets Management

- Updater public key is embedded in `tauri.conf.json`
- Provider API keys stored in local config files
- No secrets should be committed to the repository

## Repository Environment Boundary

This repository supports development and verification across multiple environments, including WSL, Linux, Windows, and CI.

- When platform behavior matters, separate guidance into `current-environment-verifiable` and `Windows-host-required`.
- Do not claim Windows desktop behavior is verified from WSL or non-Windows environments alone.
- Windows-host-required validation includes: app startup on Windows, WebView2 behavior, tray behavior, global shortcuts, screenshot flow, updater or installer behavior, and Win32 or Windows PTY specifics.
- When working from WSL, prefer editing and preflight checks there, then validate Windows desktop behavior on the Windows host using the same branch or a built installer.

## CI/CD Pipeline

The CI pipeline (`.github/workflows/ci.yml`) runs:

1. **Frontend Check** (Windows)
   - TypeScript type check
   - Build frontend
   - Run tests

2. **Backend Check** (Windows, Ubuntu)
   - Format check
   - Build hook binary
   - Cargo check
   - Clippy lint (zero warnings)
   - Run tests

3. **Tauri Build Check** (Windows, Ubuntu)
   - Full debug build

## Key Files Reference

| File | Purpose |
|------|---------|
| `web/App.tsx` | React root component |
| `web/stores/usePanesStore.ts` | Pane tree state management |
| `src-tauri/src/lib.rs` | Tauri command registration |
| `src-tauri/tauri.conf.json` | Tauri app configuration |
| `Cargo.toml` | Workspace definition |
| `package.json` | Node.js dependencies and scripts |
| `vite.config.ts` | Vite build configuration |
| `vitest.config.ts` | Test configuration |
| `tsconfig.json` | TypeScript configuration |

## Claude Code Integration

This project includes `.claude/` directory with:

- **Commands** in `.claude/commands/ccbook/` — Project-specific slash commands
- **Agents** in `.claude/agents/` — Specialized sub-agents for tasks
- **Hooks** in `.claude/hooks/` — Session lifecycle hooks

These are bundled with the application and installed to user projects.

## License

This project is licensed under the GNU General Public License v3.0 (GPL-3.0).
