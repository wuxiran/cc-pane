<h1 align="center">
  <a href="https://github.com/wuxiran/cc-pane"><img src="src-tauri/icons/icon.png" alt="CC-Panes" width="64" valign="middle" /></a> CC-Panes
</h1>

<p align="center">
  <a href="https://github.com/wuxiran/cc-pane/releases/latest"><img src="https://img.shields.io/github/v/release/wuxiran/cc-pane?display_name=tag&amp;sort=semver" alt="Latest release" /></a>
  <a href="https://github.com/wuxiran/cc-pane/releases"><img src="https://img.shields.io/github/downloads/wuxiran/cc-pane/total?label=downloads&amp;color=success" alt="Downloads" /></a>
  <img src="https://img.shields.io/badge/license-GPL--3.0-08C?style=flat" alt="License: GPL-3.0" />
  <img src="https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-4493F8?style=flat-square" alt="Windows, macOS, and Linux" />
</p>

<p align="center">
  <sub><a href="docs/readme/README.zh-CN.md">Chinese</a> | <a href="docs/readme/README.ja.md">Japanese</a> | <a href="docs/readme/README.ko.md">Korean</a> | <a href="docs/readme/README.es.md">Spanish</a> | <a href="docs/readme/README.fr.md">French</a> | <a href="docs/readme/README.pt.md">Portuguese</a></sub>
</p>

<p align="center">
  <strong>The desktop command center for parallel AI coding.</strong><br />
  Run CLI agents side by side, organize their workspaces and sessions, then coordinate the work through MCP, plans, skills, Git, and local history.
</p>

<h3 align="center"><a href="https://github.com/wuxiran/cc-pane/releases/latest"><ins>Download CC-Panes</ins></a></h3>

<p align="center">
  <picture>
    <source srcset="docs/assets/readme-recordings/readme-hero.gif" type="image/gif" />
    <img src="docs/assets/readme-recordings/readme-hero.jpg" alt="CC-Panes command center showing AI coding usage, projects, and sessions" width="960" />
  </picture>
</p>

<p align="center"><sub>Product captures below are recorded from real CC-Panes desktop interactions.</sub></p>

## Features

<table>
<tr>
<td width="50%" valign="middle">

### Workspace Command Center

See active sessions, recent projects, available CLIs, usage trends, and workspace context in one local desktop view. Move between a workspace, project, task, and terminal without losing the thread of the work.

[Guide -&gt;](docs/guide/03-core-concepts.md)

</td>
<td width="50%">
  <a href="docs/guide/03-core-concepts.md"><picture><source srcset="docs/assets/readme-recordings/readme-hero.gif" type="image/gif" /><img src="docs/assets/readme-recordings/readme-hero.jpg" alt="CC-Panes workspace dashboard with projects and active sessions" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Provider and Launch Profiles

Choose a CLI, provider, MCP set, skills, runtime, and permission policy as one reusable launch profile. Keep local, WSL, and SSH workflows under the same workspace model.

[Settings guide -&gt;](docs/guide/10-settings.md)

</td>
<td width="50%">
  <a href="docs/guide/10-settings.md"><picture><source srcset="docs/assets/readme-recordings/provider-profiles.gif" type="image/gif" /><img src="docs/assets/readme-recordings/provider-profiles.jpg" alt="Provider profiles and Codex launch configuration in CC-Panes" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Agent Orchestration

Turn a bounded task into a coordinated run. The built-in `ccpanes` MCP lets a leader dispatch workers, observe their progress, collect results, and keep plans and Todos close to the sessions that perform the work.

[MCP orchestration guide -&gt;](docs/guide/mcp-orchestration.md)

</td>
<td width="50%">
  <a href="docs/guide/mcp-orchestration.md"><picture><source srcset="docs/assets/readme-recordings/agent-orchestration.gif" type="image/gif" /><img src="docs/assets/readme-recordings/agent-orchestration.jpg" alt="TodoList and agent orchestration panel in CC-Panes" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Skills and Shared Tooling

Browse reusable workflows, manage global skills, and attach shared MCP services to the profiles that need them. CC-Panes also surfaces installed CLI skills without forcing them into every session.

[Skills guide -&gt;](docs/guide/18-skills.md)

</td>
<td width="50%">
  <a href="docs/guide/18-skills.md"><picture><source srcset="docs/assets/readme-recordings/skills-and-mcp.gif" type="image/gif" /><img src="docs/assets/readme-recordings/skills-and-mcp.jpg" alt="CC-Panes resource center listing reusable skills" width="100%" /></picture></a>
</td>
</tr>

<tr>
<td width="50%" valign="middle">
<h3>Terminal Splits and Tabs</h3>
<p>Real PTY sessions with flexible horizontal and vertical layouts, scrollback, and saved pane layouts in one window.</p>
<p><a href="docs/guide/05-terminal-and-panes.md">Guide →</a></p>
</td>
<td width="50%">
<a href="docs/guide/05-terminal-and-panes.md"><picture><source srcset="docs/assets/readme-recordings/terminal-splits.gif" type="image/gif" /><img src="docs/assets/readme-recordings/terminal-splits.jpg" alt="Terminal launcher and multi-tab sessions in CC-Panes" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Resume and Remote Access</h3>
<p>Reopen previous work and attach from desktop, web, or Android. Keep the same workspace model across clients.</p>
<p><a href="docs/guide/14-resume.md">Guide →</a></p>
</td>
<td width="50%">
<a href="docs/guide/14-resume.md"><picture><source srcset="docs/assets/readme-recordings/resume-remote.gif" type="image/gif" /><img src="docs/assets/readme-recordings/resume-remote.jpg" alt="Home dashboard and remote web access settings in CC-Panes" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Git and Local History</h3>
<p>Inspect branches and worktrees, then use labeled snapshots, diffs, and restore points without leaving the workspace.</p>
<p><a href="docs/guide/07-git-worktree.md">Guide →</a></p>
</td>
<td width="50%">
<a href="docs/guide/07-git-worktree.md"><picture><source srcset="docs/assets/readme-recordings/git-history.gif" type="image/gif" /><img src="docs/assets/readme-recordings/git-history.jpg" alt="Workspace tooling and project history surfaces in CC-Panes" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Planning Surfaces</h3>
<p>Todos, journals, plans, specs, session summaries, and persistent memory stay next to the agents doing the work.</p>
<p><a href="docs/guide/09-todo-journal-memory.md">Guide →</a></p>
</td>
<td width="50%">
<a href="docs/guide/09-todo-journal-memory.md"><picture><source srcset="docs/assets/readme-recordings/planning-surfaces.gif" type="image/gif" /><img src="docs/assets/readme-recordings/planning-surfaces.jpg" alt="TodoList planning surface in CC-Panes" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Workspace-aware Development</h3>
<p>File browser, Monaco editor, Markdown and image previews, project hooks, and CLI adapters in the same shell.</p>
<p><a href="docs/guide/06-files-and-editor.md">Guide →</a></p>
</td>
<td width="50%">
<a href="docs/guide/06-files-and-editor.md"><picture><source srcset="docs/assets/readme-recordings/files-editor.gif" type="image/gif" /><img src="docs/assets/readme-recordings/files-editor.jpg" alt="Explorer and editor workflow in CC-Panes" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Web Access</h3>
<p>Connect to a workspace from any browser. Keep sessions in sync across desktop, web, and Android with the same workspace model.</p>
<p><a href="docs/guide/16-web-and-mobile.md">Guide →</a></p>
</td>
<td width="50%">
<a href="docs/guide/16-web-and-mobile.md"><picture><source srcset="docs/assets/readme-recordings/web-access.gif" type="image/gif" /><img src="docs/assets/readme-recordings/web-access.jpg" alt="Browser-based web access to a CC-Panes workspace" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Background Settings</h3>
<p>Personalize the shell with themes, wallpaper, opacity, and window effects. Save looks as reusable presets across workspaces.</p>
<p><a href="docs/guide/10-settings.md">Guide →</a></p>
</td>
<td width="50%">
<a href="docs/guide/10-settings.md"><picture><source srcset="docs/assets/readme-recordings/background-settings.gif" type="image/gif" /><img src="docs/assets/readme-recordings/background-settings.jpg" alt="Background and appearance settings in CC-Panes" width="100%" /></picture></a>
</td>
</tr>

</table>

**Also included:**

- Project hooks and CLI adapters for provider injection, MCP setup, resume, and lifecycle events.
- Desktop workflow extras: screenshots, tray, mini mode, command palette, themes, and resource monitoring.


---

## Supported CLI Agents

CC-Panes works with any CLI agent that runs in a terminal. First-class adapters add provider injection, MCP setup, resume, workspace flags, system prompts, and project hooks where each CLI supports them.

<p>
  <kbd>Claude Code</kbd> &nbsp;
  <kbd>Codex</kbd> &nbsp;
  <kbd>Gemini CLI</kbd> &nbsp;
  <kbd>Kimi</kbd> &nbsp;
  <kbd>GLM</kbd> &nbsp;
  <kbd>Grok</kbd> &nbsp;
  <kbd>OpenCode</kbd> &nbsp;
  <kbd>Cursor</kbd> &nbsp;
  <kbd>+ any terminal CLI</kbd>
</p>

---

## Install

### Desktop - Windows, macOS, Linux

- **[Download the latest release](https://github.com/wuxiran/cc-pane/releases/latest)**
- See the [release page](https://github.com/wuxiran/cc-pane/releases) for current installers and package formats.

Stable releases include the in-app updater. Pre-releases are available for manual installation from the release page.

### First launch

1. Install at least one supported CLI and make sure it is available on your `PATH`.
2. Open CC-Panes, create or import a workspace, add a project, and launch a session.
3. Split the terminal when the task benefits from parallel work, or use the orchestration view to dispatch bounded subtasks.

For the full walkthrough, see the [user guide](docs/guide/README.md). For web and Android setup, see the [web and mobile guide](docs/guide/16-web-and-mobile.md).

---

## Community and Support

- **Issues:** [github.com/wuxiran/cc-pane/issues](https://github.com/wuxiran/cc-pane/issues)
- **Discussions:** [github.com/wuxiran/cc-pane/discussions](https://github.com/wuxiran/cc-pane/discussions)
- **WeChat:** add `yemaofeng66` and mention `CC-Panes chat` or `CC-Panes bug feedback`.

<p>
  <img src="docs/assets/images/wechat-bug-feedback.png" alt="CC-Panes bug feedback WeChat group" width="160" />
</p>

---

## Developing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance.

```bash
git clone https://github.com/wuxiran/cc-pane.git
cd cc-pane
npm install
npm run tauri:dev
```

Useful checks:

```bash
npx tsc --noEmit
npm run build
npm run test:run
cargo fmt --all -- --check
cargo check --workspace
cargo test --workspace
```

`npm run tauri:dev` uses `com.ccpanes.dev` and `~/.cc-panes-dev/`. Release builds use `com.ccpanes.app` and `~/.cc-panes/`.

## License

CC-Panes is free and open source under the [GPL-3.0 license](LICENSE).

## Acknowledgements

Community & support: [Linux.do](https://linux.do) | [Sponsor relay hub](https://hub.nocannobb.com)

Built with: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | [Tauri](https://tauri.app/) | [xterm.js](https://xtermjs.org/) | [portable-pty](https://github.com/wez/wezterm/tree/main/pty) | [Allotment](https://github.com/johnwalley/allotment) | [shadcn/ui](https://ui.shadcn.com/)
