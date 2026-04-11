# CC-Panes

> 面向 Windows 与多 AI CLI 工作流的本地优先终端工作台。
>
> 如果说 `tmux` 更像是命令行里的多路复用器，那么 **CC-Panes** 想做的是：在 Windows 上把多项目、多终端、多模型、多工作流，真正整理成一个可视化、可协作、可扩展的 AI 编程桌面。

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)
[![Built with Tauri](https://img.shields.io/badge/Built%20with-Tauri%202-FFC131?logo=tauri)](https://v2.tauri.app/)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript)](https://www.typescriptlang.org/)

[English](README.md)

<p align="center">
  <img src="docs/assets/images/current-ui.png" alt="CC-Panes 主界面" width="980" />
</p>

CC-Panes 不只是一个“分屏终端”，而是一个把 AI 编码会话、项目组织、Workspace 元数据、本地历史、MCP 自动化与跨终端协作整合到一起的桌面工作台。

## 为什么是 CC-Panes

当你在 Windows 上同时跑多个 AI 编程任务时，很快就会遇到这些典型问题：

- 终端窗口一多，根本找不到谁在跑什么
- 手一滑就把重要标签页关掉
- 每次都要手动 `cd` 到不同目录，再分别启动 `Claude Code`、`Codex CLI` 或别的工具
- 前后端分离项目要来回切目录、开多个窗口
- 项目目录逐渐塞满 `.idea`、`.cursor`、`.claude`、`.codex` 等工具配置和缓存
- Windows 和 WSL 混合开发时，路径和会话管理经常割裂

CC-Panes 的目标，就是把这些高频又零碎的痛点收敛到一个统一的工作台里。

## 它和普通终端工具有什么不同

- 以 Workspace 为中心组织项目，而不是直接污染代码仓库
- 支持多标签、多面板、可 Pin 的稳定终端布局
- 提供 AI CLI 的统一启动入口
- 通过 MCP 暴露终端与工作区能力，便于 AI 自动化协作
- 原生考虑 Windows 与 WSL 混合工作流
- 把 Git、文件、编辑、历史、Todo、Plans、Specs、Memory、Skills 收进同一个产品里

## 界面亮点

### Workspace 优先的组织方式

真实代码仍然放在原来的目录里，而 AI 工作流相关的元数据、提示词、文档和运行上下文则可以统一沉淀到 Workspace。

<p align="center">
  <img src="docs/assets/images/community/workspace-overview.png" alt="Workspace 目录概览" width="760" />
</p>

Workspace 里还可以保留 AI 可读的上下文文件，例如 `CLAUDE.md`：

<p align="center">
  <img src="docs/assets/images/community/workspace-claude-md.png" alt="Workspace 中的 CLAUDE.md" width="760" />
</p>

这样做带来的直接好处是：

- Git 仓库更干净
- AI 配置和缓存集中管理
- 多项目、多服务、多环境能在一个工作区里统一组织
- AI 更容易理解“这个工作区整体在做什么”

### 可 Pin 的标签页和分屏终端

在 CC-Panes 里，终端标签页不只是能打开和关闭，还可以：

- 固定（Pin）
- 改名
- 左右移动
- 拆分到右侧或下方
- 形成相对稳定的多面板布局

这意味着你不需要再担心“手误关掉正在跑任务的会话”。

<p align="center">
  <img src="docs/assets/images/community/pin-menu.png" alt="标签页固定与拆分菜单" width="260" />
</p>

### 统一的项目启动入口

左侧项目菜单不只是“打开目录”，还可以直接承载常用 AI CLI 的启动入口。

你提供的截图里已经展示出这类入口的形态：

<p align="center">
  <img src="docs/assets/images/community/cli-menu.png" alt="项目启动菜单" width="280" />
</p>

这类入口的意义在于：

- 不用反复手动切路径
- 不用重复敲启动命令
- 不同项目、不同环境、不同会话可以在同一个 Workspace 中统一调度

## 真正的分水岭：MCP

### 把终端与工作区能力暴露给 AI

CC-Panes 很有辨识度的一点，是把大量终端和工作区操作暴露成了 **MCP（Model Context Protocol）能力**。

这意味着 AI 不只是“看终端输出”，而是可以：

- 读取会话状态
- 向其他会话写入命令
- 创建工作区和导入项目
- 分发任务
- 操作 Todo、文件与 Pane

下图已经展示了 MCP 能力的大致覆盖面：

<p align="center">
  <img src="docs/assets/images/community/mcp-overview.png" alt="MCP 服务能力概览" width="980" />
</p>

能力大致包括：

- 任务管理
- PTY 会话
- 工作区管理
- Todo
- 任务绑定
- 文件操作
- Pane 管理
- 历史记录

## Team 编程工作流

### Claude 负责规划，Codex 负责实现

社区帖子里提到一个很有代表性的用法：

- 先让 Claude 做 Plan
- 再通过 `launch_task` 把任务分发给 Codex
- 之后由 Claude 或其他会话继续监控和推进

这不是简单地“开两个终端”，而是在构建一种可拆分的工作流：

- `Plan` 和 `Implementation` 分离
- 可扩展为多窗口并行执行
- 更接近“团队编程”而不是“单会话问答”

相关技能流在你的素材中也已经出现：

<p align="center">
  <img src="docs/assets/images/community/plan-to-codex.png" alt="Plan 到 Codex 的工作流" width="760" />
</p>

这类模式特别适合复杂任务：

- 主模型负责规划与审阅
- 子模型负责具体编码
- 会话之间通过 MCP 或状态同步来协作

## WSL 不是附加项，而是核心场景之一

### Windows / WSL 双路径工作流

很多人在 Windows 上做 AI 编程，最后都会进入 WSL 场景。
但 WSL 里的 CLI 与 Windows 里的 CLI 往往像两套世界。

CC-Panes 的做法是：

- 给同一个工作区保留 Windows 路径
- 同时支持 WSL 路径映射
- 在界面里直接区分本地项目和 WSL 项目

<p align="center">
  <img src="docs/assets/images/community/workspace-wsl.png" alt="Workspace 中的本地与 WSL 项目" width="520" />
</p>

<p align="center">
  <img src="docs/assets/images/community/self-dialogue.png" alt="WSL 与模型状态示意" width="760" />
</p>

这让下面这种混合开发方式更容易成立：

- 在 WSL 中读写代码
- 在 Windows 环境中编译、运行或调试
- 在一个可视化工作台里统一管理全部会话

## Todo 也是工作流的一部分

### 不只是记事本，而是任务调度层

你给的截图里已经能看出 Todo 面板是一个完整功能，而不是单纯的任务列表：

- 支持任务状态
- 支持优先级
- 支持不同范围过滤
- 支持右侧编辑面板
- 支持与项目、标签、会话结合

<p align="center">
  <img src="docs/assets/images/community/todo-board.png" alt="Todo 面板" width="980" />
</p>

如果把它和 MCP、终端会话、计划流串起来，它就更接近：

> **AI 编程工作流中的任务调度层。**

## 适合谁用

如果你属于下面这些用户，CC-Panes 会特别对路：

- 在 Windows 上做 AI 编程的人
- 需要同时管理多个终端和多个项目的人
- 经常使用 Claude Code、Codex CLI 等工具的人
- 想把 AI 工作流做成“可协作、可拆分、可复用”的人
- 对项目目录洁癖很重，不想让各种 AI 配置污染 Git 仓库的人

## 当前最值得关注的亮点

- Workspace 化管理，尽量不污染真实代码仓库
- 多 CLI 统一入口，包含本地与 WSL 场景
- Pin + 分屏布局，提升多会话稳定性
- MCP 暴露，支持跨终端协作
- Plan -> Codex 的任务分发思路已经成型
- Todo、Specs、Skills、Memory 正在拼出完整工作流
- 对 Windows 用户尤其友好，是少见认真把 AI 终端编程做成桌面产品的方向

## 未来方向

从帖子和现有代码结构看，后续很值得期待的方向包括：

- 更完整的 SSH 项目支持
- 更成熟的远程会话恢复
- 更丰富的 MCP 自动化能力
- 更完整的 Team 编程工作流
- 更统一的多模型、多工具协作体验

## 支持的 CLI 工具

仓库中的 [`cc-cli-adapters/`](cc-cli-adapters/) 已内建统一适配层，目前代码里已确认包含：

- `Claude Code`
- `Codex CLI`
- `Gemini CLI`
- `OpenCode`

其中 Claude Code 与 Codex 当前集成深度最高。

## 核心功能版图

- 支持拖拽调整的多面板终端布局
- Workspace 与项目组织，包含 SSH / WSL 场景支持
- 启动历史与会话恢复
- Git 集成：fetch、pull、push、stash、clone、worktree
- 文件浏览器、Monaco 编辑器、Markdown 预览、图片预览
- 本地历史：diff、标签、分支感知快照、恢复
- Todo、Plans、Specs、Memory、Skills、Workflow 文档
- Hooks、Orchestrator、MCP 配置与 Shared MCP
- 托盘、迷你模式、全屏、通知、截图、快捷键
- 英文与简体中文界面

## 架构概览

CC-Panes 是一个围绕 Tauri 桌面壳组织起来的小型 monorepo：

- `web/`
  React 前端，负责 Zustand 状态管理、xterm.js 终端渲染、Monaco 编辑器和 Tauri invoke 封装。
- `src-tauri/`
  Tauri 应用壳，负责窗口、托盘、截图、更新器、原生能力接入和 IPC 命令注册。
- `cc-panes-core/`
  与框架无关的核心业务层，负责终端、Workspace、本地历史、Provider、Hooks、Todo、Plans、Specs、SSH、设置和 MCP 相关逻辑。

配套 Rust crate 包括：

- `cc-cli-adapters/`
- `cc-memory/`
- `cc-memory-mcp/`
- `cc-panes-api/`
- `cc-panes-web/`
- `cc-panes-hook/`
- `cc-notify/`

## 仓库结构

```text
cc-pane/
|-- web/                 # React 前端
|-- src-tauri/           # Tauri 壳与原生能力
|-- cc-panes-core/       # 核心领域逻辑
|-- cc-cli-adapters/     # AI CLI 适配层
|-- cc-memory/           # Memory 存储
|-- cc-memory-mcp/       # Memory MCP 服务
|-- cc-panes-api/        # HTTP/WebSocket 适配层
|-- cc-panes-web/        # Web terminal server
|-- cc-panes-hook/       # Hook 二进制
|-- cc-notify/           # 通知抽象
|-- docs/                # 文档与资源
|-- scripts/             # 开发辅助脚本
|-- package.json         # 前端脚本
`-- Cargo.toml           # Rust workspace
```

## 数据模型

CC-Panes 围绕 `workspace -> project -> task/session` 组织数据。

- 全局数据目录：Release 使用 `~/.cc-panes/`
- 开发数据目录：Dev 使用 `~/.cc-panes-dev/`
- 项目级工作流数据：存放在 `<project>/.ccpanes/`

常见项目级目录包括：

- `history/`
- `journal/`
- `plans/`
- `prompts/`
- `specs/`
- `workflow.md`

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面框架 | Tauri 2 |
| 前端 | React 19 + TypeScript |
| 状态管理 | Zustand 5 + Immer |
| 样式系统 | Tailwind CSS 4 |
| UI 基础组件 | shadcn/ui + Radix UI |
| 终端 | xterm.js + portable-pty |
| 编辑器 | Monaco Editor |
| 本地持久化 | SQLite (`rusqlite`) |
| 构建工具 | Vite 6 |

## 环境要求

- [Node.js](https://nodejs.org/) 22+
- [Rust](https://rustup.rs/) 1.83+
- [Tauri 2](https://v2.tauri.app/start/prerequisites/) 所需的平台依赖

## 快速开始

```bash
git clone https://github.com/wuxiran/cc-pane.git
cd cc-pane
npm install
npm run tauri:dev
```

构建桌面安装包：

```bash
npm run tauri build
```

## 常用开发命令

```bash
# frontend
npm run tauri:dev
npm run test:run
npx tsc --noEmit

# Rust workspace
cargo check --workspace
cargo test --workspace
cargo clippy --workspace -- -D warnings
cargo fmt --all -- --check
```

## WSL 开发建议

如果你想在 WSL 中按 Linux 原生方式开发，建议把仓库放在 Linux 文件系统而不是 `/mnt/c/...` 或 `/mnt/d/...` 下，然后执行：

```bash
./scripts/setup-wsl-dev.sh
```

## Dev / Release 隔离

开发版与发行版使用不同的应用标识和数据目录，因此可以并行运行而不相互污染：

| 模式 | App identifier | 数据目录 |
| --- | --- | --- |
| Dev (`npm run tauri:dev`) | `com.ccpanes.dev` | `~/.cc-panes-dev/` |
| Release (`npm run tauri build`) | `com.ccpanes.app` | `~/.cc-panes/` |

## 文档

[`docs/`](docs/) 目录收录了主要子系统的设计和实现记录，包括：

- Workspace 与项目基础模型
- Provider 与平台适配
- 本地历史
- Skill 系统
- Memory 系统
- GUI 演进与打包发布

## 贡献

欢迎贡献，建议先阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 了解项目约定。

## 许可证

本项目采用 [GNU General Public License v3.0](LICENSE) 开源。
