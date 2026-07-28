# Contributing to CC-Panes

Thank you for your interest in contributing to CC-Panes! This guide will help you get started.

## Table of Contents

- [Development Environment](#development-environment)
- [Dev / Release Isolation](#dev--release-isolation)
- [Project Structure](#project-structure)
- [Coding Standards](#coding-standards)
- [Commit Message Format](#commit-message-format)
- [Pull Request Process](#pull-request-process)
- [Reporting Bugs](#reporting-bugs)
- [Feature Requests](#feature-requests)

## Development Environment

### Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 22+ | JavaScript runtime |
| Rust | 1.83+ | Backend toolchain |
| npm | 10+ | Package manager (bundled with Node.js) |

You also need the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform (e.g., WebView2 on Windows, webkit2gtk on Linux).

To actually launch sessions from CC-Panes you also need at least one of the CLI tools it drives: Claude Code, Codex, Gemini, or another supported CLI.

### Setup

```bash
# Clone the repository
git clone https://github.com/wuxiran/cc-pane.git
cd cc-pane

# Install frontend dependencies
npm install

# Start in development mode (frontend + Rust backend)
npm run tauri:dev
```

`npm run tauri:dev` is the recommended default: it applies `src-tauri/tauri.dev.conf.json`, so the dev build gets its own identifier and stores data under `~/.cc-panes-dev/` instead of colliding with an installed release. Plain `npm run tauri dev` runs without that isolation.

### Build

```bash
npm run build          # frontend only
npm run tauri build    # production desktop app (runs frontend + helper binaries + resource copy)
```

### Useful Commands

```bash
# Frontend type checking
npx tsc --noEmit

# Frontend tests
npm run test:run

# Rust checks
cargo check --workspace
cargo clippy --workspace -- -D warnings
cargo fmt --all -- --check

# Rust tests
cargo test --workspace

# Build the application
npm run tauri build
```

### WSL Native Development

When developing inside WSL, you can force the built-in terminal into WSL native mode:

```bash
CCPANES_TERMINAL_BACKEND=wsl npm run tauri:dev
```

The built-in terminal then runs the default WSL shell directly, which is convenient for developing and debugging against a Linux toolchain.

## Dev / Release Isolation

Dev and release builds are intentionally isolated, so both can run at the same time without interfering:

| | Dev | Release |
| --- | --- | --- |
| Command | `npm run tauri:dev` | `npm run tauri build` |
| Data directory | `~/.cc-panes-dev/` | `~/.cc-panes/` |
| Identifier | `com.ccpanes.dev` | `com.ccpanes.app` |
| Window title | `CC-Panes [DEV]` | `CC-Panes` |
| Screenshot shortcut | `Ctrl+Alt+Shift+S` | `Ctrl+Shift+S` |

When behavior depends on the Windows desktop host, validate on Windows. WSL or Linux checks are useful for code and preflight verification, but they do not prove WebView2, tray, global shortcut, screenshot, updater, installer, or Windows PTY behavior.

## Project Structure

CC-Panes follows a layered architecture:

```
React Component -> Zustand Store -> Service (invoke) -> Tauri IPC -> Command -> Service -> Repository -> SQLite/FS
```

- **Frontend** (`web/`): React 19 + TypeScript + Zustand + shadcn/ui
- **Backend** (`src-tauri/src/`): Rust with Command -> Service -> Repository layers

### Technology Stack

| Layer | Technology | Purpose |
| --- | --- | --- |
| Desktop | Tauri 2 | Rust backend with system WebView |
| Frontend | React 19, TypeScript 5.6, Vite 6 | Application UI |
| State | Zustand 5, Immer | Predictable state updates |
| UI | shadcn/ui, Radix UI, Tailwind CSS 4 | Components and styling |
| Terminal | xterm.js, portable-pty | Terminal rendering and PTY management |
| Storage | SQLite, rusqlite | Local persistence |
| Testing | Vitest, jsdom, Rust tests | Frontend and backend verification |

### Repository Layout

```text
cc-pane/
├── web/                  # React frontend (components, stores, services, hooks, types, i18n)
├── src-tauri/            # Tauri app entry, commands, services, repositories
├── cc-panes-core/        # Framework-independent core logic
├── cc-panes-api/         # HTTP/WebSocket API adapter
├── cc-panes-web/         # Web terminal server
├── cc-panes-daemon/      # Standalone PTY host (multi-device session sharing)
├── cc-cli-adapters/      # Claude/Codex/Gemini/etc adapter layer
├── cc-panes-mobile/      # Flutter Android mirror client
├── docs/                 # Documentation and screenshots
└── scripts/              # Build and utility scripts
```

Frontend imports use the `@/` alias, which resolves to `web/`.

For detailed architecture documentation, see [CLAUDE.md](./CLAUDE.md).

## Coding Standards

### General

- Keep files small (< 800 lines) and functions small (< 50 lines)
- Prefer immutable data patterns -- never mutate existing objects
- Handle errors explicitly; never silently swallow them
- Validate inputs at system boundaries

### TypeScript (Frontend)

- Use **functional components + Hooks** (no class components)
- Use **Zustand + Immer** for immutable state updates (`set((state) => { state.x = y })`)
- Wrap all `invoke()` calls in a **Service layer** -- components must not call Tauri APIs directly
- Use the `@/` path alias (maps to `web/`)
- Place test files next to the implementation file (`*.test.ts`)

### Rust (Backend)

- Use **`AppResult<T>`** (`Result<T, AppError>`) for unified error handling
- Inject services via `State<'_, Arc<XxxService>>`
- Follow the **Command -> Service -> Repository** layered separation of concerns
- Use in-memory SQLite (`:memory:`) for tests

### New Feature Workflow (7 Steps)

1. **Model**: `src-tauri/src/models/` (Rust) + `web/types/` (TS)
2. **Repository**: `src-tauri/src/repository/`
3. **Service (Rust)**: `src-tauri/src/services/`
4. **Command**: `src-tauri/src/commands/` + register in `lib.rs` invoke_handler
5. **Service (TS)**: `web/services/`
6. **Store**: `web/stores/` (Zustand + Immer)
7. **Component**: `web/components/`

## Commit Message Format

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <description>

[optional body]
```

### Types

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

### Examples

```
feat: add workspace export functionality
fix: resolve terminal resize issue on Windows
refactor: extract pane tree helpers into separate module
docs: update development setup instructions
```

## Pull Request Process

Contributions are welcome. Please open an issue before large changes so the scope and design can be discussed.

1. **Fork** the repository and create a feature branch from `main`.
2. **Implement** your changes following the coding standards above.
3. **Test** your changes:
   - Run `npx tsc --noEmit` (frontend type check)
   - Run `npm run test:run` (frontend tests)
   - Run `cargo check --workspace` and `cargo clippy --workspace -- -D warnings` (Rust checks)
   - Run `cargo test --workspace` (Rust tests)
4. **Commit** with a clear, conventional commit message.
5. **Open a Pull Request** against `main` with:
   - A concise title (< 70 characters)
   - A summary of what changed and why
   - A test plan describing how the changes were verified
6. **Address feedback** from code review promptly.

### PR Checklist

- [ ] Code follows the project's coding standards
- [ ] All existing tests pass
- [ ] New tests added for new functionality
- [ ] TypeScript check passes (`npx tsc --noEmit`)
- [ ] Rust clippy passes (`cargo clippy --workspace -- -D warnings`)
- [ ] Commit messages follow Conventional Commits format

## Reporting Bugs

Please [open an issue](https://github.com/wuxiran/cc-pane/issues/new) with:

- **Title**: A clear, concise description of the bug
- **Environment**: OS, OS version, app version
- **Steps to reproduce**: Numbered steps to trigger the bug
- **Expected behavior**: What you expected to happen
- **Actual behavior**: What actually happened
- **Screenshots/Logs**: If applicable, attach screenshots or relevant log output

## Feature Requests

We welcome feature suggestions! Please [open an issue](https://github.com/wuxiran/cc-pane/issues/new) with:

- **Title**: A short description of the feature
- **Problem**: What problem does this feature solve?
- **Proposed solution**: How you envision the feature working
- **Alternatives considered**: Any alternative approaches you thought of

## License

By contributing to CC-Panes, you agree that your contributions will be licensed under the [GPL-3.0 License](./LICENSE).
