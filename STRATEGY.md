# CC-Panes Strategy

## Problem

Developers who run several AI coding sessions across local, WSL, and SSH projects need one durable place to start, observe, coordinate, and resume that work. Without it, they switch among unrelated terminal windows, lose the link between a task and its owning session, act in the wrong project, and cannot reliably recover work after an application restart.

## Approach

1. Keep workspace data local by default, make routine actions reversible, and expose destructive consequences before execution.
2. Treat the terminal and editor as primary content; application chrome stays quiet and uses color mainly for state, identity, and selection.
3. Preserve session continuity across layout changes, application restarts, and client reconnection; never hide missing recovery data behind a successful-looking state.
4. Keep one workspace model across desktop, Web, and mobile while naming platform boundaries explicitly instead of pretending every capability is portable.
5. Give direct actions visible feedback within 200 ms, ship Chinese and English UI together, and preserve keyboard and screen-reader paths.

## Persona

The primary user is a developer supervising several Claude Code, Codex, OpenCode, or other CLI-agent sessions across multiple repositories. They launch agents, compare outputs, inspect files and Git state, dispatch bounded work, and return to long-running sessions throughout the day; today they compensate with separate terminal windows, handwritten task notes, and manual session-history searches.

## Metrics

- **Leading - first useful session:** Baseline is unmeasured. By the next two minor releases, at least 4 of 5 scripted first-run evaluations must create or import a workspace, add a project, and launch a session within five minutes. Measure with the local onboarding checklist and session-launch timestamps; no remote telemetry is required.
- **Outcome - recoverable continuity:** Baseline is tracked by restore fixtures but not yet summarized as one release metric. Every release must pass 100% of eligible automated restore fixtures and a Windows host soak that restarts ten live sessions without losing their project, layout, or recoverable identity.
- **Moat - first-class workflow coverage:** Baseline is the current supported-adapter matrix and is recorded per release. Every CLI advertised as first-class must pass the shared launch, provider injection, lifecycle, and resume checks that its upstream protocol supports; unsupported capabilities must be shown as unavailable rather than silently ignored.

## Tracks

- **Track A - Session execution:** Make launching, splitting, observing, and resuming CLI-agent sessions fast and predictable; current focus is terminal reliability and launch-profile correctness.
- **Track B - Work coordination:** Keep workspaces, projects, plans, Todos, skills, Git state, and agent orchestration next to the sessions doing the work; current focus is discoverability without adding dashboard clutter.
- **Track C - Reliability and reach:** Preserve data and session identity across daemon, desktop, Web, WSL, and mobile boundaries; current focus is explicit compatibility contracts and recoverable failure modes.

## Known Challenges

### CEO review

1. Feature breadth can dilute the core promise of reliable parallel AI coding; personalization remains secondary to session execution and recovery.
2. Local-first operation limits conventional product analytics, so roadmap decisions need scripted usability evidence and opt-in feedback rather than assumed adoption.
3. Desktop, Web, and mobile increase maintenance cost; a capability should share the workspace model or clearly justify a platform-specific surface.
4. Open-source feature volume is not itself an outcome; release notes and onboarding must connect capabilities to fewer lost sessions and faster task re-entry.
5. A new feature that cannot be explained in one workflow sentence should be narrowed before implementation.

### Engineer review

1. PTY state lives in the daemon while UI state lives in the application; every new session data path must name its process boundary and replay behavior.
2. Windows desktop behavior cannot be inferred from Vite, Web, WSL, or Linux checks; WebView2, PTY, tray, shortcut, and updater behavior require host evidence.
3. Settings are persisted across versions and clients; every new field needs a default, invalid-value normalization, and old-config coverage.
4. Visual customization multiplies theme and platform combinations; semantic tokens and bounded visual matrices are required to prevent selector drift.
5. Terminal rendering and restore lifecycles are high-risk shared paths; unrelated features must not refactor them as incidental cleanup.

Last Reviewed: 2026-08-06
