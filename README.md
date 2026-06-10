# CC-Panes

> A Claude Code first, multi-agent workspace for running parallel coding sessions side by side.

[![Latest Release](https://img.shields.io/github/v/release/wuxiran/cc-pane?display_name=tag&sort=semver)](https://github.com/wuxiran/cc-pane/releases/latest)
[![CI](https://github.com/wuxiran/cc-pane/actions/workflows/ci.yml/badge.svg)](https://github.com/wuxiran/cc-pane/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev/)
[![Rust](https://img.shields.io/badge/Rust-1.83+-000000?logo=rust)](https://www.rust-lang.org/)

[Download](https://github.com/wuxiran/cc-pane/releases/latest) · [中文文档](README.zh-CN.md) · [📖 User Guide](docs/guide/README.md) · [Report an Issue](https://github.com/wuxiran/cc-pane/issues)

<p align="center">
  <img src="docs/assets/images/current-ui.png" alt="CC-Panes dark workspace with project sidebar and terminal panes" width="920" />
</p>

CC-Panes is a desktop control center for AI coding work. It keeps projects, terminals, launch profiles, providers, todos, file browsing, Git status, local history, and session resume in one place so you can drive several coding agents without losing the thread.

It is built around Claude Code, with adapters for Codex, Gemini, Kimi, GLM, OpenCode, Cursor, and provider profiles that can be selected at launch time.

## What It Helps With

- Run multiple AI coding sessions in a split-pane terminal layout.
- Keep workspaces, projects, tasks, todos, and launch history organized.
- Resume previous Claude/Codex/Gemini sessions from the app instead of hunting through shells.
- Switch providers, config profiles, runtimes, and skill policies per launch.
- Inspect files, edit code, compare local history, and manage Git without leaving the workspace.
- Capture screenshots, use voice input, receive notifications, and keep long-running work visible.

## Screenshots

| Multi-pane workspace | Focused terminal workspace |
| --- | --- |
| <img src="docs/assets/images/screenshot-new-ui.png" alt="CC-Panes multi-pane terminal layout" width="440" /> | <img src="docs/assets/images/screenshot-panel.png" alt="CC-Panes terminal panel view" width="440" /> |

| Todo and task planning | Light workspace view |
| --- | --- |
| <img src="docs/assets/images/screenshot-todolist.png" alt="CC-Panes todo and task panel" width="440" /> | <img src="docs/assets/images/screenshot-main.png" alt="CC-Panes light workspace" width="440" /> |

## Highlights

**Parallel Terminals**

- Flexible split panes and tabbed terminals backed by xterm.js and portable-pty.
- Launch Claude Code, Codex, Gemini, Kimi, GLM, OpenCode, and Cursor sessions.
- Resume historical sessions and keep launch history attached to projects.
- Built-in terminal input tools, paste handling, clipboard support, and terminal diagnostics.

**Workspaces And Projects**

- Workspace and project sidebar with pin, hide, reorder, scan, import, and create flows.
- Per-project metadata, launch history, tasks, todos, and MCP configuration.
- Project file browser with create, rename, delete, copy, move, search, and editor open.
- Monaco editor with Markdown preview and image preview.

**Launch Profiles And Providers**

- Launch profiles for repeatable CLI, runtime, provider, skill, and environment choices.
- Provider support for Anthropic, Bedrock, Vertex, OpenAI-compatible proxies, Gemini, Kimi, GLM, OpenCode, Cursor, and local config profiles.
- Launch-time provider selection modes for inheriting, selecting explicitly, or running without provider injection.
- Bundled Claude Code commands, agents, hooks, and CC-Panes skills for orchestrated workflows.

**Git, History, And Review**

- Git branch status, fetch, pull, push, stash, clone, and worktree helpers.
- Branch-aware local history snapshots with labels and diff view.
- File version recovery tools for comparing and restoring local edits.

**Desktop Workflow**

- Dev and release build isolation for data directories, identifiers, shortcuts, and window titles.
- Global screenshot shortcut with region capture and multi-monitor support.
- Tray behavior, notifications, voice input, mini view, fullscreen focus, and configurable shortcuts.
- Cross-platform packages for Windows, macOS, and Linux.

## Download

Prebuilt installers are published on the [latest release page](https://github.com/wuxiran/cc-pane/releases/latest).

- Windows: `*_x64-setup.exe` or `*_arm64-setup.exe`
- macOS: `*_aarch64.dmg` or `*_x64.dmg`
- Linux: `*_amd64.deb` or `*_amd64.AppImage`

## Quick Start From Source

### Prerequisites

- Node.js 22+
- Rust 1.83+
- Platform-specific [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/)
- Claude Code, Codex, Gemini, or other CLI tools you want to launch from CC-Panes

### Install And Run

```bash
git clone https://github.com/wuxiran/cc-pane.git
cd cc-pane
npm install
npm run tauri:dev
```

The development build uses `src-tauri/tauri.dev.conf.json` and stores data under `~/.cc-panes-dev/`.

## Build

Build the frontend only:

```bash
npm run build
```

Build the production desktop app:

```bash
cargo build -p cc-panes-cli-hook --release
node scripts/copy-hook.cjs
npm run tauri build
```

## Checks

Frontend:

```bash
npx tsc --noEmit
npm run test:run
```

Rust:

```bash
cargo fmt --all -- --check
cargo check --workspace
cargo clippy --workspace -- -D warnings
cargo test --workspace
```

## Architecture

CC-Panes uses a layered desktop architecture:

```text
React component
  -> Zustand store
  -> frontend service
  -> Tauri IPC command
  -> Rust service
  -> repository
  -> SQLite / file system / PTY
```

| Layer | Technology | Purpose |
| --- | --- | --- |
| Desktop | Tauri 2 | Rust backend with system WebView |
| Frontend | React 19, TypeScript 5.6, Vite 6 | Application UI |
| State | Zustand 5, Immer | Predictable state updates |
| UI | shadcn/ui, Radix UI, Tailwind CSS 4 | Components and styling |
| Terminal | xterm.js, portable-pty | Terminal rendering and PTY management |
| Storage | SQLite, rusqlite | Local persistence |
| Testing | Vitest, jsdom, Rust tests | Frontend and backend verification |

## Repository Layout

```text
cc-pane/
├── web/                  # React frontend
│   ├── components/       # UI, panes, sidebar, settings
│   ├── stores/           # Zustand stores
│   ├── services/         # Tauri invoke wrappers
│   ├── hooks/            # React hooks
│   ├── types/            # TypeScript types
│   └── i18n/             # Translations
├── src-tauri/            # Tauri app entry, commands, services, repositories
├── cc-panes-core/        # Framework-independent core logic
├── cc-panes-api/         # HTTP/WebSocket API adapter
├── cc-panes-web/         # Web terminal server
├── cc-cli-adapters/      # Claude/Codex/Gemini/etc adapter layer
├── cc-memory/            # Local memory system
├── cc-memory-mcp/        # Memory MCP server
├── cc-notify/            # Notification crate
├── docs/                 # Documentation and screenshots
└── scripts/              # Build and utility scripts
```

Frontend imports use the `@/` alias, which resolves to `web/`.

## Development Notes

Dev and release builds are intentionally isolated:

| | Dev | Release |
| --- | --- | --- |
| Command | `npm run tauri:dev` | `npm run tauri build` |
| Data directory | `~/.cc-panes-dev/` | `~/.cc-panes/` |
| Identifier | `com.ccpanes.dev` | `com.ccpanes.app` |
| Window title | `CC-Panes [DEV]` | `CC-Panes` |
| Screenshot shortcut | `Ctrl+Alt+Shift+S` | `Ctrl+Shift+S` |

When behavior depends on the Windows desktop host, validate on Windows. WSL or Linux checks are useful for code and preflight verification, but they do not prove WebView2, tray, global shortcut, screenshot, updater, installer, or Windows PTY behavior.

## Feedback

- GitHub Issues: <https://github.com/wuxiran/cc-pane/issues>
- GitHub Discussions: <https://github.com/wuxiran/cc-pane/discussions>

WeChat chat group:

Add WeChat `yemaofeng66` and mention `CC-Panes chat`.

Bug feedback group:

<p>
  <img src="docs/assets/images/wechat-bug-feedback.png" alt="CC-Panes Bug Feedback WeChat" width="220" />
</p>

Add WeChat `yemaofeng66` and mention `CC-Panes bug feedback`.

## Contributing

Contributions are welcome. Please open an issue before large changes so the scope and design can be discussed.

Commit messages follow Conventional Commits:

```text
feat: add launch profile import
fix: repair Windows PTY resize handling
docs: update README screenshots
```

## License

CC-Panes is licensed under [GPL-3.0](LICENSE).

## Acknowledgments

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- [Tauri](https://tauri.app/)
- [xterm.js](https://xtermjs.org/)
- [portable-pty](https://github.com/wez/wezterm/tree/main/pty)
- [Allotment](https://github.com/johnwalley/allotment)
- [shadcn/ui](https://ui.shadcn.com/)
