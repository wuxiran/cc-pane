# Changelog

> GitHub Release notes are injected from [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md), not from this
> file. Add the entry to both — a missing Chinese entry fails `validate-version` before any build
> starts.

## 0.12.10 - 2026-09-01

### Added

- **Skill market** — a full-screen store (activity bar `Store` icon, also reachable from Settings → Tools → Skills) with a featured strip, category tabs, search and one-click install. Content is aggregated from three sources: the curated `skill-market/index.json` (30+ entries, now embedded in the binary as an offline baseline and refreshed from `main`), auto-discovery of `anthropics/skills`, and live `skills.sh` search. Installs now support **directory skills** (`SKILL.md` + `scripts/` + `references/`): the repository tree is listed once via the GitHub API with automatic fallback to the jsDelivr mirror, files are staged then renamed into `~/.cc-panes/skills/user/<id>/`, with hard limits of 300 files / 30 MB. Session-prompt injection appends `Skill directory: <path>` so agents can find bundled scripts. Design notes in `docs/97-skill-market.md`.
- **Project skills manager** — the per-project "Skill manager" tab now has two views. *Agent Skills* manages the `SKILL.md` folders checked into the repo, grouped by the folder each CLI scans (`.agents/skills` for Codex/Cursor, `.claude/skills` for Claude Code, plus `.cursor` / `.codex` / `.gemini`), with a badge showing which CLIs can see each skill. Create (frontmatter scaffolded), edit, delete, move a skill between roots to expose it to another CLI, or import from installed user skills, skills found in CLI homes, the skill market (downloaded straight into the project) or another registered project. *Slash commands* keeps the old `.claude/commands/*.md` editor unchanged.
- **Workspace skills (workspace-first)** — skills can now belong to a workspace and apply to every project in it. They live in `~/.cc-panes/workspaces/<name>/skills/`, a plugin-shaped folder mounted per session exactly like the bundled skills (Claude `--plugin-dir`, Codex `skills.config`; CLIs that cannot mount get them inlined into the session prompt), so nothing is written to any repo or CLI home. Right-click a workspace → *Workspace skills* to manage them with the same panel as project skills; the skill market's new *Install to* selector defaults to the current workspace; project skill import offers *Workspace* as a source first; launch profiles gain an *Enable workspace Skills* toggle.

## 0.12.9 - 2026-08-27

Canvas grows a second kind of node: media. Alongside it, Cursor becomes a first-class CLI rather than one that merely launches, and the terminal stops fighting xterm over the mouse wheel.

### Added

- **Media generation on the canvas** — image and video nodes live in the existing terminal-area canvas next to terminal nodes, sharing drag, zoom, snapshot and event state. Node bodies are plain DOM `img` / `video` so browser-native decoding, pause, volume and accessibility all keep working, and no frame is ever copied through a canvas layer; SVG only draws the edges between nodes. A node and a run are separate records, so the same node can be regenerated repeatedly and keep its history, and providers declare their operations, input ports and output types through a capability registry instead of everyone assuming one API shape. Job state is owned by the service layer — leases, restart recovery, timeouts, retries and `clientRequestId` idempotency — and downstream nodes never auto-chain: a run happens because you asked for it. Canvas snapshots move to v2 (positions, sizes and view settings only; nodes, runs, assets and edges are SQLite-sourced) while still reading v1. Design notes in `docs/22-media-generation-canvas-plan.md`.
- **Cursor is now orchestrable, not just launchable** — resume ids reach `launch_history` (a background scan of `~/.cursor/chats/**/meta.json`, since Cursor cannot be handed a session id up front the way Claude can), the `ccpanes` MCP server is registered into `~/.cursor/mcp.json` at launch with url/token/launchId, status inference reads only conservative phrases (never a spinner frame, which redraws every tick and changes between versions), WSL resume listing works, and `-p --output-format text` makes Cursor usable as a print worker. Until now every one of those was missing, which meant Cursor appeared in the launcher but could not participate in any of the dispatch flows.

### Fixed

- **The terminal was fighting xterm over the mouse wheel** — a hand-rolled handler converted wheel events into `ESC[A`/`ESC[B` in the alternate buffer, which xterm 6.0 already does, and does better: it gates on whether the application asked for wheel mouse reports, and it encodes for DECCKM (`ESC O A` when application cursor keys are on). Ours did neither, and it listened on the same element xterm binds to — `stopPropagation()` does not stop other listeners on the same node — so both ran on every wheel tick. Applications with mouse reporting on (grok, opencode) received a real SGR mouse report *plus* stray arrow keys; applications without it (codex, vim) received two arrows instead of one. In grok's plan-approval view the stray arrows landed on the prompt, where keyboard focus sits, and paged through input history instead of scrolling the plan. The handler is deleted; wheel handling is xterm's again.
- **Unavailable CLIs were still offered in the sidebar launch menu.**

### Changed

- **Fullscreen TUIs get their full wheel distance back** — xterm damps small pixel deltas before emitting a mouse report, so a TUI that scrolls itself would only move a line per notch. Wheel distance is now resolved into a row count and replayed as that many line-mode wheel events, with the three input kinds handled separately because they mean different things physically: notched wheels get logarithmic compression plus a burst bonus, trackpad pixel streams map 1:1 with the sub-row remainder carried (compressing them would distort inertial scrolling; dropping the remainder would make slow drags scroll nothing at all), and line/page modes are already row counts. This runs through xterm's official `attachCustomWheelEventHandler` rather than a competing listener, and stands down for three cases: no mouse reporting, `Shift` held (the conventional bypass gesture), and its own replayed events.

## 0.12.8 - 2026-08-26

Canvas Mode arrives — a spatial view of what the agents are actually saying to each other — alongside four defects that all share one shape: the feature was there, the UI said it was working, and nothing ever logged an error, so each had been running broken for a long time. Three of them share a single cause: **a boundary nobody re-checked after the process split.** Shared MCP servers are started by the app but sessions are created by the daemon, so the injection table was always empty; the ACK queue drained itself with an unconditional notify, so one acknowledgement pinned a whole tokio worker at 100% forever; and stdio MCP servers were handed a null stdin, which is how they are told to exit.

### Added

- **Canvas Mode** — a second layout for the terminal area that sits alongside the normal pane grid rather than replacing it. Terminal cards are draggable and resizable in their own space, with pipes drawn between them that reflect only real `dispatch` / `message` / `report` events — never inferred from terminal text, and never animated merely because a worker is in `running`. Task summaries and status badges render at the card edges so they never cover terminal content. The execution model is untouched: same panes, same tabs, same PTYs, same xterm instances, with the display mode held in its own store so switching views never disturbs a running session. The orchestration panel keeps its job (task lists, details, notifications); Canvas Mode only shows live spatial relationships and communication feedback. Design notes in `docs/92-canvas-mode-design.md`.

### Fixed

- **Not one shared MCP server was reaching new sessions** — the ports were listening, the UI showed them healthy, and the generated `mcp-<sessionId>.json` contained only `ccpanes`. The server processes are spawned by the app (`start_all` has exactly one call site, in `lib.rs`), while sessions — and the config file that lists their MCP servers — are created inside the daemon. The daemon's own `SharedMcpService` therefore has a permanently empty `running` map, and `get_running_servers_urls()` requires `status == Running` before it will inject anything, so it returned an empty map every time and the adapter's injection loop never ran once. The running URL table is now pushed to the daemon over the existing control channel and cached there, following the same shape as `hiddenSessions` (full replacement, resend on connect, best-effort). It is delivered through a `TerminalBackend` default method — the same route `outputAck` already takes — because `DaemonConfig` only holds a trait object and cannot reach the concrete service. Three invariants hold the design: the cache is cleared when the control link drops, since injecting a dead endpoint makes every tool call hang on connect (worse than injecting nothing); the handler is gated on `is_desktop`, so a phone or web client disconnecting cannot wipe the desktop's table; and launch-profile filtering still applies to the pushed table.
- **One acknowledgement could pin a tokio worker at 100% of a core, silently and permanently** — the app would go intermittently unresponsive and `browser_evaluate` would report `CDP method timed out`. Live sampling showed a `tokio-runtime-worker` burning 99.5% of a core within 1.1 seconds of startup, reproducible across restarts, with 28 of 30 instruction-pointer samples landing in `ZwWaitForAlertByThreadId` and `ZwRemoveIoCompletionEx` while the stack pointer cycled between four values — a loop, not a hang. I/O counters showed only ~92 operations per second, which rules out a syscall storm. `drain_output_acks` emptied the queue with `send_modify`, which notifies **unconditionally**: writing back an empty map re-arms the receiver's `changed()`, and since the caller had already called `mark_unchanged()` *before* draining, nothing consumed that notification — so the next poll was ready again, drained an empty map again, and the future never returned to `Pending`. A minimal reproduction runs 14 million iterations in three seconds; with `send_if_modified` it runs six. The CDP timeout was a symptom: its timer and oneshot wake were queued behind a saturated runtime.
- **Shared MCP servers killed themselves 40ms after connecting** — a defect documented in `docs/70` and left open for two releases. `spawn_server_process` gave every bridge mode a `Stdio::null()` stdin, and a stdio MCP server treats stdin EOF as its shutdown signal; after three restarts the circuit breaker stopped them for good. The user-visible symptom looks nothing like "MCP is down" — the agent simply cannot see those tools and silently falls back to others. `McpProxy` servers now get a piped stdin whose handle is held in `ServerRuntime`; dropping the handle is itself an EOF, so holding it is the fix.
- **Every composition input threw `TypeError: Illegal invocation`** — the terminal's composition-recovery scheduler stored bare references to `requestAnimationFrame` and `cancelAnimationFrame` as object properties, which detaches them from `window`; WebView2 rejects the call outright. Because the handler is bound to `compositionend`, this fired on every Chinese or Japanese input and flooded the log with `[frontend-crash]` entries. The methods are now wrapped in arrow functions, which also defers the global lookup to call time so the module stays importable without a browser global.
- **The production build broke xterm's `requestMode`**, and the type-check gate had been failing on `closedTabsUndo` — `current()` requires a `Draft<T>` while `isDraft` only narrows at runtime. Both are now covered: the build gains a `verify-xterm-build` step, and the assertion is scoped to the branch that has already confirmed a draft.


- **Not one shared MCP server was reaching new sessions** — the ports were listening, the UI showed them healthy, and the generated `mcp-<sessionId>.json` contained only `ccpanes`. The server processes are spawned by the app (`start_all` has exactly one call site, in `lib.rs`), while sessions — and the config file that lists their MCP servers — are created inside the daemon. The daemon's own `SharedMcpService` therefore has a permanently empty `running` map, and `get_running_servers_urls()` requires `status == Running` before it will inject anything, so it returned an empty map every time and the adapter's injection loop never ran once. The running URL table is now pushed to the daemon over the existing control channel and cached there, following the same shape as `hiddenSessions` (full replacement, resend on connect, best-effort). It is delivered through a `TerminalBackend` default method — the same route `outputAck` already takes — because `DaemonConfig` only holds a trait object and cannot reach the concrete service. Three invariants hold the design: the cache is cleared when the control link drops, since injecting a dead endpoint makes every tool call hang on connect (worse than injecting nothing); the handler is gated on `is_desktop`, so a phone or web client disconnecting cannot wipe the desktop's table; and launch-profile filtering still applies to the pushed table.
- **One acknowledgement could pin a tokio worker at 100% of a core, silently and permanently** — the app would go intermittently unresponsive and `browser_evaluate` would report `CDP method timed out`. Live sampling showed a `tokio-runtime-worker` burning 99.5% of a core within 1.1 seconds of startup, reproducible across restarts, with 28 of 30 instruction-pointer samples landing in `ZwWaitForAlertByThreadId` and `ZwRemoveIoCompletionEx` while the stack pointer cycled between four values — a loop, not a hang. I/O counters showed only ~92 operations per second, which rules out a syscall storm. `drain_output_acks` emptied the queue with `send_modify`, which notifies **unconditionally**: writing back an empty map re-arms the receiver's `changed()`, and since the caller had already called `mark_unchanged()` *before* draining, nothing consumed that notification — so the next poll was ready again, drained an empty map again, and the future never returned to `Pending`. A minimal reproduction runs 14 million iterations in three seconds; with `send_if_modified` it runs six. The CDP timeout was a symptom: its timer and oneshot wake were queued behind a saturated runtime.
- **Shared MCP servers killed themselves 40ms after connecting** — a defect documented in `docs/70` and left open for two releases. `spawn_server_process` gave every bridge mode a `Stdio::null()` stdin, and a stdio MCP server treats stdin EOF as its shutdown signal; after three restarts the circuit breaker stopped them for good. The user-visible symptom looks nothing like "MCP is down" — the agent simply cannot see those tools and silently falls back to others. `McpProxy` servers now get a piped stdin whose handle is held in `ServerRuntime`; dropping the handle is itself an EOF, so holding it is the fix.
- **Every composition input threw `TypeError: Illegal invocation`** — the terminal's composition-recovery scheduler stored bare references to `requestAnimationFrame` and `cancelAnimationFrame` as object properties, which detaches them from `window`; WebView2 rejects the call outright. Because the handler is bound to `compositionend`, this fired on every Chinese or Japanese input and flooded the log with `[frontend-crash]` entries. The methods are now wrapped in arrow functions, which also defers the global lookup to call time so the module stays importable without a browser global.


## 0.12.7 - 2026-08-23

Mostly a macOS release. Two separate defects meant that on a Mac the app's keyboard shortcuts did essentially nothing and the terminal had no context menu at all — both had been sitting under features long marked done, and both were invisible to the test suite because jsdom reports a non-Mac platform, so the branches where the bugs live were never executed. Alongside that, the terminal output path gets end-to-end flow control: the renderer's window was invisible to Rust, so backpressure was only ever moved, never measured — and a process that floods the terminal is now rate-limited by its own output instead of by whatever the IPC queue happens to absorb.

### Added

- **Terminal output delivery accounting** — the write flow-control window only applied inside the renderer, so queue pressure moved from xterm forward into the WS/Tauri IPC layer rather than disappearing. Channel depth cannot measure it either: neither emitter blocks, so when the WebView stalls the depth stays at ~0 and the backlog sits in the IPC queue. Bytes emitted but not yet acknowledged is the only watermark that reflects downstream speed, and it is now tracked end to end (cumulative + max-merge, so it is idempotent under retries). Credit is returned at the *consumption* point — a chunk parsed by xterm, **or** dropped by any discard path — because acknowledging at enqueue tells the producer "consumed" when it only means "received". Above the high watermark the PTY read loop now parks: the flooding child process fills the kernel buffer and blocks in its own `write()`, rate-limited by its own output. Three independent paths guarantee it resumes (acks draining below the low watermark, a 5s failsafe, cancellation), and a genuinely dead ack link degrades to a snapshot repaint rather than a terminal that trickles. Clients with no ack channel (web mode, older frontends) never park at all — the gate stays open until a first ack proves the return path exists. SSH sessions never park either: same-host terminals share one ssh2 transport, so stalling one read would drag down the rest. `PRODUCER_FLOW_CONTROL_ENABLED` disables the gate without rolling back the release.

### Fixed

- **Application shortcuts did nothing on macOS while the terminal had focus** — which is nearly always, since the terminal is the main surface. Two faults compounded. `parseKeyEvent` normalizes both `ctrlKey` and `metaKey` to a `Ctrl` prefix, so ⌘W and ⌃W are indistinguishable by the time they reach matching; the terminal-passthrough list then yielded seven of the most-used bindings (close-tab, new-tab, toggle-sidebar, command-palette, …) to readline. That list was written for platforms where Ctrl *is* the application modifier — on a Mac it swallowed the ⌘ combinations too, even though ⌘W means nothing to readline. Yielding is now decided at the event layer from the real ⌃ key rather than from the normalized string, so ⌘ bindings fire and ⌃C/⌃D/⌃A/⌃E still reach the shell. Separately, Option is a dead key: ⌥L arrives as `¬` and ⌥1 as `¡`, which match no binding, so toggle-layouts, voice-input and switch-layout-1..9 were dead as well. With Alt held the physical `code` is read instead; without it the key label still wins, so AZERTY and Dvorak layouts are unaffected. The UI had been rendering `Ctrl+` as ⌘ throughout — it was promising a key that did nothing.
- **No context menu in the terminal on macOS** — the native-menu blocker called `stopImmediatePropagation` on `contextmenu`, and Radix opens on the bubbling `onContextMenu`, so the menu could never appear; the response at the time was to skip mounting it on Mac entirely. The blocker now only calls `preventDefault` on `contextmenu` (still suppressing the native menu) and lets propagation through, so the menu is enabled on every platform.
- **Terminal text sat flush against the panel border** — the host element had no padding, so xterm drew from the container origin and the first column touched the frame. The padding goes on the host rather than on `.xterm`: FitAddon derives the column count from the parent's content box, so rows and columns shrink with it, whereas padding on `.xterm` would inset the viewport together with the scrollbar. Vertical padding is held to 4px — every extra 8px risks FitAddon's floor division eating a whole visible row.
- **The notification centre's "All" filter excluded system notifications** — while the bell badge and the collapsed bar both count *all* unread including system events. When every unread item was a system event the result was a badge reading 7 above an empty list: a count with no way to see what it refers to, and so no way to judge whether it can be cleared. Noise reduction stays with the "System" subset filter instead of making "All" untrue.
- **Buffered output could be cut mid-escape-sequence when no subscriber was attached** — the overflow policy dropped the oldest half of the pending buffer, slicing VT escape sequences in two; a half sequence reaching xterm is corruption on screen. This is exactly what the desync contract forbids ("never cut mid-VT-stream"), and the daemon mirror path already handled the same risk correctly with skip-and-replay. The frontend path now follows the same contract. The cap is counted in characters rather than chunks, since 1000 chunks may be 256 B or 1 GB.

### Changed

- **Backlog for hidden terminals is now a shared global budget** — each hidden buffer previously reserved 512 KB of its own, so 18 background tabs meant a 9 MB ceiling: N sessions, N independent limits. The total is now capped at 2 MB with each share shrinking as more tabs go to the background. This tightens rather than relaxes: a single background tab still gets its full 512 KB. More frequent overflow means more snapshot replays, which is the intended trade — one replay costs far less than 9 MB held resident.
- **Sidebar switched to a compact layout** — tighter row padding, smaller icons, and unified badge shapes lift the information density of the column. Two changes are not merely cosmetic: the branch badge is now the only shrinkable item in its row, with a minimum width reserved for the project name, so a narrow sidebar no longer truncates the name to `cc…`; and the worktree count badge uses `aria-label` instead of `title`, so screen readers announce it and no native tooltip appears. Expanded sections use a left rule and indentation instead of a nested card.

## 0.12.6 - 2026-08-22

Maintenance release. Most of it is one thread pulled end to end: a report of "garbled text in a pane" turned into an audit of the local PTY path, which surfaced five independent correctness bugs — none of which the previous three competitor-gap scans had caught, because those scanned for *missing features* and these all sit underneath features already marked done. Plus Pi / Oh My Pi CLI support.

### Added

- **Pi and Oh My Pi (omp) CLI support** — both register as first-class CLI adapters (launch, resume, session discovery, context probing), so they can be dispatched and orchestrated like Claude/Codex.

### Fixed

- **Local sessions ran without a UTF-8 locale** — macOS GUI apps launched from Finder/Dock do not inherit the shell's `LANG`/`LC_*`, so every local PTY ran under `LC_CTYPE=C` and any program sizing multibyte text by locale (notably `wcwidth` in TUI layout) miscounted CJK: `wc -m` on four Han characters returned 12. Only the WSL path had locale injection; local had none. Sessions now get `LANG=C.UTF-8` when the inherited locale is not UTF-8 — **`LANG` only, never `LC_ALL`**, which is the POSIX-wide override and would flatten a user's own `LC_TIME`/`LC_COLLATE`. When a non-UTF-8 `LC_ALL`/`LC_CTYPE` outranks the injection, a warning is logged rather than failing silently.
- **Escape sequences split across PTY chunks lost their first half** — the plain-text output buffer stripped ANSI per chunk with a stateless stripper. It already carried an incomplete UTF-8 character and an incomplete *line* across chunks, but not an incomplete *escape sequence*: the leading `\x1b[38;2;24` was swallowed whole and the trailing `8;248;242m` surfaced as literal text. One session's buffer held 552 such fragments. Sequences are now carried across the boundary, with the carry cap tiered by type (128 B for CSI, 4 KiB for OSC/DCS — a 120-character OSC 8 hyperlink is already 127 B and an OSC 52 clipboard payload runs into the kilobytes).
- **Query replies echoed as visible garbage, and polluted the next program's stdin** — the frontend answers terminal queries (CPR, device attributes, kitty keyboard, OSC 4/10/11) by writing to the PTY master. With the line discipline in cooked mode that write is echoed back literally (`^[[1;1R`) *and* queued as slave input for whatever reads stdin next. Replies are now suppressed when the TTY is in true cooked mode, decided by a synchronous `tcgetattr` on the master — deliberately not an async probe, since deferring a reply is what lets a later one overtake it. The predicate requires **both** `ECHO` and `ICANON`: with `ICANON` off the program genuinely can read the reply, so suppressing there would hang it. An indeterminate verdict never suppresses.
- **Multi-line submits could be committed one line at a time** — `submit_to_session` only bracketed the paste when DECSET 2004 had been observed, and sent raw text otherwise, where every newline reaches a TUI as Enter. Windows ConPTY never forwards that mode, and there is no startup wait for it, so a prompt injected right after launch could race it. Worse than splitting the message: a draft parked in the agent's composer gets submitted by the first newline. Multi-line submits to a session running a TUI composer are now always bracketed.
- **Terminal state stranded after a byte gap** — when desync recovery could not obtain a snapshot it returned without writing anything. Keeping the damaged screen is right, but the state is not kept along with it: the `CSI 22m` closing bold, or the `CSI ?1049l` leaving the alternate buffer, may have been inside the lost span, and everything after inherits it. Abandon paths now emit a narrow grounding — `CAN` plus an SGR reset. `CAN` rather than a bare `ESC`, because xterm dispatches OSC/DCS/APC unless the terminator is `0x18`/`0x1a`, so `ESC` would *commit* the truncated sequence: a half-read OSC 0 retitles the window and OSC 52 writes the clipboard.
- **WebGL glyph-atlas corruption across panes** — xterm shares one glyph atlas between identically-configured terminals but each pane keeps its own vertex model, so an atlas rebuild in one pane left the others sampling stale coordinates (large black areas with sparse colored fragments, recovering only on a full repaint). CJK triggers it constantly, since every new Han character is a new glyph. All live WebGL terminals now refresh on an atlas structure change; a failed repaint keeps the pending flag instead of dropping it, and `onRender` acts as a third trigger for panes an IntersectionObserver cannot see.
- **MCP-dispatched workers could not be re-adopted after a restart** — several orchestrator creation paths wrote provenance rows with null birth anchors (the PTY exists before the frontend picks a placement), and those rows could never be repaired, since the writer is `ON CONFLICT DO NOTHING` and backfill only looked for wholly missing rows. Anchors are now pre-assigned at creation with a daemon-side fallback, and migration v35 backfills the existing rows — only where an observation row actually supplies both anchors, never fabricating a value.

## 0.12.5 - 2026-08-18

Shipped without changelog entries: the dev line had 0.12.4's text sitting under a `0.12.5` heading, and the correction made on `release/0.12.4` never flowed back, so the mistake stayed invisible until 0.12.6 merged into main. Reconstructed below from the 19 commits between the two tags — commit subjects, not a written-at-the-time account.

### Added

- Cross-CLI task dispatch skills wired through the orchestrator.

### Fixed

- Bracketed paste readiness is respected when submitting text to a session.
- Pane zoom and surface transparency are isolated per pane instead of leaking across them.
- SSH: a failed persist of a newly trusted host key no longer drops the connection, and the machine list carries `hasStoredPassword` so a restart stops re-prompting for a password already saved.
- Terminal layout and the close dialog: assorted stability fixes.

## 0.12.4 - 2026-08-11

Maintenance release: notification false-positive root-cause fixes, non-standard model context windows, terminal legibility on macOS, and TUI fidelity over wallpapers.

### Added

- **Cross-CLI durable task dispatch** — `dispatch_task` now resolves registered CLI adapters, persists a versioned `TaskBinding` envelope, preserves parent/session relationships, and exposes `get_task_dispatch` for restart-safe status inspection.
- **Launch profiles and skill delivery policy** — MCP launch configuration now carries provider, runtime, MCP, and skill compatibility decisions across the Rust, Tauri, and React layers.

- **`contextSize` on provider models** — Claude Code hard-validates `ANTHROPIC_MODEL` against a built-in 200k allowlist, so any model outside it (e.g. `MiniMax-M3-highspeed`) was silently forced to 200k with a stderr warning. Provider models now carry `contextSize` (`"1m"` / `"500k"` / `"200k"` / `"custom"`), injected as a `[size]` suffix when writing `ANTHROPIC_MODEL`; usage stats reverse-parse the suffix from the session jsonl. Set it in the Provider editor and the Ctx readout shows the real window. `context_window_tokens` is kept for backward compatibility.
- **"System" tab in the notification history** — session-exit and waiting-input notifications no longer interleave with AI rich summaries. The split keys off the backend-hardcoded `source` field (`terminal` = state-machine listener, `hook` = CLI hook channel) rather than guessing from title/kind text; "All" now excludes system notifications by default.

### Fixed

- **Terminal output flooding and WebGL recovery** — PTY writes now use FIFO backpressure; WebGL context loss releases the underlying context, falls back to DOM, and remains latched until an explicit renderer-mode change. Failed addon activation also releases its context.

- **"Waiting for input" false positives** — the root cause was matcher scope, not detection accuracy: `state-waiting-input` accepted 5 kinds of Claude Code Notification, and 3 of them do not mean "the agent is blocked". `idle_prompt` fires after 60s of input-box idling ("the human walked away"), and `turn_end` already notified once — that was the duplicate "just now / 4 minutes ago" pair, outside the 10s dedupe window. `elicitation_complete` / `elicitation_response` signal the dialog **ending** and the user having **answered** — semantically the opposite of WaitingInput, so they re-marked answered sessions as waiting and fired again. Only `permission_prompt` / `elicitation_dialog` remain. Tests lock all three regression sources and assert `HOOK_DEFS` and `map_cc_pane_event` stay in the same scope (they were hand-synced before, and drift means the installed hook disagrees with the runtime).
- **Blurry terminal text on macOS** — three causes stacked. `decideTerminalRenderer` downgraded *every* WebKit host to the DOM renderer (a guard against WKWebView leaving stale WebGL cell backgrounds after partial repaints), so macOS desktop never got WebGL; the renderer controller now has context-loss / atlas-rebuild / repaint recovery, so macOS desktop is allowed through while mobile WebKit (including iPad reporting itself as Macintosh) stays on DOM. The `body`-level `-webkit-font-smoothing: antialiased` suits Inter body text but thinned the monospace webfont's already-fine strokes — the terminal now uses `subpixel-antialiased`. And the bundled `Maple Mono NF CN` held the head of the font chain; on macOS `"SF Mono", Menlo` now come first, with the webfont kept in the chain for CJK coverage. Explicit user font chains are untouched; wallpaper transparency still forces DOM.
- **Full TUI preserved over wallpapers** — OpenCode and Grok stay in their native alternate-screen TUI; only explicit terminal background colors are stripped when wallpaper transparency is active. Adds streaming SGR coverage and transparent OpenCode configuration handling.
- **User-installed Grok on Windows** — long-running desktop and daemon processes now search the official Grok user bin directory and `GROK_HOME`. The OpenCode recovery hint points at the official npm registry to avoid broken mirror installs.
- Merged task queue checks repaired; `bind_pty_session` provider_id, the 1M fallback in `provider_window_for_request`, ContextUsageIndicator tests and a missing i18n key all landed with the dev/v0.12.3 working-tree merge.

### Docs

- `docs/87-git-collaboration.md` — active branch moved to `dev/v0.12.4`.
- `CLAUDE.md` — records the macOS cross-compilation release trap (CI green but tag red) and the `-sys` crate diagnostic.
- README — WeChat discussion group QR code added alongside the existing bug-report group; restored the two acknowledgements (Linux.do, sponsor relay hub) dropped when the 08-03 rewrite collapsed the list into a single pipe-separated line across all seven language versions.

<details>
<summary>中文版</summary>

维护版本：通知误报根治、非常规 model 的上下文窗口、macOS 终端可读性、壁纸下的 TUI 保真。

### 新增

- **跨 CLI 持久派工** — `dispatch_task` 现在按已注册 CLI 适配器解析目标，持久化带版本的 `TaskBinding` 信封，保留父任务/会话关系，并提供 `get_task_dispatch` 供重启后查询状态。
- **启动配置与 Skill 投递策略** — MCP 启动配置的 Provider、运行环境、MCP 与 Skill 兼容性决策已贯通 Rust、Tauri 和 React 各层。

- **Provider 模型的 `contextSize`** — Claude Code 对 `ANTHROPIC_MODEL` 按内置 200k 白名单强校验，不在表里的 model（如 `MiniMax-M3-highspeed`）会被强制按 200k 算并发 stderr 警告。现在 Provider 模型可带 `contextSize`（`"1m"` / `"500k"` / `"200k"` / `"custom"`），写入 `ANTHROPIC_MODEL` 时拼 `[size]` 后缀；用量统计从会话 jsonl 反解该后缀。在 Provider 编辑页设置后，Ctx 段即显示真实窗口。`context_window_tokens` 保留向后兼容。
- **通知历史的「系统」栏** — 会话退出、等待输入这类状态机通知不再与 AI 富摘要混排。判据用后端硬编码的 `source` 字段（`terminal` = 状态机 listener，`hook` = CLI hook 通道），不猜 title/kind 文本；「全部」默认排除系统通知。

### 修复

- **终端输出洪泛与 WebGL 恢复** — PTY 写入加入 FIFO 背压；WebGL context loss 会释放底层 context、降级 DOM，并保持锁存直到用户显式切换渲染模式。Addon 初始化失败也会释放 context。

- **「等待输入」误报** — 根因在匹配器口径而非判定精度：`state-waiting-input` 收了 5 类 Claude Code Notification，其中 3 类根本不是「agent 被挡住」。`idle_prompt` 是输入框闲置 60s 触发（人走开了），而 `turn_end` 已经通知过一次——截图里「刚刚 / 4 分钟前」的重复条即此源，超出 10s dedupe 窗口。`elicitation_complete` / `elicitation_response` 是对话框**结束**与用户**已回答**事件，语义与 WaitingInput 相反，会把答完的会话重新标成等待并再弹一条。现在只留 `permission_prompt` / `elicitation_dialog`。测试锁死三个误报源，并断言 `HOOK_DEFS` 与 `map_cc_pane_event` 同口径（此前两处手工同步，漂了就是装出去的 hook 与运行期判定打架）。
- **macOS 终端文字发虚** — 三个成因叠加。`decideTerminalRenderer` 把**所有** WebKit host 降级 DOM（原为规避 WKWebView 局部重绘残留旧单元格背景），macOS 桌面因此永远拿不到 WebGL；现渲染器控制器已有 context-loss / atlas 重建 / repaint 兜底，放行 macOS 桌面，移动端 WebKit（含报成 Macintosh 的 iPad）仍走 DOM。`body` 上的 `-webkit-font-smoothing: antialiased` 适合 Inter 正文，却把等宽 webfont 本就纤细的笔画磨得更细——终端区改用 `subpixel-antialiased`。打包的 `Maple Mono NF CN` 占住字体链首项，macOS 上改为 `"SF Mono", Menlo` 优先，webfont 留在链中继续兜 CJK。用户显式设定的字体链不动；壁纸透明仍强制 DOM。
- **壁纸下保留完整 TUI** — OpenCode 与 Grok 保持原生备用屏 TUI，壁纸透明生效时只剥离显式的终端背景色。补充流式 SGR 覆盖与 OpenCode 透明配置处理。
- **Windows 上用户自装的 Grok** — 常驻桌面与 daemon 进程现在会搜索官方 Grok 用户 bin 目录与 `GROK_HOME`。OpenCode 恢复提示改指官方 npm registry，避免镜像装坏。
- 修复合并后的任务队列校验；`bind_pty_session` 的 provider_id、`provider_window_for_request` 的 1M 兜底、ContextUsageIndicator 测试与缺失的 i18n key 随 dev/v0.12.3 工作树合并一并落地。

### 文档

- `docs/87-git-collaboration.md` — 活跃分支切到 `dev/v0.12.4`。
- `CLAUDE.md` — 记录 mac 交叉编译发版坑（CI 绿但 tag 红）与 `-sys` crate 判定法。
- README — 加入微信交流群二维码，与既有 Bug 反馈群并列；补回 08-03 改版把致谢压成单行管道分隔时漏掉的两条（Linux.do、赞助中转），七个语言版同时中招。

</details>

## 0.12.3 - 2026-08-10

Feature release: SSH remote file management, first-class human/AI todo separation with dispatch linkage, terminal garble root-cause fix (native alt-screen for codex/opencode + a buffer reset action), turn-end notification dedupe, and orchestration upgrades (reviewer reuse on the collaboration board, task-decomposition rules baked into dispatch skills, MCP tool-call statistics).

### Added

- **SSH remote file management** — browse, upload, download, and manage files on SSH machines from the right dock; connection workflow reworked with per-machine preferences, an SSH password dialog, and remote-terminal navigation helpers. Sidebar SSH machine cards rebuilt (item view, header actions, machine dialog).
- **Human/AI todo separation** — AI-created work items now carry a first-class `todoType: "ai-work-item"`: they get their own "AI work items" view in the todo panel and are excluded from "All tasks" / "Inbox" by default, so your personal backlog stays clean. MCP todo tools gained `todoType` / `tags` / `tag` / `excludeTodoType` parameters (the underlying capability existed but was hidden from AI).
- **Todo ↔ dispatch linkage** — dispatching a todo cluster now records the todo ids on the task binding (`metadata.todoIds`): todo rows show a "dispatched" badge that jumps to the running session, and the orchestration task detail panel lists its related todos with click-through. The mapping survives restarts (it used to live only inside the AI's conversation context).
- **Reviewer reuse on the collaboration board** — plan workers can register as `workerKind: "reviewer"`; the planreview skill now auto-discovers a live idle reviewer and offers to reuse it (same-topic follow-up reviews amortize context instead of cold-starting a new WSL Codex every time). The "existing window" review path now registers the worker properly (it used to bypass the board entirely).
- **Terminal buffer reset** — right-click → "Reset Terminal Buffer": clears screen + scrollback and asks the CLI to repaint. This is the correct fix for buffer-level garble (interleaved spinner frames) that "Refresh Terminal Display" cannot touch; destructive, so it asks first.
- **MCP tool-call statistics** — every MCP tool call increments a local counter (tool name + count + last-called only; no arguments, no content, no network). Groundwork for evidence-based tool-surface reduction (docs/89).

### Changed

- **codex / opencode now keep their native alternate screen** — the alt-screen stripping that preserved scroll history is now claude-only. For full-screen TUIs the "history" was frame debris anyway, and stripping caused permanently garbled scrollback (interleaved `WWoorrkk` spinner frames) that no repaint could fix. Per-CLI override available via `terminal.cliBufferModes` (`"strip"` / `"native"`); applies to new sessions.
- **Dispatch skills embed decomposition rules** — plantocodex / plantocc / plan2codexwsl / parallel / dispatch-todos now carry an executable splitting procedure (task-shape triage, 30min–3h cluster sizing, fan-out caps, per-unit acceptance gates, CLI routing incl. "reviews must cross models") plus a worker handshake (restate the task before starting) and evidence-pointer reporting. fanout-compare is narrowed to model-upgrade calibration only.
- **Notification ownership** — dispatched workers no longer send desktop notifications; they report to their leader, which sends one aggregated notification for the whole fleet.

### Fixed

- **Duplicate turn-end notifications** — AI rich summaries (via `trigger_notification`) and the state-machine fallback ("✅ Completed") were unaware of each other, so one turn produced two notifications. The rich notification now marks the turn; the fallback sees the mark and stays silent (falls back normally when the AI doesn't send one). Fulfils the 0.12.2 "one card stack" promise.
- Claude alt-screen behavior is now instrumented (`[alt-screen-probe]` console counter) to decide whether stripping is even a no-op for it — groundwork for docs/73's final fix.

### Docs

- `docs/89-mcp-tool-surface-reduction.md` — direction: shrink the MCP tool surface 90 → ~25 (CRUD merging + management-plane moving to `cc-panes-ctl`), with a privacy-hardlined usage-statistics prerequisite and the ctl/MCP capability boundary (identity / failure-domain / management-plane axes).
- `docs/90-worker-decomposition-model.md` — direction: contract-freeze fan-out, wide/deep task triage, and an executable skill-level splitting procedure; final ruling "design carries the load, optimistic concurrency by default" (collision-detection machinery rejected until rework-rate data says otherwise).
- `docs/73` — alt-screen re-audit with three rounds of cross-model review (SIGWINCH proven insufficient for scrollback pollution; semantics rulings recorded).
- `docs/articles/article-worktree-headless-coding.md` — opinion piece: worktrees in headless coding are a special-case tool, not default infrastructure.

<details>
<summary>中文版</summary>

功能版本：SSH 远程文件管理、人/AI 待办一等区分与派工联动、终端画面错乱根治（codex/opencode 回归原生备用屏 + 缓冲区重置入口）、回合通知去重，以及编排升级（协作板 reviewer 复用、拆分规则进派工 skill、MCP 工具调用统计）。

#### 新增

- **SSH 远程文件管理**——右侧 Dock 直接浏览/上传/下载/管理 SSH 机器上的文件；连接工作流重做（按机器偏好、SSH 密码弹窗、远程终端导航联动），侧栏 SSH 机器卡片全面重构。
- **人/AI 待办分离**——AI 创建的工作项带一等身份 `todoType: "ai-work-item"`：todo 面板新增「AI 工作项」独立视图，「所有任务」「收件箱」默认排除,你的个人待办不再被 AI 的活淹没。MCP todo 工具补齐 `todoType`/`tags`/`tag`/`excludeTodoType` 参数（底层能力早已存在,此前对 AI 屏蔽）。
- **待办 ↔ 派工联动**——派发一簇 todo 时把 todo id 记进任务绑定（`metadata.todoIds`）：todo 行显示「已派」徽章可跳转会话，编排任务详情面板列出关联 todo 可互跳。映射跨重启可查（此前只活在 AI 对话上下文里,会话一关就没了）。
- **协作板 reviewer 复用**——plan worker 可登记为 `workerKind: "reviewer"`；planreview skill 自动发现活着的空闲 reviewer 并建议复用（同主题续审摊销上下文,不再每次冷启动新的 WSL Codex）。「已有窗口」评审分支补上了登记缺口（此前完全绕过协作板）。
- **终端缓冲区重置**——右键 →「重置终端缓冲区」：清屏+清回滚历史+让 CLI 整屏重绘。这是 buffer 级错乱（spinner 残帧交错）的对症药——「刷新终端显示」治不了那类；破坏性操作,先确认再执行。
- **MCP 工具调用统计**——每次 MCP 工具调用在本地计数（只记工具名+次数+最后时间；不记参数、不记内容、零联网）。为「用数据裁剪工具面」攒依据（docs/89）。

#### 变更

- **codex / opencode 回归原生备用屏**——为保滚动历史而剥 alt-screen 的做法现在仅对 claude 保留。全屏 TUI 的「历史」本就是残影,剥离反而造成回滚区永久污染（`WWoorrkk` 交错残帧）且无法修复。可按 CLI 覆盖：`terminal.cliBufferModes`（`"strip"`/`"native"`）,对新会话生效。
- **派工 skill 内嵌拆分规则**——plantocodex / plantocc / plan2codexwsl / parallel 系 / dispatch-todos 带上可执行的拆分程序（任务形状判定、单簇 30 分钟~3 小时、扇出上限、逐单元验收门、CLI 路由含「评审必须换模型」），外加 worker 复述握手与证据指针报告。fanout-compare 收窄为「换模型版本时的能力标定」专用。
- **通知归属**——被派发的 worker 不再各自发桌面通知；统一汇报给 leader,由 leader 替整个编队发一条汇总。

#### 修复

- **回合结束重复通知**——AI 富摘要（`trigger_notification`）与状态机兜底（"✅ Completed"）互不相识,同一轮活收两条。现在富通知打标、兜底见标即静默（AI 没发时兜底照常）,兑现 0.12.2「汇入同一卡片栈」的承诺。
- claude 的 alt-screen 行为加了探针（`[alt-screen-probe]` 控制台计数）,用于判定剥离对它是否本就无效——docs/73 终局修复的前置。

#### 文档

- `docs/89`——MCP 工具面收编方向（90 → ~25）＋用量统计隐私红线＋ctl/MCP 能力分界。
- `docs/90`——派工模型：契约冻结换扇形并行 / 宽深任务判别 / skill 可执行拆分规则；终局裁决「设计承重、乐观默认」。
- `docs/73`——alt-screen 三轮交叉评审复审记录。
- `docs/articles/`——新目录,首篇《Headless Coding 时代,worktree 是不是伪需求?》。

</details>

## 0.12.2 - 2026-08-09

Feature release: IM outbound notifications (DingTalk / WeCom / Feishu), a unified bottom-right notification center, a reworked onboarding experience, custom OpenAI-compatible voice transcription, and a consolidated settings structure. Also hardens WSL script execution and the updater manifest pipeline.

### Added

- **IM notification bridge (batch 1, outbound)** — session events (turn end / waiting for input / error / exit) can now push to DingTalk, WeCom (Enterprise WeChat), and Feishu group bots. Configure channels under Settings → IM; each channel has a "send test" button. The `cc-notify` crate was reworked into a pure protocol layer with a WeCom channel added. Two-way interaction is on the roadmap (docs/88).
- **Unified notification center** — session events, AI-initiated notifications (MCP `trigger_notification`), and update prompts now flow into one bottom-right card stack with a bell-icon history panel in the status bar. AI notifications can declare `requiresInput` + `sessionId`: the card grows an input box and the user's reply is submitted straight back to that terminal session. Notification ids/timestamps are now backend-generated (consistent across windows).
- **Voice input: custom OpenAI-compatible provider** — standard `/v1/audio/transcriptions` multipart endpoint with configurable base URL and optional API key. Covers cloud scale-out (OpenAI Whisper / Groq / SiliconFlow) and local self-hosting (whisper.cpp server / faster-whisper) with zero app weight. Provider dispatch consolidated into a Rust enum + frontend capability table with a Rust↔TS whitelist mirror guard.
- **Onboarding rework (all four cards)** — the setup checklist became a journey bar (progress ring + five-node rail + a single focused next-step CTA + a persistent Tutorial button; collapses to a success bar when complete); the first-run guide merged five steps into four (mode chips join the environment preflight), gained a step navigator, a state-following primary button on the workspace step, and an "aha stand-back": after the side-by-side launch the dialog fades for 2.6s so you can watch both terminals start. Home value cards now lead with multi-agent orchestration and carry small illustrative graphics; feature-tip dialogs regrouped their secondary links with an amber passthrough warning.
- **User guide expansion** — first-launch chapter now opens with "let the AI drive the exoskeleton" (right-click the auto-created `default` workspace → open Claude, and try MCP) and the "clean workspace" convention (keep the workspace container directory separate from Git repos; the AI can set the whole thing up via MCP). Starred-layout mirror wall documented for the first time.
- Terminal path links can open explicit external directories with an amber out-of-project warning in the confirmation dialog (`outsideProjectRoot` made explicit at the command layer).

### Changed

- **Settings consolidated** (by Curl) — providers, Skills, and CC-chan entries moved into a unified settings structure; the duplicate Resource Hub page was removed. Cross-CLI usage statistics gained a status-bar preview, keeping standalone entries and the settings page in sync. Settings layout now aligns adaptively across detail pages.
- **Todo workspace reworked** (by Curl) — unified list, overview, and editor experience with new creation entry points.
- Voice transcription logic moved from the command layer into `voice_service.rs` (pure migration, command layer keeps only the enabled check).

### Fixed

- **WSL: codex trust pre-write silently produced corrupt data** — `wsl.exe`'s argv translation mangles `"$(cmd arg)"` quoting (exit 0 but broken output). Scripts now go through stdin (`bash -l -s`) with parameters passed via WSLENV `/u` (appending to, not overwriting, the user's WSLENV).
- **Uninstall now reclaims WSL-side injections** — codex trust markers, codex skills, and claude command namespaces written inside WSL distros are enumerated and cleaned per-distro (infrastructure distros skipped, unreachable distros surfaced as failed, 30s timeout against wedged WSL).
- **Updater manifest race fixed at the root** — five release jobs no longer race-write `latest.json`; each job produces a metadata artifact and a serial publish job aggregates from scratch (v0.12.1's live manifest had dropped to 2 platforms, cutting mac/Win-x64 users off from updates). Includes per-arch renaming of colliding mac `.app.tar.gz` names and a `::warning::` when a platform is missing.
- Theme shape allow-list now has a Rust↔TS mirror guard test (previously dual-maintained by hand; a miss on either side silently fell back to Soft with zero errors).
- CI command registration and line-count ratchet fixes; large components split (by Curl).

### Docs

- `docs/87-git-collaboration.md` — branch model (main / dev/v* / release/*), PR base rules, the seven-step release procedure, and multi-AI-instance parallel discipline.
- `docs/88-im-bridge.md` — IM bridge research: three-platform findings, security model, and the two-way roadmap (DingTalk Stream / WeCom intelligent-bot protocols are public and self-implementable; Feishu's frame protocol is not, so it gets pseudo-two-way deep links).

<details>
<summary>中文版</summary>

功能版本：IM 出站通知（钉钉/企微/飞书）、统一右下角通知中心、新手引导全面重做、自定义 OpenAI 兼容语音转写、设置结构整合。同时加固了 WSL 脚本执行链路与更新清单发布管线。

#### 新增

- **IM 通知桥（批次 1，出站）**——会话事件（任务完成 / 等待输入 / 出错 / 退出）现在可以推送到钉钉、企业微信、飞书的群机器人。在 设置 → IM 外推 配置渠道，每个渠道带「发送测试」按钮。`cc-notify` crate 重构为纯协议层并补齐企微渠道。双向交互在路线图上（docs/88）。
- **统一通知中心**——会话事件、AI 主动通知（MCP `trigger_notification`）、更新提示汇入同一个右下角卡片栈，状态栏新增铃铛展开历史面板。AI 通知可声明 `requiresInput` + `sessionId`：卡片长出输入框，用户的回复直接提交回目标终端会话。通知 id/时间戳改由后端生成（跨窗口一致）。
- **语音输入：自定义 OpenAI 兼容 provider**——标准 `/v1/audio/transcriptions` multipart 接口，baseUrl 可配、API Key 可空。一步覆盖云端扩容（OpenAI Whisper / Groq / SiliconFlow）与本地自托管（whisper.cpp server / faster-whisper），应用零增重。provider 分发收敛为 Rust enum + 前端能力表，带 Rust↔TS 白名单镜像守卫。
- **新手引导全面重做（四块卡片）**——上手清单变身旅程条（进度环 + 五节点轨道 + 唯一聚焦的下一步 CTA + 常驻「新手教程」按钮，全部完成后收束成一条成功横条）；首启向导五步并四步（模式双选并入环境预检），新增步骤导航、建空间步主按钮跟随输入态，以及「aha 退让」：并排启动后弹窗淡出 2.6 秒，让你亲眼看到两个终端启动。主页价值卡以多 agent 编排打头并配微型图示；功能提示弹窗次要链接归组、passthrough 警示改琥珀底。
- **使用手册扩容**——首启章节开篇改为「让 AI 指挥外骨骼」（右键自动创建的 `default` 工作空间 → 打开 Claude 试 MCP）和「干净的工作空间」约定（容器目录与 Git 仓库分开；整套可让 AI 经 MCP 代办）。星标布局监视墙首次成文。
- 终端路径链接可打开显式的项目外目录，确认框带琥珀越界警示（`outsideProjectRoot` 在命令层显式化）。

#### 变更

- **设置整合**（Curl 贡献）——供应商、Skills、CC酱入口并入统一设置结构，移除重复的资源中心页面。跨 CLI 用量统计补齐状态栏预览，独立入口与设置页数据不再各说各话。设置布局跨详情页自适应对齐。
- **Todo 工作区重构**（Curl 贡献）——列表、概览、编辑体验统一，新建入口重做。
- 语音转写逻辑从命令层迁入 `voice_service.rs`（纯迁移，命令层只留开关校验）。

#### 修复

- **WSL：codex trust 预写静默产出坏数据**——`wsl.exe` 的 argv 转换会搅坏 `"$(cmd arg)"` 引号形态（exit 0 但输出损坏）。脚本改走 stdin（`bash -l -s`），参数经 WSLENV `/u` 透传（叠加而非覆盖用户已有 WSLENV）。
- **卸载现在会回收 WSL 侧注入**——写进发行版内的 codex trust 标记、codex skills、claude commands 命名空间逐发行版枚举清理（基础设施发行版跳过、不可达发行版显式报 failed、30s 超时防 WSL 卡死拖累）。
- **更新清单竞态根治**——五个发布 job 不再并行争写 `latest.json`；各 job 产出元数据工件，由串行发布 job 从零聚合（v0.12.1 线上清单一度掉到只剩 2 个平台，mac/Win-x64 用户收不到更新）。含 mac `.app.tar.gz` 同名互撞的按架构重命名，以及缺平台时的 `::warning::` 显式告警。
- 主题形态允许列表新增 Rust↔TS 镜像守卫测试（此前双份手工维护，任一侧漏改都会零报错静默回落 Soft）。
- CI 命令注册与行数门禁修复，大型组件拆分（Curl 贡献）。

#### 文档

- `docs/87-git-collaboration.md`——分支模型（main / dev/v* / release/*）、PR base 规则、发版七步流程、多 AI 实例并行纪律。
- `docs/88-im-bridge.md`——IM 桥调研：三平台结论、安全模型、双向路线图（钉钉 Stream / 企微智能机器人协议公开可自实现；飞书帧协议不公开，走伪双向深链）。

</details>

## 0.12.1 - 2026-08-08

Stabilization release on top of 0.12.0-beta.1: interface shapes land as stable, settings move into a modal, and a three-front macOS fix (CLI path resolution, startup crash on macOS ≤13, user CLI config hygiene) closes out the platform's worst gaps. macOS code is now compiled, linted, and tested in CI for the first time.

### Added

- **Color and shape can now be combined freely.** Alongside the six color themes, CC-Panes now includes Soft, Slab, Sharp, Glass, Panel, and Carbon interface shapes.
- **Settings consolidated into a modal** with grouped sections; task orchestration lives in the persistent right dock, and CLI/provider selection is unified as dropdown controls.
- **Terminal path links can open explicit external directories** on desktop after a confirmation dialog (project-internal symlink/junction escapes are still hard-rejected; web/API remain project-only).
- macOS code signing + notarization wiring in the release pipeline (activates automatically once Apple Developer secrets are configured; no behavior change until then).

### Fixed

- **macOS: CLI not found (claude/codex)** — nvm version directories were picked by lexicographic order (`v9 > v20`); now semver-aware. Scan list gains bun/pnpm/volta/asdf/fnm. Missing `$SHELL` falls back to `/bin/zsh`. When every whitelist misses, a one-shot synchronous login-shell PATH grab covers the first-launch window; the daemon now inherits the cached PATH explicitly. See `docs/85-cli-launcher-overrides.md` for the troubleshooting ladder.
- **macOS 10.15–13: crash on launch** — `NSApplication.activate()` is a macOS 14+ API dispatched at runtime with no availability guard; now probed via `respondsToSelector:` with a fallback to `activateIgnoringOtherApps:`.
- **Claude sessions launched from CC-Panes lost transcript saving** — a `CLAUDE_CODE_CHILD_SESSION` marker inherited from the environment leaked into every PTY; the claude adapter now strips it alongside `CLAUDECODE`.
- **Restarting the app no longer resumes sessions at a stale point in history** — three-front fix for resume-chain staleness (docs/86): `useResumeBindingStore` becomes the single authoritative mirror of resume identity (keyed by PTY session, persisted with TTL), resume-id write-back gets an outbox with acks and a doubled retry window, and resume failures surface in the UI instead of a backend-only warning. Cold-replayed output is validated for freshness and cleared on terminal failure.
- **Codex YOLO trust entries are now recoverable** — entries written to `~/.codex/config.toml` carry an ownership marker, are backed up before first write, and `cleanup_user_injections` removes only marked entries (user-written trust decisions are never touched).
- Grok shared MCP sync no longer silently overwrites a user-defined entry of the same name (ownership signature check, matching the existing ccpanes-entry behavior).
- Corrupted `.claude/settings.local.json` now aborts hook sync instead of silently resetting the user's file; project-level settings/hooks writes are atomic and serialized.
- Uninstall cleanup also removes `~/.codex/config.toml.bak` and `~/.grok/config.toml.bak`.
- Gatekeeper guidance updated: the "right-click → Open" bypass no longer exists on macOS 15 Sequoia; docs and release notes now lead with System Settings / `xattr -cr`.

### CI

- Backend checks now run on macOS (previously the macOS code paths were only ever compiled during tag releases); `release/*` branches trigger CI; `cargo test` uses `--no-fail-fast`; the flaky `start_runner_integration` test waits for command echo before submitting.

## 0.12.0-beta.1 - 2026-08-07

> Beta 预发布：不进稳定版自动更新通道，手动下载试用。checkpoint 恢复链与 hidden 闸门需要 daemon 随包更新后才完整生效。

Lifecycle release: the docs/78 five-batch tab-lifecycle rework lands in full, plus the M3b checkpoint+delta recovery unification. 100+ commits, three external review rounds, all gates green.

### Added

- **Checkpoint+delta terminal recovery (M3b)**: the frontend periodically photographs terminal screens (SerializeAddon) and uploads them to the daemon; recovery replays photo + delta instead of an 8MB byte ring. Long sessions no longer grow daemon memory linearly, recovery depth is no longer capped at 8MB, and dead-session restore carries full screen semantics. Uploads activate automatically after the first recovery read (epoch handshake); old daemons degrade gracefully (capability probe + legacy fallback).
- **Per-view visibility single source** (`useTabViewStateStore`, keyed `owner:role`): starred mirrors, popup windows, SelfChat and the mobile prototype all report real visibility. Watching a starred mirror now keeps the origin tab awake; popped-out terminals no longer freeze when the main window switches away.
- **Background attention marks**: background agent sessions that error out or wait for input show a red dot on their tab; switching to the tab clears it automatically.
- **Close confirmation for busy agents**: closing a tab whose agent session is running/waiting-for-input asks first (itemized dialog); plain shells close silently. Undo re-open now also restores browser tabs (URL) and editor tabs (file path).
- **Input-aware hibernation**: typing into a working agent blocks hibernation (draft protection); answering a permission prompt does not (segment-attributed input, Orca-style).
- Snapshot-apply kill switch (`terminal.snapshotApplyKillEnabled`, default off) with a repaired observation chain: protection sets now share one source with the orphan GC, unreachable sources abandon the round instead of shrinking protection, and dangling candidates expire after 60s.

### Changed

- **Destroy paths unified**: every tab-closing route (close/batch/pane/layout-delete/snapshot-apply/backend/editor-path) goes through one pipeline with an explicit policy matrix (vetoable / undo / pinned / kills / popups). Six legacy scattered exits deleted; killSession call sites are whitelist-guarded in CI.
- **Recovery read path 5→1**: attach, crash restore, desync replay, overflow recovery and hibernation wake all read one structured `getRecoverySnapshot` (photo written verbatim, delta through the render pipeline).
- Polling-degraded bridge no longer resends the whole snapshot as an "increment" on prefix mismatch (which duplicated the screen) — it emits a desync and rebuilds from snapshot.
- Pure tree helpers moved to `web/lib/paneTree.ts` (layer inversion fixed); `closedTabsCap` renamed `closedTabsUndo`; `removeTabsInternal` split into three named stages.
- Boundary contract table now covers both directions (daemon→app events and app→daemon messages, REST or control-ws), with cross-language exhaustive guards.

### Fixed

- Dragging a tab out of a pane can no longer kill the sessions left behind (tree ops and destroy physically separated; non-empty pane removal is rejected).
- Layout delete now uses the saved-session-inclusive kill scope (restoring sessions no longer leak as orphans) and sweeps view/attention satellite state.
- launchId is freshly generated per launch (docs/69): restored sessions bind resume ids again instead of silently degrading forever.
- Per-session context-usage cache entries are reclaimed on destroy (previously only evicted at the 64-entry cap).
- Hidden-session reporting failures are now observable (debug logs both sides; report retries after failure).

## 0.11.13 - 2026-08-06

This release integrates a substantial community contribution batch (PR #55, thanks @zhengjunkj), reworked where needed to fit the Provider UI redesign and session-provenance fixes that landed just before it.

### Added

- **Cold restore for sessions stranded by an abnormal exit.** When the app dies and comes back against an old daemon that cannot prove session ownership, blocked terminals used to offer nothing but a dead end. Restores now distinguish the cases: an in-process live session reattaches directly; a session that is provably gone restores silently; only a still-live session behind a claims-incapable daemon stays blocked — and now shows an explicit "end the old terminal and restore" button that kills the old process first and only then recreates. The fail-closed identity checks are unchanged. New restore-log events are covered by the plain-language log in both languages.
- **Per-terminal status bar.** In multi-pane layouts each terminal gets a bottom bar with its session state, CLI, model, effort, context usage, and project path (right-click to hide; hidden entirely in single-pane layouts where the space matters). Context usage is now tracked **per terminal** instead of the focused terminal overwriting everyone's numbers, with per-session snapshots that are cleaned up on session exit and capped as a backstop. Two new terminal settings control the status bar and the global context indicator.
- **Context windows finally reflect your provider's models.** Provider model entries can declare a context window (with common-capacity presets in the editor); usage indicators prefer the transcript's measured window, fall back to the provider's configured one, and show usage-without-percentage instead of an error when neither is known. Claude's hardcoded 200k assumption is gone. `launch_history` now records the model per launch (migration v30).
- **Duplicating a provider now creates a copy** instead of silently editing the original, with a fresh id on every save.
- **Claude managed-mode providers inject environment through a per-session `--settings` file** — credentials no longer pass through CLI arguments, and your own `~/.claude.json` remains untouched. Stale per-session files are cleaned up like their MCP counterparts. Two behaviors are documented for verification: empty-string resets and subagent model pinning (docs/82 §8).
- **Theme presets.** Multiple built-in themes with live preview and a wallpaper preview panel; the status-bar theme button becomes a menu. Old light/dark choices migrate. The color guard now checks token parity across every theme block.
- **Terminal path-link dialog.** Paths printed in terminal output become clickable, with a confirmation dialog that opens the file in the editor — hardened against URI schemes, control characters, path escapes, and non-local runtimes.
- **Lazy-loaded views self-heal after an update.** A failed chunk fetch (typically a stale module map after upgrading) retries with cache busting per tab or settings pane instead of taking the whole window to an error page.
- **Windows portable build.** Every release now ships `cc-panes_<version>_x64-portable.zip` — the installer payload repackaged byte-identical, no installation required (data still lives in `~/.cc-panes`).

## 0.11.12 - 2026-08-05

### Added

- **The workspace tree gained a second display mode: running terminals.** A toggle in the sidebar section header switches each workspace between its project list and the terminals currently running in it. Terminal rows are named by **the first thing you asked that session to do** (falling back to the tab title until the transcript index catches up — at most a minute), with the project/CLI context demoted to a second line. The right side shows the session state as a colored dot plus a status word (amber for waiting on input, red for error, pulsing accent for working); split-pane tabs aggregate to their most severe state with a ×N count. Clicking a row focuses that tab across layouts and views. Rows keep a stable order rather than re-sorting by status, so the row you are about to click never jumps away. The chosen mode persists across restarts.

### Fixed

- **Window controls work again and the settings panel no longer fights the browser overlay.** Minimize/maximize/close are routed through the native main window, the settings dialog is no longer covered by an embedded browser WebView, and browser protocol errors show localized messages instead of raw errors. (PR #54, contributed by @Curl-007)

## 0.11.11 - 2026-08-05

### Fixed

- **Sessions dispatched via `launch_task` could never be reclaimed after an app restart.** Session restore requires a birth certificate (daemon generation + birth nonce) persisted at creation, but only the manual-launch and REST paths wrote one — the orchestrator path used by `launch_task` and runners never did. Every dispatched worker (in practice almost all WSL Codex sessions — 41 of 47 missing rows on the reporting machine) was permanently blocked by the identity check with "identity mismatch" while manually opened terminals reattached fine. All creation paths now persist provenance through one shared fail-closed helper, and on startup the app backfills provenance for live daemon sessions that predate the fix, so existing stranded sessions become reclaimable too.

### Changed

- **The terminal restore log now reads as plain language instead of raw JSON.** Restore events are kept structured, rendered with a local timestamp, severity coloring, and human-readable text in both Chinese and English ("this round: 15 reattached, 0 skipped, 1 blocked", "session still held by the previous app instance — the write lease expires in 30 seconds and this retries automatically"). A toggle reveals the original event payloads for debugging; unknown events fall back to raw display so nothing is ever hidden.
- **Settings → Provider was redesigned** (docs/46 conformance). The three stacked navigation rows collapsed into a single header (segmented sub-page switch + uniformly sized CLI chips + page actions); the launch-profile page went single-column with a summary strip, a Switch row for YOLO (its own half-empty card is gone), neutral checkbox rows instead of full-blue selection fills, and collapsible groups with enabled-item chips and inner scrolling for long skill/MCP lists plus a cross-group search; shared-MCP management moved into a right-side sheet; the credentials page became one centered column. Under the hood: five new UI primitives (card/segmented/checkbox/checkbox-row/collapsible-group, plus a Radix select), CLI brand colors are theme tokens now, and the 2139-line panel was split into files each under 500 lines.

## 0.11.10 - 2026-08-05

This release is mostly community contributions. Thanks to @zhengjunkj, @Curl-007 and @yanjiuding.

### Breaking

- **Codex no longer accepts `config_profile` providers.** Codex's managed configuration is written as an OpenAI-compatible provider block, and a `config_profile` binding cannot be expressed that way — it used to be accepted and then quietly ignored. It is now rejected at launch with `PROVIDER_INCOMPATIBLE` naming the offending provider. If a Codex launch stops working after upgrading, open Settings → Providers and rebind it to an OpenAI-compatible provider. `config_profile` remains valid for Claude.
- **Per-CLI default providers whose type does not match that CLI are dropped on first launch.** These bindings could never have launched successfully; the affected CLI falls back to its native mode. Nothing tells you this happened, so if a CLI you had pointed at a specific provider starts behaving like a fresh install, check Settings → Providers first.

### Added

- **Providers now have an explicit managed mode.** Previously the only way to run a CLI against a non-default endpoint was to edit that CLI's own configuration files, which meant CC-Panes and the CLI could disagree about which provider was in use — and a wrong provider looks exactly like a right one. In managed mode CC-Panes writes a private, per-session configuration for the CLI instead, and a provider that cannot be honored fails the launch outright rather than silently falling back to the CLI's own settings. Your own `~/.config/opencode/config.json`, `~/.codex/`, and `~/.claude.json` are read but never written. Native mode — the CLI uses its own configuration, as before — remains available per launch profile.
- **Model selection per provider.** Launch profiles can pin a specific model rather than taking the provider default.
- **Context usage in the status bar.** Claude and Codex sessions show how much of the context window is consumed, so a compaction is no longer a surprise. It polls only while a supported session is active and stops while the window is hidden.
- **Managed providers work for WSL sessions.** The configuration is written on the Linux side with paths translated accordingly, rather than pointing the CLI at a Windows path it cannot read.
- **README documents web access and background settings**, with recordings for both.

### Fixed

- **OpenCode could hang forever at launch.** A managed configuration write that never completed left the launch with no timeout and no error — the pane simply stayed empty. Configuration writes now have a deadline, and a launch that exceeds the overall time limit is reported as a launch timeout, cleaned up, and distinguished from a session that genuinely exited. On a slow or network-backed disk this deadline may be tight; if you hit it, the error names the stage that timed out.
- **Installing an update from the status bar, the home header, or Settings → About gave no warning about running sessions.** Installing stops the terminal daemon and restarts the app, which interrupts every running agent. Only the update card asked for confirmation; the other three entry points went straight to install. All of them now warn when sessions are running.
- **Provider configuration files are written atomically**, so an interrupted write can no longer leave a CLI pointed at a truncated configuration. On Unix they are created with owner-only permissions.
- **The layout context menu could appear behind the layout selector.**
- **The ccchan window and the web access settings page were English-only** regardless of the selected language.
- **Native controls follow the theme** (date pickers, scrollbars, and similar) instead of always rendering light.
- **Pasting into the terminal no longer forces an IME context rebuild on Linux.** The rebuild was added for issue #41 (input method state surviving a paste on WebKitGTK) and has been removed after testing on Linux; the guard itself is unchanged and still covers explicit clearing. Note that no test now covers the paste path specifically — if #41 resurfaces, this is where to look.
- **The Vite dev server no longer watches Rust build output directories**, which could grow to hundreds of thousands of files and stall the dev server.

## 0.11.9 - 2026-08-03

### Fixed

- **Many open tabs slowly dragged the UI down over hours.** Every mounted tab kept its full terminal buffer live in memory — measured at 3.8 GB and a persistently busy renderer after three days with 14 tabs — because 20,000 lines of scrollback per tab never went away. Tabs left in the background now step down in two stages: after five minutes the GPU renderer is suspended (freeing its share of the ~16 WebGL context budget), and after thirty minutes the whole terminal is hibernated — its entire buffer, colors and scrollback included, is serialized into a compact string and the live instance is destroyed. Switching back rebuilds and replays it in place: nothing you could scroll to before is lost, and output produced while hibernated is appended in order. Only a session that printed more than 4 MB while hibernated falls back to the daemon's replay snapshot.
- **A slow client could grow the daemon's memory without bound.** Terminal output fanned out to WebSocket subscribers through unbounded queues, so one stalled connection accumulated everything a busy session printed. Session mirrors are now bounded, and overflow follows a strict contract: output is skipped in whole chunks — never mid-escape-sequence, which would corrupt the screen — and once the client catches up it receives a desync marker and repaints cleanly from the replay snapshot. Exit and kill notifications are never dropped; when the mirror is full they arrive through the control channel instead. Older clients ignore the marker and behave no worse than before.
- **Terminal write flow control only protected Windows.** The backpressure that keeps a flooding session from overwhelming the renderer was enabled per-platform; it now applies everywhere.
- **Scrollback settings apply immediately and can no longer be set to absurd values.** Changing the scrollback limit used to affect only terminals created afterwards; it now applies to every open terminal at once, and the input is clamped to a sane range. The default is unchanged.

### Changed

- **Layout cards were redesigned for readability** (docs/75). Session states are triple-encoded — shape, color, and count — instead of color-only dots, so danger/waiting/running/idle are distinguishable without hover and without full color vision. The comfortable and compact densities now count the same things; cards count all tab kinds rather than terminals only; rename and delete are available from every card's context menu; and browser tabs and the file explorer gained desktop creation entries.

## 0.11.8 - 2026-08-02

### Fixed

- **A restored session could only be restored once.** `launch_history.project_id` is a one-shot launch id, not a project id, but a tab reused it across restarts — and that row's PTY slot was already taken by the previous run, so the incoming resume id had nowhere to land and was dropped. The session came back with no conversation, and because the empty session was itself a product of the restore path, the next restart lost it again. Measured before the fix: 18 of 18 tabs came back empty and every one of six delivered resume ids was discarded. Each terminal leaf now carries its own launch id, generated fresh whenever a PTY is actually created, so a split pane no longer has two PTYs fighting over one history row.
- **Updating killed every running session.** The installer terminated the terminal daemon with a whole-process-tree kill, and every PTY lives underneath it — so installing an update took down all of your running agents. The updater now leaves the daemon alone and renames the old binary so the new one can still be written; the app retires the old daemon only when no sessions are live and no other desktop instance is sharing it.
- **One busy pane could bring the whole machine to a crawl.** PTY children competed with the app's own UI on equal footing, so a `cargo build` or a large `rg` in any pane could saturate the machine, with no intervention short of killing the process. Sessions now start at a lowered scheduling priority. Note the process-reclaim guarantee and the resource policy are applied as two separate steps, so a rejected priority change can never cost you the crash-cleanup safety net.
- **Terminal output could come back garbled, and "Refresh terminal display" didn't help.** The corruption happens at the buffer level, so a repaint cannot undo it; the refresh action now also resizes the terminal to force the CLI to redraw. This mitigates the symptom rather than removing the cause — the underlying alt-screen stripping is unchanged and still being worked on.
- **Background tabs kept parsing and rendering at full speed.** A hidden tab stayed mounted and processed every byte, so N noisy background sessions meant N parsers competing for the main thread. Output is now buffered while a tab is hidden and replayed when you return, with a bound on how much is held. A session that exits in the background flushes its remaining output before the exit notice, so the last thing it printed is no longer reordered or lost.
- **MCP-opened browser tabs and files landed in the wrong layout.** Opening something from an agent put it in whatever layout you happened to be viewing rather than the agent's own, so a background agent could yank a tab into your workspace. They now open where the caller is.
- **The web access server left orphans behind when the app died.** Its child process was terminated with a call that only reaches the direct child, so a crash or force-kill stranded the server and its descendants holding the port. It is now bound to an OS-level guard that reclaims the whole tree however the app exits, and shuts down cooperatively when asked.

### Added

- **Per-session process detail in the resource popover.** Session-level totals told you a session was busy but not which process was responsible; the list now expands, with a summary line when there are too many to show.
- **OpenCode session history.** Launching and resuming OpenCode already worked, but there was no way to obtain a session id — OpenCode neither issues one nor reports it over OSC, so its own database has to be consulted. Past sessions are now listed for binding and resume.

### Fixed

- **Restored sessions come back without their conversation.** Moving the PTY into the terminal daemon silently cut two links that still read from the app's own in-process state, which is always empty in daemon mode. Deterministic resume ids — Claude's issued session id and Codex's OSC title — were emitted inside the daemon and discarded by its event bridge, so no launch recorded a resume id and a restored session had nothing to resume from. Terminal scrollback stopped being written for the same reason, so a session that outlived its daemon restored as a blank pane. Both now cross the daemon boundary, and the daemon persists its own scrollback on session exit and on graceful shutdown using atomic writes, so a crash or a concurrent flush cannot truncate the last good snapshot.
- **Identity events survive startup and WebView recovery.** The daemon control channel is a broadcast with no replay, so a resume id emitted before the desktop finished connecting was lost permanently — and startup is exactly when session recovery creates sessions in bulk. The daemon now retains the highest-confidence identity event per session and the desktop replays only what it has not already applied. Resume ids are persisted directly rather than travelling as an interface event, so they no longer disappear while the WebView is recovering.
- **Session side effects reach the desktop again.** The daemon ran without a session notifier, so waiting-for-input inferred from the terminal, exit notifications, last-prompt backfill, and assistant reminders silently stopped for every CLI without a hook. These now cross the daemon boundary and are handled by the same desktop implementation used for local sessions, with duplicate suppression so a hook and the terminal cannot both raise the same notification.
- **Launch warnings were invisible under the daemon.** Profile fallback and missing Codex resume targets are reported again; the profile-mismatch warning carries no session id and was being discarded before reaching its handler, so an explicitly chosen launch profile could be dropped with no indication at all.
- **Sessions started through the REST launch endpoint were never recorded.** External clients and the control CLI created sessions with no launch history row, so no resume id could bind to them and they could not be recovered after a restart. The row is now written synchronously, a resume id supplied at launch binds immediately, and a failed write is reported in the response instead of returning success for an unrecoverable session.
- **New sessions no longer pull you away from the layout you are using.** A launch lands in its bound layout without switching your view; the layout only changes when the caller names one explicitly or you enable following agent launches, and never for silent launches. Workers dispatched by a leader still land beside the leader so hierarchical tab numbering holds.
- **Empty panes are readable over wallpaper** and degrade gracefully in narrow panes.

### Added

- **Drag and drop across the sidebar and layout bar.** Workspaces can be dragged into groups, and a terminal tab can be dragged straight onto a layout tab to move it there.

## 0.11.6 - 2026-07-30

### Fixed

- **Hidden-layout terminal recovery.** Restored panes now attach or create their PTY as soon as xterm is initialized instead of waiting for a successful fit on a visible tab. A restore already queued continues when the user switches layouts, preventing panes from remaining stuck with no session after restart.

## 0.11.5 - 2026-07-30

### Fixed

- **Atomic terminal resume handoff.** Restore-time session creation now asks the daemon to atomically adopt the exact saved PTY or create a replacement only after proving the old process is gone. Claim conflicts, missing provenance, and project/runtime/CLI/resume mismatches fail closed; foreground, deferred-layout, and background restore paths also recheck their leaf after creation and remove any duplicate PTY that loses the race.
- **Moved-terminal recovery.** Immutable daemon birth anchors are no longer confused with the terminal's mutable current layout anchor, so tabs moved across panes or layouts can reattach safely. When a current anchor has multiple live historical candidates, a unique saved session id may select its exact candidate; unresolved ambiguity remains blocked.
- **Reused-session persistence safety.** Tauri and Web preserve the existing SQLite layout observation when the daemon returns the saved session id. If birth-evidence persistence fails, they release the claim instead of killing the already-running PTY.
- **Restart recovery enabled after upgrade.** Existing configs receive a one-time settings migration that enables safe daemon-session adoption, while a later explicit opt-out remains respected. Startup now loads persisted settings before deciding whether to reconcile live sessions.

### Changed

- **Restore diagnostics in place.** The opaque queued-restore placeholder has been replaced with the latest 20 per-terminal restore events, including daemon snapshot lookup, identity selection, claim/attach, barrier and queue state, PTY create/cancel, output replay, and failure details.

## 0.11.4 - 2026-07-29

### Added

- **Terminal zoom controls.** `Ctrl` + mouse wheel and the configurable `Ctrl+=` / `Ctrl+-` / `Ctrl+0` shortcuts now adjust terminal font size with a bounded on-screen readout. The `Ctrl+-` binding is context-aware: it zooms while a terminal is focused and keeps split-down available elsewhere.
- **Browser-tab placement and reuse.** Agent browser tools can target a pane and reuse an existing normalized URL. MCP now waits for the frontend's actual tab id, so follow-up navigate, evaluate, click, and screenshot calls address the tab that was really focused or created.
- **Discoverability refresh.** The README and contribution guide were restructured, feature tips now cover orchestration workflows and link to the expanded AI panel, skills, right-dock, and browser-tab guides.

### Fixed

- **CLI resolution across Windows and WSL.** Windows executable lookup no longer depends on the parent process's `PATHEXT`, shell shims are resolved deliberately, and WSL rejects Windows-native Claude/Codex binaries while allowing valid script-based shims. Paths containing spaces remain argument-safe.
- **Schema-drift recovery.** Database migrations run one transaction per version, and migration v28 repairs installations whose recorded schema version advanced while columns or indexes were missing.
- **Daemon compatibility and outage recovery.** Adoption-snapshot 404s from older daemons degrade cleanly, session creation reconnects once after a real daemon outage across UI, MCP/REST, and Runner paths, and the single desktop control link switches immediately to the new daemon URL and token.
- **Window geometry persistence.** The main window restores its last normal size, position, and maximized state. Geometry writes are serialized with settings persistence so stale frontend snapshots cannot overwrite newer window state, or vice versa.
- **Shortcut and close-path accuracy.** Feature tips reflect terminal pass-through behavior, `Ctrl+W` follows the guarded tab-close path, and keyboard shortcut defaults now match the bindings registered by the frontend.

### Changed

- Automatic daemon-session adoption remains conservative in this release: `autoAdoptDaemonSessions` still defaults to `false`. Its Windows gray rollout and default-on promotion are tracked for 0.11.5 in `docs/66-0115-session-recovery-promotion.md`.

## 0.11.3 - 2026-07-26

### Added

- **AI panel delivery and history.** `open_ai_panel` can request auto/dialog/dock/silent display and now returns a frontend delivery receipt instead of treating backend creation as visible success. Panels persist in SQLite, group by workspace, retain archived history without eagerly loading large bodies, and can be safely claimed by a later session; claim ownership uses compare-and-swap semantics and the per-session panel limit is enforced during both creation and adoption.
- **Launch-profile automation controls.** The MCP surface now supports launch-profile management, while Settings adds an explicit authorization switch for MCP-created YOLO profiles. The switch is isolated from ordinary profile editing and defaults to the conservative path.
- **Worktree project hygiene.** Sidebar projects from the same Git worktree family are grouped under their main repository. Missing paths are detected with a present/missing/unverifiable three-state check, visibly marked, and removable through a confirmation flow that only deletes workspace records. Removing a worktree also cleans matching project registrations across workspaces.

### Fixed

- **Fail-closed terminal restoration across app instances.** A claim-capable daemon now exposes an atomic adoption snapshot containing generation, birth nonce, source layout/tab/leaf, runtime identity, active claims, and live sessions. Startup reconciliation only reattaches a PTY when all provenance matches; ambiguity, version mismatch, stale ownership, or missing evidence blocks automatic recreation instead of launching duplicate `--resume` processes. A restore barrier also prevents foreground, background, and reconnect paths from racing reconciliation.
- **Daemon write leases and manual adoption.** Write, submit, resize, and WebSocket input honor per-instance leases while output remains observable. Lost claims turn matching panes read-only, resource-manager adoption performs an atomic claim before attaching, stale leases receive one bounded post-TTL retry, and old daemons remain compatible without weakening capability detection.
- **AI panel races.** Initial history-list failure no longer disables later panel events, closing a panel cannot race with claiming and resurrect its database row, and exited sessions no longer count as active owners.
- **Cross-platform project health.** Windows-hosted paths stored as `/mnt/<drive>/...` are repaired before existence checks, preventing valid WSL-form paths from being marked missing on Windows.
- **Terminal compatibility.** OSC color-query handling can suppress opaque palette replies when wallpaper transparency and CLI behavior require it, while retaining normal replies for other terminals.

### Changed

- **Layout status density.** Comfortable layout tabs use a two-line identity area plus a 2x2 status summary; compact tabs retain the single status indicator.
- Large terminal, resource-manager, service, and panes-store modules were split along existing responsibilities, and their source-size ratchets were tightened.

## 0.11.2 - 2026-07-26

### Added — session history (unified local transcript index)

- **Session History dock view.** A new right-dock module indexes every local Claude + Codex transcript (including sessions not launched from CC-Panes, and WSL-side Codex rollouts): last-message summary, message count, CLI badge, relative time; scope filter (all / current workspace / current project, following the active terminal), keyword search, CLI chips, one-click resume. Codex resume runs a rollout-existence precheck — an invalid rollout disables the entry with a warning instead of silently starting a fresh session.
- **Incremental index cache.** `session_index` + `session_scan_state` tables with mtime/size skip (steady-state cycles read zero transcript bytes), a parse-algorithm version gate that forces a clean rescan when semantics change, 300s background cycle, and a first-scan that never wakes the WSL VM.

### Added — quick commands library

- **User quick commands.** Save reusable terminal commands or agent prompts with global or per-project scope (`quick-commands.json`, atomic writes), an append-Enter toggle, and a target of the current pane (split-aware leaf delivery) or a new tab. Three entry points: Command Palette group, tab context-menu submenu, and a Settings pane with full CRUD.

### Added — workspace organization

- **Workspace groups + color tags + filtering.** Assign workspaces to derived groups (create from the header, the create-workspace dialog, or per-workspace context menu), tag them with one of eight theme-paired colors, and filter the sidebar by keyword / colors / group. Groups render as collapsible sections with within-group drag ordering; the default workspace stays pinned and always visible.

### Added — desktop chrome & editor

- **Update notification card + interrupt gate.** A bottom-right non-modal card offers one-click download-install-restart; a shared interrupt gate keeps it (and feature tips) from firing while any agent is thinking/active/awaiting input.
- **Markdown editing upgrades.** Split-view scroll sync (both directions, echo-guarded), fenced-code syntax highlighting with theme-paired token colors, lazy-loaded Mermaid diagram rendering, and relative image-path resolution against the file's directory.
- **Layout tab status buckets.** The layout-bar summary row now shows colored status counts (error / awaiting input / running) instead of project names, hiding empty buckets.
- **Title-bar collapse hides the activity bar.** The sidebar toggle now collapses the icon strip together with the panel; any path that reopens the sidebar restores the strip.
- **Explorer dedup.** The left Files/Git tabs were removed in favor of the right dock's stronger equivalents (multi-root, follows the active terminal); persisted selections migrate back to Workspaces.

### Added — control plane

- **`cc-panes-ctl`.** A sidecar binary exposing endpoint discovery, a generic MCP tool caller, session/binding management commands, and a resumable stdio MCP proxy — the recovery surface for orchestrator outages.
- **Orchestrator bind observability.** `OrchestratorStatus` gains lifecycle/attempt/lastError; bind failures now raise a visible alert banner with an escape-hatch env var instead of failing silently, with bounded retry.

### Fixed — reliability

- **WebView2 process-failure recovery.** Renderer crashes reload in place; a browser-process crash triggers exactly one window rebuild, then a clean exit(70) that releases the single-instance lock — no more headless zombies holding the lock.
- **Daemon bridge connection storm.** WebSocket retry policy (3 attempts, capped backoff), a global handshake semaphore, and a 1s/5s poll schedule cut worst-case short-connection churn ~94% at 31 sessions; `get_bridge_stats` exposes live counters.
- **Zombie listener ports.** Orchestrator and web listener sockets are now created non-inheritable (`WSA_FLAG_NO_HANDLE_INHERIT`), so child processes can no longer hold a dead instance's port open and force port drift.
- **Test binaries load on Windows again.** comctl32 v6's `TaskDialogIndirect` import (via tauri-runtime-wry 2.11) crashed manifest-less test executables at load; comctl32 is now delay-loaded.

## 0.11.1 - 2026-07-25

### Added — orchestration primitives (`docs/44`)

- **`wait_for_session` MCP tool.** Long-poll a session until it reaches a target state (event-driven off the state-machine broadcast, no busy polling): snapshot fast path, subscribe-then-recheck race guard, `blockedReason` early-return when the session lands in WaitingInput/Error, 15s effective-status re-evaluation so a hook-starved stale-busy session still resolves, 180s timeout with zero-cost re-call semantics. `/clear` (SessionEnd reason="clear") does not satisfy `waitFor:["exited"]` — locked by test.
- **`send_to_worker` MCP tool.** The leader→worker downlink symmetric to `report_to_leader`: `[leader-directive]` formatting, busy gating with idle-edge redelivery (session-generic message substrate keyed by sessionId), planId broadcast, leader-identity enforcement, plan-collaboration audit trail.
- **Bracketed-paste delivery (Phase A+B).** `submit_to_session` no longer flattens newlines — text is wrapped in `\x1b[200~ … \x1b[201~` (embedded end-marker sanitized), so multiline prompts arrive intact as one submission. A CSI detector tracks DECSET 2004 (`paste_ready`) per session: when the TUI has an input box mounted, submit delay collapses to ~200ms; `launch_task` medium-length multiline prompts route through paste (daemon-mode flag bridging deferred — falls back to the CLI-arg path). The `write_to_session` control-key path is never wrapped.

### Added — UI

- **Right dock panel** (v1→v3 in one release): toggled from a TitleBar button (mirroring the left sidebar toggle, with an aligned divider line through the titlebar), Files/Git tabs inside the panel (flat icons + underline indicator), reusing the Explorer section internals. Width drag persisted (10px grab zone straddling the border), starts closed on every launch. Multi-project workspaces resolve the shown project as active-terminal > explicitly-selected > first, with a project dropdown in the header — the panel is never blank.
- **Context follows the active terminal.** Switching terminal tabs syncs the sidebar's selected workspace/project (and thus the right dock) via canonical project-identity reverse lookup — last action wins, plain-shell tabs don't clobber the selection.
- **Settings revamp, batch 1** (`docs/53`): a single pane registry drives a grouped sidebar and the search index (layered scoring: pane > entry > description > keyword; control-level filtering with deep-link anchors; wired into CommandPalette), one-pane-at-a-time lazy mounting, form anatomy + soft-card bands per the style constitution (written back into `docs/46`), and an Experimental pane shell with the graduation hydration pattern (`new ?? legacy ?? default` + idempotent markers). No settings were added or removed.
- **System resources in the StatusBar + session resource manager**: a pull-based CPU/memory segment (no resident backend sampling; paused while the window is hidden) opens a popover showing managed sessions grouped by workspace with per-session process-tree CPU/memory aggregation — click a row to focus its terminal tab, kill via the standard tree-kill path with inline confirm. Orphaned CC-Panes-derived processes get an amber count and batch cleanup; live-instance process trees (any instance — dev or release) are protected wholesale, PID reuse is start-time-checked, and MCP/dev-server/package-manager branches are excluded. Windows enumeration runs ~30ms via a Toolhelp snapshot with native counters for selected PIDs only.
- **Frontend machine guardrails** (four vitest suites): line-count ratchet (monolith baseline only shrinks, new files ≤500 lines), en/zh-CN i18n key parity (empty strings count as missing), raw-CJK-text ratchet, and a color guard covering hex/arbitrary values, inline style colors, and light/dark `--app-*` token-set parity. The parity guard caught its first real debt on day one (six `.dark` status tokens implicitly inheriting light values — now explicit).
- **Theme is now one file away.** Semantic color debt migrated to `--app-*` tokens (brand/category/ANSI colors precisely allowlisted), and terminal core colors (background/foreground/cursor/selection) read CSS tokens at theme-apply time with per-value fallback — zero visual change today, but editing `index.css` now restyles components and terminals together.
- Taller chrome: TitleBar 38→44px, StatusBar 24→28px.

### Fixed

- **opencode panes finally respect wallpaper transparency** (`docs/54`). Root-caused across four rounds: opencode's `system` theme depends on a terminal palette probe that fails under xterm.js/ConPTY, and the code then *falls back to the opaque built-in theme* (`#0a0a0a` painted on every cell). The adapter now ships a full 50-key theme frozen to the built-in dark values with `background`/`backgroundPanel`/`backgroundElement` set to `none` (no probe, no fallback path), injected version-compatibly through both the legacy `opencode.json` channel and the 1.18+ `tui.json`/`OPENCODE_TUI_CONFIG` channel, never overriding a user-configured theme. A background-behavior compatibility archive for all CLI TUIs (probe direction, alt-screen usage, intervention points) landed as `docs/54`.

### Dev notes

- `tauri dev` does not rebuild external binaries (`cc-panes-daemon` & co.) — documented in CLAUDE.md after it cost three "green tests, no effect" rounds this release: rebuild and copy into `binaries/` after touching `cc-cli-adapters`/`cc-panes-daemon`.
- New direction doc: `docs/54` (CLI TUI background-behavior compatibility archive and onboarding checklist).

## 0.11.0 - 2026-07-24

### Changed — Local History watcher rework (the real fix behind 0.10.21's revert)

- **File watchers now follow active terminal sessions instead of every registered project.** Previously the app started one watcher per registered project at startup (129 on the reporting machine) — cheap with native notifications, catastrophic with 0.10.20's polling scanner (~28.6 cores busy, see `docs/41`). A new `HistoryWatchManager` starts a watcher when a project's first terminal session opens and stops it 45s after the last one closes (generation-guarded against re-open races). Windows directory-handle locks (#35) now apply only to the handful of actively-used projects, and explicit stops before workspace delete/rename/migration keep `fs::rename` from being blocked.
- **Ignore patterns finally prune nested directories.** Bare-name patterns (`node_modules/**`) now match at any depth — monorepo nested dependencies no longer flood the event pipeline. Built-in ignores (`.venv`, `.next`, `.turbo`, `.dart_tool`, `coverage`, `__pycache__`, …) are unioned with user config, so existing projects with stale ignore lists benefit automatically.
- **Event-flood defenses**: bounded 30k event channel and a 128-path debounce cap that shed modification events under flood while always preserving deletions (tombstones survive mass deletes), explicit handling of notify `Rescan`/error. A global Local History switch (Settings → General) and a `get_history_watch_stats` command round it out.

### Added

- **Git commit timeline + diff view.** Per-project commit history (NUL-delimited field protocol — control characters in commit subjects can't corrupt parsing), master-detail panel (commits → structured file list → DiffView), worktree-vs-HEAD content diff, merge commits default to first-parent with a parent switcher. Backed by a hardened git layer: process output draining with hard byte limits (no more fake timeouts on large `git show`), `--porcelain=v1 -z` status parsing sunk into core (Tauri/Web parity, no more duplicated text parsing), repo-root-unified worktree operations, and OID-pinned revision arguments (`rev-parse --verify --end-of-options`).
- **Project identity unification.** `D:\...`, `/mnt/d/...` and `\\wsl.localhost\...` spellings of the same project are now one project: canonical-form comparison is used as the identity key for registration, dedup and `launch_task` validation (any spelling is accepted; runtime conversion happens at launch) — persisted paths keep the host-usable form the user provided, so `/mnt/...` projects on native-Unix hosts stay launchable. An idempotent migration merges existing duplicate entries (with `.bak` backups) and regenerates `projects.csv`.
- **Layout auto-binding** — a new layout binds itself to the workspace of the first terminal tab that lands in it. **Files view follows the active terminal's workspace** (toggleable, manual navigation is never interrupted). (#4 plan)

### Fixed

- **`/clear` no longer kills the session.** Claude Code's `/clear` fires a SessionEnd hook with `reason="clear"`; the hook layer treated every SessionEnd as a process exit, the state machine marked the live session Exited, and the daemon bridge emitted a synthetic `terminal-exit(-1)` and stopped streaming. The hook now filters by reason on both channels (HTTP + OSC), and the bridge no longer trusts hook-derived Exited while the session still exists. (`docs/44`)
- **Chinese-path projects launch correctly**: WSL launch scripts get a UTF-8 locale fallback, worktree branch-name sanitizing keeps CJK characters (Unicode-aware regex), and npm-shim/WSL launches log diagnostics for path issues.
- Windows `git rev-parse --show-toplevel` output is normalized to native separators before path comparison.
- **Codex resume works again.** The OSC title capture chain was dead against Codex CLI v0.145 (every recent codex launch had a null `resumeSessionId` — resume silently opened a fresh session), and captured Codex ids could even land on Claude history rows. Fixed the title parsing against measured v0.145 output, added a rollout-directory scan fallback (honors `CODEX_HOME`), made resume bindings route strictly by PTY session id, surfaced the WSL "resume target missing" downgrade as a visible warning, and disabled the resume entry when no id was ever captured. (`docs/45`)
- **Cross-platform launch no longer black-screens — and no longer silently runs in the wrong directory.** A Windows-path workspace opened on macOS failed with an opaque error and a dead black tab. Deeper: `portable-pty` silently falls back to HOME for an invalid cwd on every platform, so a bad path could "successfully" start an agent in the wrong repo. Now a host/path classifier rejects mismatched/missing/non-directory paths with structured errors (SSH exempt, WSL-on-non-Windows keeps its explicit unsupported error), `spawn_pty` blocks the HOME fallback outright, failed tabs render an error panel with retry/remove, and launch entries pre-warn on cross-platform local paths. (`docs/46`)
- **`kill_session` closes the tab again.** Sessions whose hook lifecycle had reported "Exited" (while the process lived on) had their daemon bridge torn down early, so the later `session-killed` event had no subscriber and the UI tab survived every kill. The `/clear` fix's bridge half resolves it; this release adds the regression test, a control-channel fallback broadcast when no bridge is attached, and pinned tabs no longer silently ignore backend-driven kills. (`docs/48`)
- **Worker exit is no longer mislabeled "completed".** Session reconciliation marked a crashed-in-10s worker as completed/100% with exit code 0. Bindings now keep worker-written completion only; anything else is recorded as failed with the real exit code.
- **Queued worker reports actually get delivered.** Leader-busy reports were queued for redelivery on the leader's next idle transition — but a long-lived leader session could wedge in a busy state and the edge never fired, so reports silently expired after 30 minutes. Redelivery is now edge + 60s level-scan dual-triggered, TTL drops are logged and recorded on the binding, and stale busy states (10 min without hook/OSC events) downgrade to idle for display — fixing tab status lights stuck on busy — while report injection additionally requires the PTY itself to be quiet, so nothing is ever typed into a still-running foreground tool. (`docs/49`)
- **Terminal fit**: dragging a split divider now refits every terminal in the affected panes (including inactive sub-tabs; hidden terminals refit when they become visible), PTY resizes are debounced per session, and the terminal context menu gains "Fit" / "Fit all terminals" as a manual fallback. (`docs/48`)

### Uninstall

- **Uninstalling now actually cleans up.** The NSIS uninstaller kills this install's processes first (full-path filtered — dev instances untouched), then optionally deletes app data behind an explicit prompt (defaults to No; silent/updater uninstalls always preserve data). A new "pre-uninstall cleanup" in Settings → About de-injects everything CC-Panes ever wrote into other CLIs' global dirs (`~/.claude`, `~/.codex`, `~/.grok` — including the tokened MCP URL) and removes per-project hook entries, with a cleanup report. Injected hook commands now guard on binary existence, so projects touched by an uninstalled CC-Panes no longer spawn dead-path errors on every session. (`docs/47`)

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
