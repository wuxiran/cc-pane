# App Home Control Center

CC-Panes App Home is the user-level control center. Release builds use
`~/.cc-panes`; dev builds use `~/.cc-panes-dev`.

The directory layout is prepared at startup by `AppPaths::new` through
`ensure_control_center_layout`. Startup only creates directories. It does not
migrate, copy, rewrite, or delete existing files.

## Target Layout

```text
~/.cc-panes/
├── data.db
├── providers.json
├── launch-profiles.json
├── memory.db
├── shared-mcp.json
├── workspaces/
│   └── <workspace-id-or-name>/
│       ├── workspace.json
│       └── snapshots/
│           └── <snapshot-id>/
│               └── snapshot.json
├── launch-profiles/
├── memory/
├── mcp/
├── skills/
│   ├── user/
│   └── builtin/
├── sessions/
└── runtime/
    └── sessions/
```

## Current Sources Of Truth

- `providers.json` remains the Provider source of truth.
- `launch-profiles.json` remains the Launch Profile source of truth.
- `shared-mcp.json` remains the Shared MCP source of truth.
- `memory.db` remains the Memory source of truth. Memory is still DB-first.
- `data.db` remains the source of truth for projects, todos, launch history,
  terminal restore records, and related SQLite-backed app state.
- `workspaces/<workspace>/workspace.json` remains the workspace metadata source
  of truth. A workspace may have no materialized path.

## Prepared Directories

- `workspaces/` stores user-level workspace metadata and snapshots.
- `launch-profiles/` is reserved for a future file-first launch profile layout.
- `memory/` is reserved for a future Markdown-first Memory layout.
- `mcp/` is reserved for future MCP config files such as `mcp/shared-mcp.json`.
- `skills/user/` is reserved for user-level skills.
- `skills/builtin/` is reserved for bundled/builtin skill materialization.
- `runtime/sessions/` is reserved for runtime session files.

## Compatibility Rules

- Do not migrate legacy root files just because the directories exist.
- Do not switch `shared-mcp.json` to `mcp/shared-mcp.json` without a migration and
  legacy fallback plan.
- Do not switch Memory to Markdown-first without a dedicated migration that can
  rebuild SQLite/FTS as an index from Markdown.
- Project-side `.ccpanes`, `.claude/settings.local.json`, and
  `.claude/commands` are legacy or explicit project-scope paths. New default
  behavior should prefer App Home overlays and avoid writing to projects unless
  the user opts in.
- If a future migration introduces directory-first config, use one-way writes to
  the new source of truth and read legacy files only as import/fallback sources.
