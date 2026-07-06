# Changelog

## 0.10.7 - 2026-07-06

### Added

- **CC-Panes Mobile**: new Flutter Android client that mirrors the desktop — workspace/terminal dual-tab home, desktop layout mirroring, and per-project "running on desktop / opened on phone" badges.
- **Terminal session sharing (opt-in)**: PTYs can be hosted by the standalone cc-panes-daemon so desktop, web, and mobile attach to the same live sessions; toggle in Settings → Terminal (off by default, restart required).
- Remote read-only mode for the web UI: non-loopback visitors (including Tailscale Serve-forwarded traffic) can watch terminals and browse state but cannot type, resize, or modify files; an optional "trusted session write" toggle re-enables writes for password-authenticated remote sessions.
- Tailscale remote-access guide in Settings → Web Access: read-only detection of the local tailscale CLI, one-click copy of the `tailscale serve` command and access URL; CC-Panes never runs `tailscale up/serve` for you and stores no credentials.
- Orchestrator listen binding is now configurable (auto / loopback / all interfaces). Auto binds loopback-only by default and only opens all interfaces for WSL setups without mirrored networking.
- Worker reports to a busy leader are now queued by the engine and auto-delivered when the leader becomes idle, so `report_to_leader` notifications are no longer lost mid-generation.
- New `plantocc` skill (dispatch a plan to a Claude Code worker) and `planreview` skill (cross-CLI plan peer review, split out of `plan2codexwsl`, which now focuses on WSL execution specifics).
- cc-chan: window sizes now scale with a configurable pet size, random wandering is a switch (off by default), and custom skins can be dropped into a user pets directory (`pet.json` overrides built-ins).
- Workspace snapshot batch-restore endpoint (`POST /api/workspace-snapshots/restore`) for the web/mobile clients.
- The floating voice-input button can be hidden per settings (the voice shortcut still works).

### Fixed

- Hardened `cc-panes-web --host`: binding a non-loopback address without a configured web password is now refused instead of silently exposing the UI.
- Terminal font chains without a CJK-capable font now get a Chinese fallback appended automatically, fixing overlapped/garbled CJK rendering; glyph atlas rebuilds wait for the requested font and overlapping glyphs are rescaled.
- Tab titles gained twice the usable width: the `#N` badge moved out of the truncation budget and titles now flex-fill (tab max width 180 → 240 px).
- Opening a project or binding a session id now triggers a layout snapshot save, so restores no longer miss freshly opened tabs.

## 0.10.6 - 2026-07-04

### Added

- Added OSC-based in-band session state detection with shell integration, deduplicated against the hook HTTP channel, replacing text-based status guessing.
- Added Windows Job Object management for PTY sessions (`KILL_ON_JOB_CLOSE`), so CLI process trees are cleaned up by the kernel even if the host app crashes.
- OpenCode is now a first-class CLI: the adapter is aligned with Claude/Codex capabilities and `launch_task` orchestration accepts it.
- Added a native Kimi config mode so launch profiles can let Kimi use its own configuration instead of an injected provider.
- New installs now hide the cc-chan pet by default; it can be summoned from the status bar.
- New installs now collapse rarely-used launch actions in the sidebar.

### Fixed

- Workspace/project-bound launch profiles that do not match the target CLI or runtime are now silently dropped in favor of the default profile, instead of triggering a spurious "profile mismatch" warning on every launch.
- Explicitly selected launch profiles that cannot apply to the target CLI/runtime now surface a clear warning instead of silently dropping profile-level settings such as YOLO mode.
- Toggling the cc-chan pet from the status bar or its context menu now persists visibility, so a hidden pet no longer reappears on the next launch.
- Font switching now waits for the requested font to load before rebuilding the glyph atlas, and WebGL glyphs stay crisp on first paint and after font changes.
- Fixed a crash when scanning external skills whose frontmatter mixes CRLF line endings with non-ASCII text (#34).
- Hardened `git clone` credentials: auth headers are scoped to the target host and credentials embedded in URLs are stripped.
- npm shim entry points that are native PE binaries are now executed directly instead of through Node.
- The web runtime only converts Windows paths to `/mnt/` form when actually running inside WSL.
- MCP `close_file` now reuses `open_file` path normalization, so files reliably close on Windows regardless of case or separator differences.
- Fixed unclickable window control buttons on Linux/WebKitGTK frameless title bars.
- Orchestrator launch profiles now initialize adapter option defaults.

### Changed

- Session lists extract the last prompt by streaming Codex JSONL files instead of reading them fully into memory.
- Large test backfill across the frontend and Rust backend (~1,500 new cases); the frontend line-coverage gate was raised to 74%.

## 0.10.5 - 2026-06-27

### Added

- Added a CLI Launchers settings section to override the launch command per CLI tool.

### Fixed

- Fixed launching npm-installed CLIs (OpenCode, Gemini, Kimi, GLM, Cursor) on Windows, where the PTY could not start the `.cmd` shim directly; the shim is now resolved to a direct Node invocation.

## 0.10.4 - 2026-06-26

### Fixed

- Fixed workspace right-click OpenCode launch so clicking the OpenCode entry starts it directly.
- Improved CLI executable discovery for macOS GUI launches, covering nvm, Homebrew, Cargo, local bin, and cached shell PATH locations.

## 0.10.3 - 2026-06-26

### Fixed

- Restored macOS terminal IME behavior and added an OpenCode CLI install hint.

## 0.10.1 - 2026-06-24

### Fixed

- Fixed the transient macOS WebKit `Paste` prompt when pasting into terminal panes.
- Improved terminal input ordering so keyboard input, paste, and submit actions do not interleave.
- Added a macOS terminal input fallback for cases where the first printable character is seen by the DOM but not forwarded by xterm.
- Cleaned noisy shell PATH output before it is cached, preventing restored-session text from breaking Claude/Codex environment detection.
- Scoped macOS-only terminal callout and context-menu handling away from Windows.

### Changed

- Terminal input trace logs now use debug-level logging to avoid noisy release logs.
