# Terminal Path Link Dialog
ID: terminal-path-link-dialog
Status: APPROVED
Created: 2026-08-05
Approval: User approved `docs/79-terminal-path-link-dialog-implementation-prompt.md` and requested implementation.

## Why

CLI agents print generated files and source locations into terminal output, but CC-Panes currently leaves those paths as inert text. Users must select and copy a path, navigate to the file browser, and locate it manually. This change connects terminal output to the existing editor and desktop file actions while treating terminal text as untrusted input. The repository has no `STRATEGY.md`; the governing constraints are the layered frontend service architecture, session-bound terminal backend, and filesystem boundary rules in `AGENTS.md` and `CLAUDE.md`.

## What changes

- Detect project-local file and directory paths in xterm output, including `:line[:column]` suffixes and OSC 8 `file://` links.
- Open a Radix Dialog before any filesystem or system action.
- Offer in-app editor, default application, file-manager reveal, and copy actions according to target type and runtime.
- Resolve and authorize every path against the originating terminal session's backend-owned project root.
- Focus Monaco at the requested line and column.
- Support local desktop, host-resolvable WSL paths, and Web editor/copy actions; reject SSH paths.

## Out of scope

- Mapping WSL POSIX absolute paths such as `/home/user/repo/a.ts` to host UNC paths.
- Accessing SSH remote filesystems or downloading remote targets.
- Joining paths split by explicit hard newlines.
- Adding plain-text HTTP URL detection or `@xterm/addon-web-links`.
- Opening project-external absolute paths, nonexistent targets, virtual files, globs, sockets, devices, or named pipes.
- Refactoring unrelated terminal lifecycle, renderer, PTY, editor-tab, or Dialog infrastructure.

## Risks

- Malicious terminal output could attempt path traversal, symlink escape, URI injection, visual spoofing, or resource exhaustion.
- xterm buffer indices differ from JavaScript string indices for wide and combining characters.
- Async resolution can race with later clicks, dialog close, session exit, or file replacement.
- Local, daemon, Web, WSL, and SSH sessions expose different filesystem capabilities.

## Success criteria

- Project-local absolute and relative paths open one Dialog and expose the correct actions for file, directory, desktop, and Web contexts.
- `src/App.tsx:12:8` opens the existing editor, focuses line 12 column 8, and works when the file tab is already open.
- At least 12 accepted and 12 rejected parser cases pass, including CJK/wide-cell range mapping and soft wrapping.
- Project-external absolute paths, `..` escapes, symlink escapes, unsupported schemes, SSH paths, and closed sessions have green rejection tests.
- Each xterm registers one provider and disposes it during the existing cleanup lifecycle.
- Frontend components and stores make no direct Tauri `invoke()` calls.
- Focused frontend and Rust tests, TypeScript checking, frontend build, formatting, and workspace checks produce recorded results.

