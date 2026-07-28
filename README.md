<div align="center">

<img src="src-tauri/icons/icon.png" width="120" alt="CC-Panes logo" />

# CC-Panes

**A Claude Code–first, multi-agent workspace — run parallel coding sessions side by side.**

[![Latest Release](https://img.shields.io/github/v/release/wuxiran/cc-pane?display_name=tag&sort=semver)](https://github.com/wuxiran/cc-pane/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/wuxiran/cc-pane/total?label=downloads&color=success)](https://github.com/wuxiran/cc-pane/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](https://github.com/wuxiran/cc-pane/releases/latest)
[![License](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)

**English** · [中文](README.zh-CN.md) · [📖 User Guide](docs/guide/README.md)

[**⬇ Download**](https://github.com/wuxiran/cc-pane/releases/latest) · [Report an Issue](https://github.com/wuxiran/cc-pane/issues) · [Discussions](https://github.com/wuxiran/cc-pane/discussions)

<img src="docs/assets/images/current-ui.png" width="920" alt="CC-Panes dark workspace with project sidebar and terminal panes" />

</div>

Running one AI coding agent is easy. Running five is where it falls apart — you lose track of which terminal is working on what, which project it sits in, which provider it is on, and what it did an hour ago.

CC-Panes is a desktop control center for that. It keeps projects, terminals, launch profiles, providers, todos, file browsing, Git status, local history, and session resume in one place so you can drive several coding agents without losing the thread. It is not just a terminal shell: it adds project organization, parallel orchestration, context recovery, and a desktop toolchain on top of Claude Code, Codex, Gemini and other CLI workflows — with adapters for Kimi, GLM, OpenCode, and Cursor, and provider profiles you can pick at launch time.

<!-- TODO(media): 功能墙 6 组，见 docs/67-storyboards.md §3
     A 派工编排 / B 分屏并行 / D worktree 隔离 / C 移动端接管 / E AI 面板 / F skill 体系
     每组用 <picture> + <source srcset type="image/gif"> + JPG fallback，外包 <a> 链到对应 guide 篇 -->

## Screenshots

| Multi-pane workspace | Focused terminal workspace |
| --- | --- |
| <img src="docs/assets/images/screenshot-new-ui.png" alt="CC-Panes multi-pane terminal layout" width="440" /> | <img src="docs/assets/images/screenshot-panel.png" alt="CC-Panes terminal panel view" width="440" /> |

| Todo and task planning | Light workspace view |
| --- | --- |
| <img src="docs/assets/images/screenshot-todolist.png" alt="CC-Panes todo and task panel" width="440" /> | <img src="docs/assets/images/screenshot-main.png" alt="CC-Panes light workspace" width="440" /> |

## ⬇ Download

Prebuilt installers are on the [latest release page](https://github.com/wuxiran/cc-pane/releases/latest).

| Platform | Files |
| --- | --- |
| **Windows** | `*_x64-setup.exe` · `*_arm64-setup.exe` |
| **macOS** | `*_aarch64.dmg` · `*_x64.dmg` |
| **Linux** | `*_amd64.AppImage` · `*_amd64.deb` |

Stable releases auto-update in-app; beta builds are published as pre-releases and can be installed manually.

## Capabilities

Workspaces, projects, tasks, todos, launch history, provider profiles, Git, local history, and file editing — all in one place:

| Area | What you get |
| --- | --- |
| **Agent orchestration** | A built-in `ccpanes` MCP server (`launch_task`, memory, workspace, and plan tools) lets one agent spawn and coordinate others; leader / worker handoff with reporting back; bundled Claude Code commands, agents, hooks, and CC-Panes skills for orchestrated workflows. |
| **Parallel terminals** | Flexible split panes and tabbed terminals backed by xterm.js and portable-pty; launch Claude Code, Codex, Gemini, Kimi, GLM, OpenCode, and Cursor sessions; resume historical sessions with launch history attached to each project; built-in terminal input tools, paste handling, clipboard support, and terminal diagnostics. |
| **Multi-device sessions** | A standalone daemon hosts your PTYs, so desktop, web, and the mobile mirror attach to the same live sessions; a Flutter Android client mirrors your desktop layout and lets you take over a session from the phone. |
| **Workspaces and projects** | Workspace and project sidebar with pin, hide, reorder, scan, import, and create flows; per-project metadata, launch history, tasks, todos, and MCP configuration; project file browser with create, rename, delete, copy, move, search, and editor open; Monaco editor with Markdown preview and image preview. |
| **Launch profiles and providers** | Launch profiles for repeatable CLI, runtime (local / WSL / SSH), provider, skill, and environment choices; provider support for Anthropic, Bedrock, Vertex, OpenAI-compatible proxies, Gemini, Kimi, GLM, OpenCode, Cursor, and local config profiles; launch-time provider modes for inheriting, selecting explicitly, or running without provider injection. |
| **Git, history, and review** | Git branch status, fetch, pull, push, stash, clone, and worktree helpers; branch-aware local history snapshots with labels and diff view; file version recovery tools for comparing and restoring local edits. |
| **Desktop workflow** | Dev and release build isolation for data directories, identifiers, shortcuts, and window titles; global screenshot shortcut with region capture and multi-monitor support; tray behavior, notifications, voice input, mini view, fullscreen focus, and configurable shortcuts; cross-platform packages for Windows, macOS, and Linux. |

## 📖 Tutorials

The [user guide](docs/guide/README.md) covers 20 chapters in four layers:

- [**1 · Getting started**](docs/guide/README.md#一入门) — what CC-Panes is, install and first launch, core concepts, your first Claude session, terminals and panes.
- [**2 · Daily use**](docs/guide/README.md#二日常使用) — files and editor, Git and worktrees, local history, todos / journal / memory, settings.
- [**3 · Advanced**](docs/guide/README.md#三高级玩法cc-panes-的核心卖点) — MCP orchestration, parallel runs, leader / worker, plan handoff and peer review, resume, WSL / SSH, web and mobile, AI panel, skills, right dock, in-app browser.
- [**4 · Reference**](docs/guide/README.md#四参考) — where data lives and how to troubleshoot, shortcut sheet, FAQ.

## ❤️ Sponsors

CC-Panes is built independently. Its sole sponsor:

<div align="center">

### <a href="https://hub.nocannobb.com">nocannobb</a>

**Sponsor relay hub** — a Claude Code / Codex API relay station.

<sub><a href="https://hub.nocannobb.com">hub.nocannobb.com</a></sub>

</div>

Want to support CC-Panes? Open an issue or reach out via [WeChat](#-community).

## Co-creators

Thanks to the people building CC-Panes together:

<table>
  <tr>
    <td align="center">
      <a href="https://github.com/zhengjunkj">
        <img src="https://github.com/zhengjunkj.png" width="80" alt="zhengjunkj" /><br />
        <sub><b>zhengjunkj</b></sub>
      </a>
    </td>
  </tr>
</table>

## 💬 Community

- **GitHub Issues** — <https://github.com/wuxiran/cc-pane/issues>
- **GitHub Discussions** — <https://github.com/wuxiran/cc-pane/discussions>
- **WeChat chat group** — add `yemaofeng66`, mention `CC-Panes chat`.

**Bug feedback group** — add `yemaofeng66`, mention `CC-Panes bug feedback`:

<p>
  <img src="docs/assets/images/wechat-bug-feedback.png" alt="CC-Panes Bug Feedback WeChat" width="200" />
</p>

## License

CC-Panes is licensed under [GPL-3.0](LICENSE).

## Acknowledgments

- [Sponsor relay hub](https://hub.nocannobb.com)
- [Linux.do](https://linux.do)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- [Tauri](https://tauri.app/)
- [xterm.js](https://xtermjs.org/)
- [portable-pty](https://github.com/wez/wezterm/tree/main/pty)
- [Allotment](https://github.com/johnwalley/allotment)
- [shadcn/ui](https://ui.shadcn.com/)

---

Building from source? See [CONTRIBUTING.md](CONTRIBUTING.md).
