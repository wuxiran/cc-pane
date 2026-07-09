# Changelog

## 0.10.13 - 2026-07-09

### Fixed

- Stale global `[mcp_servers.ccpanes]` entries are now migrated on the WSL side too, not just the Windows `~/.codex`. WSL Codex reads its own Linux-side `~/.codex/config.toml` (or `$CODEX_HOME`), which the Windows migration could not reach; the launcher now resolves that file's Windows path via `wslpath -w` and runs the same signature-matched backup + surgical removal, so a leftover `bearer_token_env_var = "CC_PANES_API_TOKEN"` in WSL can no longer break Codex startup. User-owned (non-CC-Panes) `ccpanes` servers are left untouched.

## 0.10.12 - 2026-07-09 (beta)

### Fixed

- `ccpanes` MCP now injects and connects across every launch path — native Windows Codex, native macOS Codex, and WSL Codex under both mirrored and NAT networking. Daemon-hosted sessions previously got no MCP injection at all (the orchestrator info only ever lived in the Tauri process); the terminal backend now lazily reads the live endpoint from `mcp-orchestrator.json` and validates it with an authenticated `/api/health` probe before injecting, so it never hands the real token to a stranger that recycled the port. Stale global `[mcp_servers.ccpanes]` entries in `~/.codex/config.toml` are migrated away and the redundant `bearer_token_env_var` is no longer written, fixing `MCP client for ccpanes failed to start: CC_PANES_API_TOKEN not set`. For WSL NAT (the WSL2 default), the reachable Windows host is now resolved by probing candidate addresses (loopback, default gateway, resolv.conf nameserver) from inside WSL instead of hardcoding `127.0.0.1`.
- Daemon-mode `launch_task` no longer mis-parents child sessions or drops hook-driven status: the terminal backend protocol was extended with `find_session_id_by_launch_id` and `apply_hook_status` (plus daemon HTTP endpoints), so parent resolution and the fine-grained Thinking/ToolRunning/WaitingInput status write-back reach the daemon that actually owns the session.
- Critical user config files are written atomically to avoid corruption: `~/.claude.json` legacy cleanup now backs up and writes via a temp-file + fsync + rename, `~/.codex/config.toml` migration no longer leaves the file missing if a Windows rename fails, and the settings writer fsyncs before rename so a power loss can't truncate it to an empty file that resets to defaults.
- The session-start hook now probes the env-provided orchestrator endpoint for reachability (and rewrites loopback to the WSL host) before trusting it, so a resumed session's stale `CC_PANES_API_*` no longer beats the live `mcp-orchestrator.json`.
- The daemon orphan-session reaper re-checks live viewer activity immediately before killing, so a session reopened mid-sweep is no longer reaped.

### Changed

- `launch_task` started sessions now open **beside** the calling session's pane by default (a focused side-by-side split) instead of as a background tab stacked in the caller's pane. A new `placement` parameter (`"beside"` default, `"tab"`/`"background"` for the old in-pane behavior) lets the caller opt back in explicitly. Launches without a caller pane (external / layout-name) keep the tab behavior.

## 0.10.11 - 2026-07-08

### Fixed

- Terminal font spacing/alignment was broken on macOS: the desktop build shipped no bundled font, so the terminal font chain fell back to the proportional PingFang SC system font (the only chain font installed on stock macOS, ahead of generic `monospace`). A monospace CJK webfont (Maple Mono NF CN) is now bundled via `@font-face`, so Latin and CJK glyphs render on a consistent monospace grid on every platform. (Adds ~20 MB to the installer.)
- Terminal daemon / MCP connectivity now survives an app restart or update: the orchestrator reuses its previous port and bearer token (persisted in `mcp-orchestrator.json`) instead of picking a fresh random port + token each launch, so already-running CLI sessions keep their injected `CC_PANES_API_*` values valid. The session-start hook also falls back to reading the current endpoint from `mcp-orchestrator.json` when those env vars are missing (e.g. resumed sessions), fixing `MCP client for ccpanes failed to start: CC_PANES_API_TOKEN not set`.

## 0.10.10 - 2026-07-08

### Fixed

- In-app updates could silently leave stale `cc-panes-web` / `cc-panes-daemon` binaries behind: the running child processes held file locks on `binaries\*.exe`, so the Windows installer could not replace them. The updater now stops the Web server and the terminal daemon before downloading and installing an update, releasing the locks so the new binaries actually land. (Stopping the daemon interrupts hosted sessions, but the update restarts the app anyway.)

## 0.10.9 - 2026-07-08

### Fixed

- WSL Codex/Claude launches failed with `HTTP 500: Failed to translate WSL launch script path to WSL path` after 0.10.8 turned the terminal daemon on by default. The daemon was translating its `--data-dir` to a `/mnt/c/...` WSL path even when running as a native Windows process, producing mixed-separator paths that `wslpath` could not resolve. The daemon now only rewrites Windows paths to WSL form when it is actually running under WSL.
- Corrupted/garbled CJK glyphs in the terminal: on Windows the `auto` renderer now defaults to the DOM renderer instead of WebGL, whose glyph atlas mangled Chinese text; terminal fit is self-checked and PTY resizes are debounced to avoid leftover rows.
- Mobile terminal now bundles a CJK monospace font so Chinese aligns to the cell grid, and opening a session no longer force-resizes the shared desktop PTY — fit is opt-in from the toolbar and re-applied (debounced) on rotation / keyboard changes.

## 0.10.8 - 2026-07-08

### Changed

- **Terminal session sharing (daemon) is now enabled by default.** New installs and upgrades host PTYs in the standalone cc-panes-daemon out of the box, so desktop, web, and mobile immediately attach to the same live sessions — no manual toggle needed for the phone mirror to work. The Settings → Terminal switch and the `CCPANES_TERMINAL_DAEMON` override still apply, and if the daemon binary is unavailable the app falls back to in-process terminals. Takes effect after an app restart.

### Fixed

- No stray console window flashes on startup: the `cc-panes-web` and `cc-panes-daemon` child processes are now spawned with `CREATE_NO_WINDOW` on Windows, matching the other helper-process spawns.

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
