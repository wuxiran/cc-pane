# Changelog

## 0.11.0 - Unreleased

> 草稿:随 Worker F(Codex resume + 黑屏修复)落地后补齐并定稿。

### Changed — Local History watcher rework (the real fix behind 0.10.21's revert)

- **File watchers now follow active terminal sessions instead of every registered project.** Previously the app started one watcher per registered project at startup (129 on the reporting machine) — cheap with native notifications, catastrophic with 0.10.20's polling scanner (~28.6 cores busy, see `docs/41`). A new `HistoryWatchManager` starts a watcher when a project's first terminal session opens and stops it 45s after the last one closes (generation-guarded against re-open races). Windows directory-handle locks (#35) now apply only to the handful of actively-used projects, and explicit stops before workspace delete/rename/migration keep `fs::rename` from being blocked.
- **Ignore patterns finally prune nested directories.** Bare-name patterns (`node_modules/**`) now match at any depth — monorepo nested dependencies no longer flood the event pipeline. Built-in ignores (`.venv`, `.next`, `.turbo`, `.dart_tool`, `coverage`, `__pycache__`, …) are unioned with user config, so existing projects with stale ignore lists benefit automatically.
- **Event-flood defenses**: bounded 30k event channel with whole-batch drop + single warn on overflow, 128-path debounce batch cap, explicit handling of notify `Rescan`/error. A global Local History switch (Settings → General) and a `get_history_watch_stats` command round it out.

### Added

- **Git commit timeline + diff view.** Per-project commit history (NUL-delimited field protocol — control characters in commit subjects can't corrupt parsing), master-detail panel (commits → structured file list → DiffView), worktree-vs-HEAD content diff, merge commits default to first-parent with a parent switcher. Backed by a hardened git layer: process output draining with hard byte limits (no more fake timeouts on large `git show`), `--porcelain=v1 -z` status parsing sunk into core (Tauri/Web parity, no more duplicated text parsing), repo-root-unified worktree operations, and OID-pinned revision arguments (`rev-parse --verify --end-of-options`).
- **Project identity unification.** `D:\...`, `/mnt/d/...` and `\\wsl.localhost\...` spellings of the same project are now one project: canonical-form comparison in registration, dedup and `launch_task` validation (any spelling is accepted; runtime conversion happens at launch). An idempotent migration merges existing duplicate entries (with `.bak` backups) and regenerates `projects.csv`.
- **Layout auto-binding** — a new layout binds itself to the workspace of the first terminal tab that lands in it. **Files view follows the active terminal's workspace** (toggleable, manual navigation is never interrupted). (#4 plan)

### Fixed

- **`/clear` no longer kills the session.** Claude Code's `/clear` fires a SessionEnd hook with `reason="clear"`; the hook layer treated every SessionEnd as a process exit, the state machine marked the live session Exited, and the daemon bridge emitted a synthetic `terminal-exit(-1)` and stopped streaming. The hook now filters by reason on both channels (HTTP + OSC), and the bridge no longer trusts hook-derived Exited while the session still exists. (`docs/44`)
- **Chinese-path projects launch correctly**: WSL launch scripts get a UTF-8 locale fallback, worktree branch-name sanitizing keeps CJK characters (Unicode-aware regex), and npm-shim/WSL launches log diagnostics for path issues.
- Windows `git rev-parse --show-toplevel` output is normalized to native separators before path comparison.

### Pending in this release (Worker F, in progress)

- Codex resume capture (OSC title chain dead on Codex CLI v0.145; rollout-scan fallback; binding attribution fix; visible degradation) — `docs/45`
- Cross-platform launch black screen + portable-pty silent HOME-fallback hardening — `docs/46-cross-platform-launch-blackscreen.md`

## 0.10.21 - 2026-07-23

### Fixed

- **Windows: severe whole-app slowdown after updating to 0.10.20.** The Local History polling scanner introduced in 0.10.20 (PR #35) spawned one scan thread per registered project — with 120+ registered projects that meant 120+ threads each doing a full recursive stat sweep every 2 seconds, and root-anchored ignore patterns failed to prune nested `node_modules` in monorepos. Measured: the backend process saturated ~27 of 32 cores minutes after startup. The polling scanner is reverted; Windows is back on native `ReadDirectoryChangesW` notifications. This reintroduces the known limitation that the watcher holds a handle on the project root (#35) — a scoped rework (watch only active projects, shared scan queue, nested-dir pruning) will follow.

## 0.10.20 - 2026-07-23

### Added

- **Main-area wallpaper** — set an image or looping video as the background of the panes area, with an optional background music track. Everything is tunable: wallpaper intensity, blur, dim, terminal backdrop opacity (now allowed all the way down to 0 — text floats directly on the video), and a new configurable glass-blur for panels stacked above the wallpaper (default 0, so panels no longer frost the video). Videos can lend their own audio track as the BGM (`use video audio`, played via a separate audio element so autoplay policies and the power-saving pause never freeze the video). Per-workspace overrides cover the **full** parameter set with explicit per-field opt-in — anything not overridden falls back to the global setting, including nested video/music fields. Wallpaper files are copied into the app data dir (`wallpapers/`), validated, and covered by the data-dir migration.
- ⚠️ **Behavior note**: background music gets its own "pause when unfocused" switch, **default off** — previously the BGM followed the video's pause-on-blur setting (default on). After upgrading, music keeps playing when the window loses focus unless you enable the new switch.

### Fixed

- **`ProviderType::OpenAI` serialized as `open_a_i`** (serde's snake_case acronym split), breaking the `open_ai` contract used by the frontend, IPC payloads, and CLI adapters — `add_provider` rejected OpenAI providers as an unknown variant. Now canonically `open_ai`, with `open_a_i` still accepted on read for persisted configs. (PR #42, contributed by @luminouA)
- **Linux (WebKitGTK + Fcitx5): Chinese IME stopped working after copy/paste in the terminal** until the window lost and regained focus. Paste interrupts an in-flight composition and WebKitGTK never delivers the matching `compositionend`, so the IME guard's stale composing flag swallowed every subsequent `insertFromComposition`. The paste/copy cleanup path now resets the guard's composition state alongside the DOM state. (#41)
## 0.10.19 - 2026-07-20

### Added

- **Global launcher (`Ctrl+T`)** — a nine-section launch dialog (project / CLI / environment / scenario / options / injection / provider / worktree / layout) with a live CLI-args preview. A persistent **Launch Terminal** button now sits at the bottom of the sidebar, the title bar gained an explicit sidebar collapse toggle, and the home dashboard's **Enter Workspace** CTA moved from the very bottom of the page up to the greeting row (it now also expands the sidebar on click). **Recent Launches** moved out of the ActivityBar rail into the Explorer's top icon tabs.
- **System environment variables can now be set as the default credential.** Backed by a persisted `default_is_system` flag (serde-defaulted, so existing configs still deserialize); `detect_system_provider` now returns detection details — matched variable *names* only, never values — and the card states plainly that host-process detection does not represent a WSL/SSH target.

### Fixed

- **Windows verbatim-path (`\\?\`) contamination — data-affecting.** The CLI hook's `canonicalize()` produced verbatim-prefixed paths that overwrote the clean `launch_cwd` in launch history, flowed back as `workspacePath`, and reached the PTY as a working directory — which `cmd.exe` rejects, silently falling back to `C:\Windows`. Measured 41 polluted rows across 9 workspaces, growing with every relaunch from Recent Launches. Fixed at six layers (a shared `dunce`-backed helper, the hook, the repository, the frontend fallback, and the PTY gate) plus migration **V23**, which strips only an exact verbatim prefix, skips the UNC form that cannot be safely downgraded, and is idempotent by construction.
- **Orchestrator MCP port drift silently killed long-running sessions.** The port was OS-ephemeral with best-effort reuse, landing squarely inside Windows' 49152-65535 ephemeral range. When it changed, already-running CLI sessions lost `ccpanes` MCP permanently: hooks re-resolve per call and self-heal, but a CLI's own MCP client resolves exactly once, at startup. Now a fixed port outside the ephemeral range with separate dev/release offsets, a loud failure instead of a silent drift, and a `CC_PANES_ORCHESTRATOR_PORT` escape hatch. Manifest writes are atomic.
- **MCP control keys never reached the target session.** `\x03`-style escaping is not valid JSON, yet the tool description and skill docs taught exactly that — the payload either failed to parse or arrived as four literal characters, with no error either way. Added tolerant escape decoding at the MCP boundary (shared with the REST twin) and corrected the docs to require `\u` escapes. Control keys must use `write_to_session`; `submit_to_session` always appends CR and will cancel an interrupt.
- **MCP `kill_session` left the tab open.** The kill reason was never mis-set — it was dropped. The daemon bridge's 500 ms status tick could beat `ws.next()`, emit a silent `terminal-exit(-1)`, and return before the queued `killed` message was ever read. The race window was wide because the kill path removed the session from the map first (making it invisible to status polling), then did file I/O and a process-tree kill, and only then emitted the event. Fixed by emitting earlier and draining the socket before exit. Starred layouts and pinned tabs no longer swallow backend-driven closes silently.
- **Linux terminal copy/paste.** `5089593` deliberately kept `clearNativeEditState`'s destructive clearing for Linux WebKit's IME workaround, but its effect on the clipboard was never checked — wiping the document selection immediately after an async clipboard write is precisely how WebKitGTK loses that write. Copy now preserves the document selection (the hidden textarea is still cleared, so the IME workaround is untouched); the paste path no longer aborts on a failed image probe before it ever reads text; Ctrl+Shift+C copies on non-Mac.
- **Terminal scrollbar was invisible in light theme** — the slider colors had no light variant. Separately, `stripAlternateBufferSequences` ran per chunk, so a PTY split mid-sequence let Codex slip into the alternate buffer, making behaviour flip between "no scrollbar" and screen residue. Replaced with a stateful, chunk-safe stripper wired into the render path.
- **The provider panel conflated three different verbs on one card**: a green *Launch* button (a one-shot session start, mislabeled as if it set state), a small star for *Set as default* (the actually persistent action), and CRUD icons — with the visual weighting exactly inverted. The panel is now pure credential management; launching lives in the global launcher, which already covered every option the panel's inferior entry point offered.
- **The main launcher ignored the "default CLI tool" setting**, always starting Claude despite eight supported CLIs, a settings entry, and an onboarding prompt asking the user to choose one.
- New split panes no longer open with a stray empty *Terminal* tab, and auto-split now alternates right/down into a spiral instead of tiling horizontally forever.
- `ResourceHub` rendered an i18next "returned an object instead of string" banner directly in the UI; missing `resourceHub` / `skills` keys and hard-coded Chinese in the segmented control are now translated.

### Internal

- Extracted shared CLI-tool coercion and de-duplicated `createPanel` — both artifacts of parallel work. The `launch-task` and `parallel` skills now document the previously unrecorded `placement` parameter.
- Design and investigation notes land in `docs/24` through `docs/38`.


## 0.10.18 - 2026-07-15

### Added

- **xAI Grok CLI (Grok Build) is now the 8th supported CLI tool**, aligned with Codex-level integration depth: launch from the sidebar menu (local / WSL / SSH), a Grok provider tab with an xAI preset (`XAI_API_KEY` / forward-looking `XAI_BASE_URL` injection), ccpanes MCP auto-injection into `~/.grok/config.toml` (comment-preserving TOML edit, atomic write with `.bak` backup, ownership detected by URL signature so user-defined entries are never touched), YOLO via `--always-approve`, system-prompt append via `--rules`, and deterministic resume: CC-Panes pre-issues the session UUID via `--session-id`, so launch history and the Resume button work without any output capture. The issued-session-id gate in the terminal service is now capability-driven (`supportsIssuedSessionId`) instead of hardcoded to Claude. Known deferrals (documented in `docs/21-grok-cli-support.md`): WSL Grok launches without MCP injection, MCP isolation degrades to a warning, and native Grok project hooks stay off until the config surface is confirmed.

### Fixed

- **Token usage stats were roughly 2× inflated for both Claude and Codex.** Verified against raw session JSONL (one day's data: Claude shown 1.92B vs. real 0.89B, Codex shown 131M vs. real 67M):
  - Claude: Claude Code writes one JSONL line per assistant content block — each line repeats the same `message.id` and the same `usage`, and streaming updates rewrite the same-id line. The scanner summed every line (55.8% duplicates in measured data). Usage entries are now deduplicated per file by `(message.id, requestId)` with last-write-wins (progressive updates keep the final counts), matching ccusage semantics.
  - Codex: the dashboard summed `input + output + cache_read + cache_creation`, but OpenAI's `input_tokens` already includes the cached-read subset — cache reads were counted twice. Codex totals (cards and trend chart) are now `input + output`. Cache-hit-rate formulas were already CLI-aware and are unchanged.
  - A usage-scan algorithm version gate clears the scan cache on upgrade, so all historical aggregates are automatically recomputed on the next sweep (idempotent REPLACE per file — no manual migration).
- Starred tabs are now real terminal mirrors: starring a tab shows a live, fully interactive second view of the same PTY in the starred layout (auto-arranged grid, output stays in sync, original tab untouched; the mirror follows session restores and disappears when the tab closes or is unstarred). The terminal event layer now supports multiple subscribers per session — previously a second view would silently steal the first view's output stream.
- Launching CC-Panes no longer wakes the WSL VM (Vmmem): usage-stats scanning probes for a running VmmemWSL process (zero side effects) before touching `wsl.exe` or `\\wsl$` paths, the startup scan is native-only, and a stale distro cache can no longer re-awaken a stopped distro. A new "Skip WSL usage scanning" toggle in Settings → General disables WSL scanning entirely. (#37)
- Project/workspace context menus no longer flat-list 20+ launch entries: favorites (default Terminal / Claude Code / Codex CLI, customizable via "显示在常用") stay top-level and everything else folds into a "More launch options" submenu. (#36)

## 0.10.17 - 2026-07-13

### Fixed

- **Intermittent frontend freezes, sustained ~100% CPU per window, and a self-amplifying log flood (0x8007139F WebView2 errors at ~13/s, 10MB log rotation every ~15min) are fixed at the root.** Every instance pre-created a hidden, transparent `ccchan` pet window at startup; once Windows invalidated that long-hidden WebView2, every `app.emit` broadcast to it failed and logged an error — and the log plugin's Webview target re-emitted each error back to the dead WebView, amplifying the flood. Fix:
  - The ccchan window is no longer pre-created in `tauri.conf.json`; it is created on demand when the pet is enabled (existing get-or-create path) and **destroyed** — not hidden — when the pet is turned off, so no long-lived hidden WebView remains.
  - `tauri_runtime_wry` log records are rate-limited (max 5 per 60s window), which also severs the log→Webview-target feedback loop. Note: closing the main window to tray still hides a WebView (known residual scenario); the rate limiter caps the damage there.
- Shared MCP servers now have a real circuit breaker: after exceeding max restarts the health checker stops re-probing the dead process every 30s (previously it logged WARN+ERROR forever), the failed server is no longer injected into new sessions as a "running" endpoint, and the Failed state now shows a Restart button in Settings (restarting resets the counter and closes the breaker).
- Per-session temporary MCP configs (`mcp-<id>.json`, `wsl-claude-mcp-<id>.json` in the data dir) are deleted when the session ends (both kill and natural exit); WSL configs also get a crash-leftover sweep (>1h old **and** not belonging to any live session — long-running sessions are safe). Previously the WSL variant was never cleaned up (85 stale files had accumulated over 3 months).

## 0.10.16 - 2026-07-11

### Fixed

- **Panels no longer vanish right after "Open Claude Code" when a stale app instance is still running.** Root cause: multiple desktop instances (e.g. an old version left running after an upgrade) share one daemon, and each instance's orphan-session reconciler only sees its *own* tabs — sessions opened in another window looked orphaned and got killed. Three-layer fix (see `docs/20-orphan-session-reconcile.md`):
  - Single-instance lock (`tauri-plugin-single-instance`): launching a second copy focuses the existing window instead. Dev and release builds still coexist (lock is per app identifier).
  - Kill provenance: every kill now carries a `KillReason` (`user-close` / `mcp` / `orphan-reclaim` / `daemon-reaper`) broadcast in `session-killed`. Reclaim-type kills keep the tab and show "Process exited" instead of silently closing it; user/MCP kills close the tab as before. This also fixes a latent bug where `session-killed` never reached the frontend in daemon mode (the daemon WS emitter dropped it), so MCP `kill_session` could not close tabs.
  - Multi-client fail-closed: each desktop instance holds a control WebSocket to the daemon (`/ws/control?kind=desktop`); the reconciler skips its sweep whenever `desktopClientCount != 1` (or the count is unavailable), so a partial view can never kill another window's sessions.
- `closeTabBySessionId` (the only backend-event-driven tab-close path) now logs which tab it closes, and unknown daemon WS message types no longer degrade the session stream to polling.

## 0.10.15 - 2026-07-10

### Fixed

- Orphaned daemon terminal sessions no longer accumulate forever and burn CPU (idle TUI redraw kept flowing through the full PTY→sanitize→emit→xterm pipeline; on one machine 56 of 69 sessions had no panel referencing them). The desktop app now reconciles every 10 minutes (first sweep 5 minutes after launch): daemon sessions not referenced by any tab across **all** layouts (including starred and non-current ones), Self-Chat, active runners, or live task bindings are killed — busy/initializing/waitingInput sessions are protected, sessions with activity in the last 10 minutes get a grace period, and at most 10 are reclaimed per sweep with an aggregated notification.

### Changed

- **Semantics change**: `daemonOrphanTtlMinutes = 0` no longer means "never expire". The daemon-side orphan reaper backstop now defaults to 24 hours (covers the window when the app isn't running), and existing configs with the old default `0` are migrated to 24h on load. To disable reaping entirely, use the new "Never reclaim orphaned sessions" toggle (`daemonOrphanReaperDisabled`) in Settings → Terminal.

## 0.10.14 - 2026-07-10

### Fixed

- Daemon-mode WSL Codex sessions no longer fail with `os error 10060` (WinSock timeout) on every launch. The daemon client applied a flat 2s read timeout to all requests, while a WSL Codex create synchronously runs multiple cold `wsl.exe` invocations on the daemon side (WSL→Windows host probing, stale config migration). Timeouts are now tiered — create 60s, kill 15s (a `taskkill /T /F` under load also breached 2s), control-plane probes stay at 2s fail-fast. The create handler moved onto the blocking thread pool so a slow launch can't starve other daemon requests; host-probe results are cached per (distro, port) for 5 minutes (failures are never cached) and the WSL-side stale `ccpanes` config migration runs once per process per distro, so subsequent WSL launches skip the redundant `wsl.exe` cold starts entirely.
- File-tree delete no longer surfaces a raw `Failed to move to trash: … Some operations were aborted` error when the Recycle Bin is unavailable (file in use, or the volume has none — WSL UNC paths, network drives). The backend returns a structured `TRASH_FAILED` error and the UI offers a confirmed permanent-delete fallback; deleting under `\\wsl.localhost\...` skips the doomed trash attempt and asks for permanent deletion up front.

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
