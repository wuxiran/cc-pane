<h1 align="center">
  <a href="https://github.com/wuxiran/cc-pane"><img src="../../src-tauri/icons/icon.png" alt="CC-Panes" width="64" valign="middle" /></a> CC-Panes
</h1>

<p align="center">
  <a href="https://github.com/wuxiran/cc-pane/releases/latest"><img src="https://img.shields.io/github/v/release/wuxiran/cc-pane?display_name=tag&amp;sort=semver" alt="最新版本" /></a>
  <a href="https://github.com/wuxiran/cc-pane/releases"><img src="https://img.shields.io/github/downloads/wuxiran/cc-pane/total?label=downloads&amp;color=success" alt="下载量" /></a>
  <img src="https://img.shields.io/badge/license-GPL--3.0-08C?style=flat" alt="GPL-3.0 协议" />
  <img src="https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-4493F8?style=flat-square" alt="支持 Windows、macOS 和 Linux" />
</p>

<p align="center">
  <sub><a href="../../README.md">English</a> · <strong>中文</strong> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.es.md">Español</a> · <a href="README.fr.md">Français</a> · <a href="README.pt.md">Português</a></sub>
</p>

<p align="center">
  <strong>面向并行 AI 编程的桌面控制中心。</strong><br />
  并排运行 CLI Agent，组织工作空间与会话，再通过 MCP、计划、Skill、Git 与本地历史协同完成工作。
</p>

<h3 align="center"><a href="https://github.com/wuxiran/cc-pane/releases/latest"><ins>下载 CC-Panes</ins></a></h3>

<p align="center">
  <picture>
    <source srcset="../assets/readme-recordings/readme-hero.gif" type="image/gif" />
    <img src="../assets/readme-recordings/readme-hero.jpg" alt="CC-Panes 命令中心：用量、项目与会话总览" width="960" />
  </picture>
</p>

<p align="center"><sub>以下产品画面来自真实的 CC-Panes 桌面端交互录制。</sub></p>

## 核心功能

<table>
<tr>
<td width="50%" valign="middle">
<h3>工作区命令中心</h3>
<p>在一个本地桌面视图中查看活跃会话、最近项目、可用 CLI、用量趋势与工作空间上下文。在工作空间、项目、任务与终端之间切换，而不丢失工作主线。</p>
<p><a href="../guide/03-core-concepts.md">指南 →</a></p>
</td>
<td width="50%">
<a href="../guide/03-core-concepts.md"><picture><source srcset="../assets/readme-recordings/readme-hero.gif" type="image/gif" /><img src="../assets/readme-recordings/readme-hero.jpg" alt="CC-Panes 工作区仪表盘：项目与活跃会话" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Provider 与启动配置</h3>
<p>把 CLI、Provider、MCP、Skill、运行环境与权限策略组合为可复用的启动配置。本机、WSL、SSH 工作流共用同一工作空间模型。</p>
<p><a href="../guide/10-settings.md">设置指南 →</a></p>
</td>
<td width="50%">
<a href="../guide/10-settings.md"><picture><source srcset="../assets/readme-recordings/provider-profiles.gif" type="image/gif" /><img src="../assets/readme-recordings/provider-profiles.jpg" alt="CC-Panes 中的 Provider 配置与启动设置" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Agent 编排</h3>
<p>把有边界的任务变成一次协同运行。内置 <code>ccpanes</code> MCP 让 Leader 派发 Worker、观察进度、收集结果，并把计划与 Todo 放在执行会话旁边。</p>
<p><a href="../guide/mcp-orchestration.md">MCP 编排指南 →</a></p>
</td>
<td width="50%">
<a href="../guide/mcp-orchestration.md"><picture><source srcset="../assets/readme-recordings/agent-orchestration.gif" type="image/gif" /><img src="../assets/readme-recordings/agent-orchestration.jpg" alt="CC-Panes 的 TodoList 与 Agent 编排面板" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Skill 与共享工具</h3>
<p>浏览可复用工作流、管理全局 Skill，并把共享 MCP 挂到需要的配置上。CC-Panes 也会展示已安装的 CLI Skill，而不强制注入每个会话。</p>
<p><a href="../guide/18-skills.md">Skills 指南 →</a></p>
</td>
<td width="50%">
<a href="../guide/18-skills.md"><picture><source srcset="../assets/readme-recordings/skills-and-mcp.gif" type="image/gif" /><img src="../assets/readme-recordings/skills-and-mcp.jpg" alt="CC-Panes 资源中心中的可复用 Skill 列表" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>终端分屏与标签</h3>
<p>真实 PTY 会话，支持灵活的水平/垂直布局、滚动回看，以及在同一窗口中保存窗格布局。</p>
<p><a href="../guide/05-terminal-and-panes.md">指南 →</a></p>
</td>
<td width="50%">
<a href="../guide/05-terminal-and-panes.md"><picture><source srcset="../assets/readme-recordings/terminal-splits.gif" type="image/gif" /><img src="../assets/readme-recordings/terminal-splits.jpg" alt="CC-Panes 终端启动器与多标签会话" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>恢复与远程访问</h3>
<p>重新打开历史工作，并通过桌面、Web 或 Android 伴生端附着。跨客户端保持同一工作空间模型。</p>
<p><a href="../guide/14-resume.md">指南 →</a></p>
</td>
<td width="50%">
<a href="../guide/14-resume.md"><picture><source srcset="../assets/readme-recordings/resume-remote.gif" type="image/gif" /><img src="../assets/readme-recordings/resume-remote.jpg" alt="CC-Panes 首页与 Web 远程访问设置" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Git 与本地历史</h3>
<p>查看分支与 worktree，使用带标签的快照、Diff 与恢复点，无需离开工作空间。</p>
<p><a href="../guide/07-git-worktree.md">指南 →</a></p>
</td>
<td width="50%">
<a href="../guide/07-git-worktree.md"><picture><source srcset="../assets/readme-recordings/git-history.gif" type="image/gif" /><img src="../assets/readme-recordings/git-history.jpg" alt="CC-Panes 工作空间工具与项目历史" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>规划面板</h3>
<p>Todo、日志、Plan、Spec、会话摘要与持久 Memory，就在执行任务的 Agent 旁边。</p>
<p><a href="../guide/09-todo-journal-memory.md">指南 →</a></p>
</td>
<td width="50%">
<a href="../guide/09-todo-journal-memory.md"><picture><source srcset="../assets/readme-recordings/planning-surfaces.gif" type="image/gif" /><img src="../assets/readme-recordings/planning-surfaces.jpg" alt="CC-Panes 的 TodoList 规划面板" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>面向工作空间的开发</h3>
<p>文件浏览器、Monaco 编辑器、Markdown/图片预览、项目 hooks 与 CLI 适配器，都在同一外壳中。</p>
<p><a href="../guide/06-files-and-editor.md">指南 →</a></p>
</td>
<td width="50%">
<a href="../guide/06-files-and-editor.md"><picture><source srcset="../assets/readme-recordings/files-editor.gif" type="image/gif" /><img src="../assets/readme-recordings/files-editor.jpg" alt="CC-Panes 资源管理器与编辑工作流" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Web 端接入</h3>
<p>从任意浏览器接入工作区，桌面、Web、Android 使用同一套工作区模型保持会话同步。</p>
<p><a href="../guide/16-web-and-mobile.md">指南 →</a></p>
</td>
<td width="50%">
<a href="../guide/16-web-and-mobile.md"><picture><source srcset="../assets/readme-recordings/web-access.gif" type="image/gif" /><img src="../assets/readme-recordings/web-access.jpg" alt="通过浏览器接入 CC-Panes 工作区" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>背景设置</h3>
<p>通过主题、壁纸、透明度与窗口效果个性化你的 Shell，并可保存为可复用的预设跨工作区使用。</p>
<p><a href="../guide/10-settings.md">指南 →</a></p>
</td>
<td width="50%">
<a href="../guide/10-settings.md"><picture><source srcset="../assets/readme-recordings/background-settings.gif" type="image/gif" /><img src="../assets/readme-recordings/background-settings.jpg" alt="CC-Panes 背景与外观设置" width="100%" /></picture></a>
</td>
</tr>
</table>

**另外还包括：**

- 项目 hooks 与 CLI 适配器，用于 Provider 注入、MCP 配置、Resume 与生命周期事件。
- 桌面工作流扩展：截图、托盘、迷你模式、命令面板、主题与资源监控。

---

## 支持的 CLI Agent

CC-Panes 支持任意能在终端运行的 CLI Agent。一等适配器会在各 CLI 实际支持的范围内启用 Provider 注入、MCP、Resume、工作区参数、系统提示和项目 hooks。

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

## 安装

### 桌面端 — Windows、macOS、Linux

- **[下载最新版本](https://github.com/wuxiran/cc-pane/releases/latest)**
- 在 [Release 页](https://github.com/wuxiran/cc-pane/releases) 查看当前安装包与格式。

稳定版支持应用内更新；预发布版请在 Release 页手动安装。

### 第一次启动

1. 安装至少一个支持的 CLI，并确保它在 `PATH` 中。
2. 打开 CC-Panes，创建或导入工作空间，添加项目，并启动会话。
3. 任务适合并行时分屏终端，或使用编排视图派发有边界的子任务。

完整说明见[使用手册](../guide/README.md)。Web / Android 见 [Web 与手机端指南](../guide/16-web-and-mobile.md)。

---

## 社区与支持

- **Issues：** [github.com/wuxiran/cc-pane/issues](https://github.com/wuxiran/cc-pane/issues)
- **Discussions：** [github.com/wuxiran/cc-pane/discussions](https://github.com/wuxiran/cc-pane/discussions)
- **微信：** 添加 `yemaofeng66`，备注 `CC-Panes 交流群` 或 `CC-Panes Bug 反馈`

<p>
  <img src="../assets/images/wechat-bug-feedback.png" alt="CC-Panes Bug 反馈微信群" width="160" />
</p>

---

## 开发

贡献或本地运行请看 [CONTRIBUTING.md](https://github.com/wuxiran/cc-pane/blob/main/CONTRIBUTING.md)。

```bash
git clone https://github.com/wuxiran/cc-pane.git
cd cc-pane
npm install
npm run tauri:dev
```

常用检查：

```bash
npx tsc --noEmit
npm run build
npm run test:run
cargo fmt --all -- --check
cargo check --workspace
cargo test --workspace
```

`npm run tauri:dev` 使用 `com.ccpanes.dev` 与 `~/.cc-panes-dev/`；发行版使用 `com.ccpanes.app` 与 `~/.cc-panes/`。

## 许可证

CC-Panes 使用 [GPL-3.0](https://github.com/wuxiran/cc-pane/blob/main/LICENSE) 协议开源。

## 致谢

社区与支持: [Linux.do](https://linux.do) | [Sponsor relay hub](https://hub.nocannobb.com)

技术栈: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | [Tauri](https://tauri.app/) | [xterm.js](https://xtermjs.org/) | [portable-pty](https://github.com/wez/wezterm/tree/main/pty) | [Allotment](https://github.com/johnwalley/allotment) | [shadcn/ui](https://ui.shadcn.com/)
