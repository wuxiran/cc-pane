# Spec · Terminal Path Link Dialog

## Inputs

- Plain terminal text may contain Windows absolute paths, host-native POSIX absolute paths, or project-relative paths with a separator.
- A path may end with a positive 1-based `:line` or `:line:column` suffix up to 10,000,000.
- OSC 8 input may use `file://` with no host or `localhost`; HTTP(S) remains external; other schemes are rejected.
- Activation carries only the originating `sessionId`, parsed raw path, and optional line/column.
- The backend derives project root and runtime from the live session. Renderer-supplied roots and runtime labels are never trusted.
- Inputs are bounded to 2048 inspected characters and 16 candidates per xterm link request.
- Empty strings, NUL/C0/DEL controls, bidi controls, Windows device namespaces, drive-relative paths, and NTFS alternate data streams are rejected.

## Outputs

- Successful resolution returns a canonical absolute path, `file` or `directory` kind, and `local` or `wsl` runtime kind.
- The Dialog state is `resolving`, `ready`, `acting`, or `closed`, with a monotonic request ID.
- Editor activation opens or focuses the existing file tab and optionally submits a one-shot Monaco reveal request.
- Desktop actions return success or a typed error after re-resolving the original session/path.
- Rejected input returns a stable error code without revealing canonical information outside the authorized root.

## Behavior

- When a syntactic path is hovered, xterm decorates it without filesystem IO.
- When a path is clicked, the Dialog opens synchronously in resolving state and the service resolves it asynchronously.
- When a newer click or close occurs, older async results are ignored.
- Absolute and relative paths are canonicalized and must remain inside the canonical session project root.
- Files expose editor, copy, and desktop-only default/reveal actions.
- Directories expose copy and desktop-only open-folder actions.
- Web hides desktop actions; SSH does not register a local path provider and is also rejected by the backend.
- WSL relative paths resolve from the host-side project root; WSL POSIX absolute paths are rejected on Windows.
- System actions re-resolve immediately before execution.
- Explicit hard newlines are never joined into one path.
- Unicode path text is not normalized before filesystem canonicalization.

## Non-functional

- Performance: link provision is synchronous, examines at most 2048 characters and 16 candidates, and performs no IO.
- Concurrency: request IDs prevent stale resolve/action results from replacing current Dialog state; pending actions are single-flight and time bounded.
- Security: session-bound root, canonical containment, symlink resolution, runtime rejection, typed actions, and no shell construction are mandatory.
- Accessibility: Radix Dialog supplies focus trap, Escape handling, accessible naming, keyboard order, and focus restoration.
- Compatibility: terminal PTY, resize, renderer, paste, selection, IME, context menu, hibernation, and restore lifecycles retain existing behavior.

## Examples

Happy paths:

1. `F:/repo/docs/report.md:17` in a Windows local session resolves inside `F:/repo`, opens the Dialog, and focuses Monaco at line 17.
2. `src/components/App.tsx:12:8` resolves from the originating project root and focuses line 12 column 8 in an existing or new editor tab.
3. `./docs/design notes.md:3` with an unambiguous location suffix resolves to a file containing spaces.
4. A project-local directory opens a directory Dialog with copy and desktop file-manager actions.
5. Web local sessions can open a resolved file in the in-app editor and copy its canonical path.

Error paths:

1. `C:/Windows/System32/drivers/etc/hosts` is rejected because it is outside the session root.
2. `../../outside.md` and a project-local symlink pointing outside are rejected after canonicalization.
3. `/home/user/repo/a.ts` from Windows WSL is rejected because POSIX-to-UNC mapping is out of scope.
4. Any path from an SSH session is rejected without probing the host filesystem.
5. `javascript:alert(1)`, `file://server/share/a.ts`, bidi-controlled text, missing files, and device paths are rejected.
6. If the session closes or the target is replaced before a desktop action, the re-resolution fails closed.

