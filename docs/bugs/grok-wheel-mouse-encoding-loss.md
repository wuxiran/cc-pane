# Grok mouse wheel lost after checkpoint recovery (2026-09-10)

## Evidence

- Session: `bf735d40-c337-4a49-9943-5c477e41c5c9`.
- Running Windows app: `0.12.14`; daemon PID `205544` remained alive across installation.
- The session's checkpoint preserved alternate buffer (`1049h`) and any-motion
  mouse tracking (`1003h`), but neither `1006h` nor `1016h` was present in the
  checkpoint or its retained delta.
- The actual WebView2 xterm reported `buffer=alternate`, `tracking=any`, and
  `encoding=DEFAULT`. There was no output backlog or ongoing resync.
- One wheel event before repair produced 5 binary reports, zero `onData`
  reports, and no frame change. After restoring `1006h` on the terminal display,
  the same gesture produced 5 SGR `onData` reports and a changed Grok frame.
  No prompt, Enter, or task-control command was sent.

## Cause

The installed `@xterm/addon-serialize` saves mouse tracking but not its independent
wire encoding. Recreating/resetting xterm and replaying a checkpoint therefore
restores `any` tracking with the default encoding. xterm emits those reports on
`onBinary`; CC-Panes forwards `onData`, so the wheel reports never reach Grok.

Orca explicitly carries both tracking and encoding in
`terminal-mode-rehydrate-sequences.ts`. Its `1006`/`1016` restoration is independent
of alternate-screen state. The previous fullscreen and `TERM_PROGRAM` explanations
were not supported by the failing session; the speculative Orca identity injection
has been removed.

## Fix

- `terminalSnapshotModes.ts` appends the actual xterm mouse encoding to serialized
  snapshots, including encoding retained while mouse tracking is temporarily off.
- Both checkpoint uploads and hibernation snapshots use the helper.
- Default encoding remains default; other applications are not forced into SGR.
- The private xterm encoding getter is isolated and covered by real-parser tests.
- The affected pane was repaired in place and a corrected checkpoint was accepted
  at anchor `8394719`. Fullscreen and the Grok process were preserved.

## Validation

- Windows focused Vitest: 41 passed (snapshot modes, checkpoint upload, hibernation,
  replay buffer mode).
- TypeScript check: exit 0.
- Live WebView2 wheel before/after: reproduced and repaired as described above.
  Native CDP mouse-wheel input also produced 5 SGR reports, no binary reports,
  and a changed Grok frame.
- Release frontend build and xterm build check passed. Two Windows native release
  attempts failed with allocation errors (exit 1), including single-job compilation
  and a retry with 256 codegen units for the app crate. Windows reported only about
  3.2 GiB free commit space. The installed app has NOT been replaced by this fix.
- The current pane and daemon checkpoint are repaired. The source fix still needs
  a successful native build and installation to prevent future bad snapshots.
- A WebView reload restored the affected session as `alternate / any / SGR`
  from its corrected checkpoint without the temporary serializer patch.
- All 12 pre-existing daemon sessions retained the same process IDs during diagnosis.

This record contains protocol state and counts only, without terminal text or credentials.
