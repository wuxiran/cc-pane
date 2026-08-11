# Spec · Terminal task queue

## Inputs

### Global setting

`TerminalSettings.taskQueueEnabled: boolean`

- Missing values deserialize to `true` for backward compatibility.
- The field uses a tolerant boolean deserializer: a non-boolean persisted value becomes `true` while the rest of `AppSettings` remains intact. Normalization is tested independently from TOML parse failure.
- `false` disables automatic dispatch for every session and hides the status-bar entry. It does not delete queue items or change each session's `paused` value.
- The queue runtime stores the same value plus a monotonically increasing `dispatch_generation` in SQLite. Saving the setting updates that row in the same transaction used by the claim gate before the settings command returns.

### Queue item draft

```ts
interface TaskQueueItemDraft {
  text: string;
  imageRefs: string[];
}
```

- `sessionId` is supplied by the command route and must identify a currently known PTY session with a CLI tool other than `none` owned by this Tauri backend.
- `text` is trimmed at both ends and may contain newlines. UTF-8 length must be at most 65,536 bytes.
- At least one of trimmed `text` or `imageRefs` must be non-empty.
- `imageRefs` contains at most 10 references per item; each reference is validated against the staging record before the item is persisted.
- One session may contain at most 100 non-completed items.
- `imageRefs` are backend-issued opaque IDs returned by `stage_terminal_task_queue_clipboard_image`. The API never accepts a caller-provided file path for a queued image.
- A staged image is copied into the app-owned `task-queue-images/<sessionId>/` directory, canonicalized, checked as a regular PNG/JPEG/WebP file no larger than 20 MiB, and retained until its referencing item is deleted or completed. Symlink targets outside that directory are rejected; unreferenced staged files are pruned after a failed add or during startup cleanup.

### Queue control

```ts
interface TaskQueueControlPatch {
  paused?: boolean;
  unattended?: boolean;
}
```

- An empty patch is rejected. `paused` and `unattended` are independent.
- `unattended: true` is accepted only when the active Claude adapter exposes the synchronous `PermissionRequest` decision capability and the backend can prove write ownership. Otherwise the API returns `UNATTENDED_UNSUPPORTED` and leaves the setting unchanged.
- `unattended` defaults to `false` for new and legacy sessions. Enabling it never persists a confirmation that applies to another session.
- Enabling unattended requires an explicit confirmation in the UI; the confirmation is not persisted as a blanket grant for other sessions.

### Mutations

- Stage image: current session ID plus the native clipboard image; returns `{ imageRef, width, height }`.
- Add item: session ID plus `TaskQueueItemDraft`.
- Delete item: session ID plus backend-generated item ID.
- Clear queue: session ID. An item already in an acknowledged atomic submit cannot be cancelled; clear removes all remaining queued/failed/unknown items and any unreferenced staged images.
- Retry failed/unknown item: session ID plus item ID. Retry is always explicit; it changes the item to `queued` and clears automatic failure blocking, but does not override `paused`.
- Pause/resume and unattended toggle: session ID plus `TaskQueueControlPatch`.

## Outputs

```ts
type TaskQueueState =
  | "disabled"
  | "running"
  | "paused"
  | "confirmingIdle"
  | "dispatching"
  | "actionRequired"
  | "sendFailed"
  | "sessionEnded";

type TaskQueueReason =
  | "globalDisabled"
  | "userPaused"
  | "waitingInput"
  | "unknownPrompt"
  | "unattendedUnsupported"
  | "automaticWriteUnavailable"
  | "sessionClaimLost"
  | "sessionError"
  | "sessionExited"
  | "deliveryUnknown"
  | "submitFailed"
  | null;

interface TaskQueueItem {
  id: string;
  sessionId: string;
  position: number;
  text: string;
  imageRefs: string[];
  state: "queued" | "dispatching" | "failed" | "deliveryUnknown";
  createdAt: number;
  lastError: string | null;
}

interface TaskQueueSnapshot {
  sessionId: string;
  paused: boolean;
  unattended: boolean;
  unattendedSupported: boolean;
  state: TaskQueueState;
  reason: TaskQueueReason;
  items: TaskQueueItem[];
  revision: number;
  updatedAt: number;
}
```

- All serialized names use camelCase at the Tauri IPC boundary. Items are returned in FIFO position order; positions are contiguous after a mutation.
- Every successful mutation returns the full authoritative snapshot.
- Backend changes publish the same snapshot through `task-queue-updated`. It is an invalidation/snapshot event, not an append-only log; WebView reload performs `get_terminal_task_queue` before listening.
- Errors use stable codes plus a localized UI message. Raw prompt text, task text, image bytes, API keys, terminal output, and environment values are not written to logs.

## Behavior

### Visibility and status-bar placement

1. The entry is rendered in `TerminalStatusBar` only in the Tauri desktop runtime and when `terminal.showStatusBar`, `terminal.taskQueueEnabled`, a valid `sessionId`, and `cliTool !== "none"` are all true. A browser/Web runtime displays no queue control.
2. Every eligible terminal leaf gets its own entry, including a single-pane layout.
3. A Lucide queue/list icon is used. A badge shows `1..9` or `9+`. Narrow layouts may hide the text label, but retain icon, badge, accessible name, Tooltip, and a shape/text state indicator.
4. The Popover is anchored above the status bar, at most 420 px wide and 70 vh high, uses existing shadcn primitives and semantic tokens, and never nests cards.
5. Queue states are not communicated by color alone. `Paused`, `Action required`, and `Send failed` have distinct icon/label/Tooltip text.

### Queue editing

1. `Enter` adds a non-empty draft, `Shift+Enter` inserts a newline, `Escape` closes the Popover, and `Ctrl+V`/platform paste calls the native clipboard staging command. A browser/Web runtime displays no queue control.
2. Each successful image paste appends one preview and opaque `imageRef`; removing a preview removes that ref from the unsaved draft only.
3. Quick actions add normal queue items: `Continue`, `yes`, `OK, continue`, and `/compact`. They do not bypass pause or readiness checks.
4. Closing the Popover never changes the queue. Disabling globally or pausing a session retains all items.
5. Clear requires confirmation when the queue contains an item in `failed` or `deliveryUnknown`.

### Reliable FIFO dispatch

1. Adding or resuming a non-empty queue schedules a dispatch check. Real state transitions to `Idle` schedule an edge-triggered check, and a single backend-owned periodic level scan repeats checks to recover a missed event or backend restart. No React component owns a timer.
2. The dispatcher sends the next task only when the runtime row is enabled, the session queue is not paused, the queue head is `queued`, the exact PTY session exists, the backend has exclusive in-process ownership or an enforced daemon lease, and `SessionStateMachine::status_for_automatic_submit(...)` returns exactly `Idle`.
3. `WaitingInput` is never interpreted as completion for normal queue dispatch. It is handled only by the structured PermissionRequest rule below.
4. A SQLite transaction atomically checks `(enabled, dispatch_generation)`, verifies no active token, changes the head from `queued` to `dispatching`, assigns a UUID token, and records `dispatch_started_at`. The returned token is the only authority to complete that item.
5. Immediately after claiming and immediately before writing, the dispatcher re-queries the runtime generation, session ownership, state machine observation and PTY output freshness. If any readiness check fails, the same item returns to `queued` at the head without incrementing an attempt count.
6. The effective prompt is built once: staged image files are resolved in insertion order and joined with a single space, followed by one newline and trimmed text when both are present. The complete prompt is passed to the existing atomic `submit_to_session` path, which uses bracketed paste and a final `\r`.
7. Only an acknowledged submit deletes the item. The transaction closes the dispatch token, compacts positions, increments `revision`, and waits for a later `Idle` transition before considering the next item.
8. A definite pre-write failure retains the item as `failed`, sets `sendFailed`, and pauses automatic dispatch. No timer retries it; explicit retry is required.
9. A crash/restart or ambiguous transport error while `dispatching` changes the item to `deliveryUnknown`, sets `actionRequired`, and never auto-retries it.
10. `Error`, `Exited`, write-lease loss, session deletion, or unknown waiting input changes the queue to a non-dispatching state with a reason. Items remain bound to that exact PTY session and are not moved to another session.

### Post-restart observation gate

1. At worker startup, every queued session is registered in the state machine with an observation generation and current backend status; registration is not evidence of `Idle`.
2. An entry created after restart can authorize dispatch only after a fresh `TurnEnd`/equivalent idle edge, or after both the hook observation and PTY output exceed the existing stale threshold while the backend still reports a live session.
3. A missing state-machine entry never falls back to the raw backend `Idle` snapshot. This prevents a backend restart from bypassing the dual-stale gate.

### Unattended permission decisions

1. Unattended mode never scans terminal text and never sends raw CR, `1`, `y`, `yes`, or `continue`.
2. The Claude adapter capability is the exact native `PermissionRequest` hook. The request must contain `hook_event_name == "PermissionRequest"`, a non-empty `tool_use_id`, `tool_name`, and a JSON `tool_input`; the backend computes the identity `(sessionId, toolUseId)` and does not use prompt text for correlation.
3. The hook runner sends the structured request to the authenticated local orchestrator endpoint and prints a response only when the backend returns the exact decision `{ "hookSpecificOutput": { "decision": { "behavior": "allow" } } }`.
4. Before returning `allow`, a SQLite transaction checks global enabled, session `unattended`, a non-empty queue, the exact Claude adapter, a live session, and exclusive/enforced write authority. It inserts the request identity and decision before responding. A duplicate identity returns the stored decision and does not perform a second side effect.
5. Missing `tool_use_id`, malformed payload, unknown adapter, unsupported hook transport, no queue items, disabled/unattended-off session, lease loss, `AskUserQuestion`, elicitation, login, authentication, and API errors all return `actionRequired`/no decision. They never fall back to a terminal keystroke.
6. A PermissionRequest decision does not dispatch the next queued task. The worker waits for a later busy/idle transition and re-runs all readiness checks.
7. Turning unattended off takes effect before the next hook decision; it cannot revoke an already returned native decision.

### Persistence and client lifecycle

1. Queue settings, items, dispatch token, runtime enabled/generation, handled permission identities, revision, and timestamps are persisted in SQLite in the same local data boundary as other CC-Panes state.
2. On backend startup, ordinary `queued` items remain queued. Stale `dispatching` items become `deliveryUnknown`. No item is submitted until the exact PTY session is found and passes the post-restart observation gate.
3. Closing/reopening a Popover, hiding a tab, switching layouts, WebView reload, and switching between visible terminals do not pause or duplicate the backend queue.
4. When the CC-Panes Rust backend is not running, no queue execution or unattended decision occurs. After restart, the single worker resumes only safe queued items.
5. Tauri commands and local orchestrator hook routes are the only execution API in this change. `cc-panes-web`/Docker has no queue routes or worker and the frontend hides the control outside Tauri.
6. Disabling the global setting updates the SQLite runtime generation before the settings command returns. A claim that was already acknowledged by the PTY may finish; no later queue item can pass the claim transaction.

### Accessibility and localization

1. All icon-only controls have an accessible name and Tooltip. Pause/resume, clear, delete, close, image remove, and retry are keyboard reachable.
2. Focus moves to the input when the Popover opens, stays trapped only while a destructive confirmation dialog is open, and returns to the status-bar trigger on close.
3. Chinese (`zh-CN`) and English (`en`) keys ship in the same change. No user-facing queue text is hard-coded in components.

## Non-functional

- Performance: queue CRUD returns within 200 ms p95 on a local database with 100 items; status-bar updates do not subscribe to terminal output chunks and add no work to xterm's render path.
- Concurrency: mutations, runtime generation changes and dispatch claims are transactional per session; at most one automatic write or permission decision is in flight per session.
- Reliability: the transition listener performs O(1) work plus spawning; the level scan is bounded to sessions with non-empty active queues and has no leaked interval/watchdog per React component.
- Security: IPC validates session ownership, item limits, text size and image refs; hook routes require the existing local bearer token; the backend never reads an arbitrary caller path. Logs contain IDs, counts, state codes and error classes only.
- Compatibility: missing config fields use defaults; invalid `taskQueueEnabled` alone is normalized without dropping unrelated settings; unsupported CLI capabilities are visibly unavailable; Windows PTY and WebView behavior requires Windows-host validation.

## Examples

### Happy paths

1. Claude is `Thinking`; the user queues A then B. A real `TurnEnd` makes the state `Idle`, A is atomically submitted and removed after acknowledgement. After A's resulting turn ends, B is submitted once.
2. Codex lacks TurnEnd. Its output becomes quiet, but the queue does nothing while PTY output is fresh. After both hook observation and PTY output exceed the stale threshold, one level-scan submit is allowed.
3. The user pastes two screenshots, types “Compare these failures”, and adds the task. The backend resolves the two opaque refs to app-owned files and submits `path1 path2\nCompare these failures` through one `submit_to_session` call.
4. Claude emits a unique `PermissionRequest` with `tool_use_id=tool-7` while unattended is enabled and the queue is non-empty. The hook receives one structured `allow`; a duplicate delivery for `tool-7` receives the same stored decision and no second side effect.

### Error paths

1. A normal `WaitingInput`/`Notification(permission_prompt)` has no queue authorization. The queue enters `actionRequired` and sends nothing.
2. A daemon reports no enforced claims, or a lease is lost between checks. The head remains queued and the queue shows `automaticWriteUnavailable`/`sessionClaimLost`.
3. Submit fails before bytes are written. The head remains `failed`; no timer retries it. The user must retry explicitly.
4. The process restarts while an item is `dispatching`. It becomes `deliveryUnknown`, and the worker never resends it automatically.
5. A pasted file ref points outside the app-owned directory, is a symlink, is too large or has an unsupported format. Staging or add is rejected without reading it into the queue.

## Error codes

`QUEUE_FULL`, `QUEUE_ITEM_INVALID`, `QUEUE_ITEM_NOT_FOUND`, `IMAGE_REF_INVALID`, `IMAGE_STAGE_FAILED`, `SESSION_NOT_FOUND`, `SESSION_NOT_WRITABLE`, `UNATTENDED_UNSUPPORTED`, `SUBMIT_FAILED`, and `DELIVERY_UNKNOWN` are stable machine-readable codes. UI-localized messages may change.
