# CC-Panes

> 面向 Windows 与多 AI CLI 工作流的本地优先终端工作台。
>
> 在 Windows 上把多项目、多终端、多模型、多工作流，真正整理成一个可视化、可协作、可扩展的 AI 编程桌面。
> 
> CC-Panes 集合了 AI 编码会话、项目组织、Workspace 元数据、本地历史、MCP 自动化与跨终端协作整合到一起的桌面工作台。


[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)
[![Built with Tauri](https://img.shields.io/badge/Built%20with-Tauri%202-FFC131?logo=tauri)](https://v2.tauri.app/)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript)](https://www.typescriptlang.org/)

[English](README.md)

## 下载

Windows 安装包可在 [GitHub Releases](https://github.com/wuxiran/cc-pane/releases) 页面下载。下载最新的 `.exe` 安装程序即可使用。

> 其他平台可[从源码构建](#快速开始)。

## 什么是 CC-Panes

CC-Panes 是一个基于 **Tauri 2 + React 19 + Rust** 构建的桌面应用，围绕 AI 编程时代最常见的工作流来设计：

- 多项目 AI CLI 会话管理
- Workspace 级项目组织
- 可 Pin 的多标签分屏终端
- MCP 驱动的跨终端协作
- WSL / Windows 双环境适配
- Todo / Plans / Skills / Memory / Spec 等工作流能力
- 截图、文件浏览、Git、会话恢复等开发辅助能力

简单来说：

> **CC-Panes 是面向 AI 编程时代的 Workspace 化终端工作流平台。**

## 为什么需要 CC-Panes

### Windows AI 编程的痛点

- 终端窗口多，找不到谁在跑什么
- 手滑关掉重要标签页
- 反复 `cd` 目录启动 Claude Code、Codex 等工具
- 前后端项目来回切换窗口
- 项目目录被 `.idea`、`.cursor`、`.claude` 等配置污染
- Windows + WSL 混合开发路径割裂

### 与普通终端的区别

| 特性 | 普通终端 | CC-Panes |
|------|----------|----------|
| 组织方式 | 以窗口为中心 | **Workspace 为中心**，代码与配置分离 |
| 标签管理 | 易丢失 | **可 Pin、可分屏**，布局稳定 |
| CLI 启动 | 手动输入 | **统一入口**，一键启动 |
| AI 协作 | 单会话 | **MCP 协议**，跨终端协作 |
| 环境适配 | 割裂 | **Windows + WSL 原生双路径** |

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│  React 前端                                                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐  │
│  │ 侧边栏   │ │ 分屏面板  │ │ 功能面板  │ │ UI 组件       │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └───────────────┘  │
│       │             │            │                           │
│  ┌────┴─────────────┴────────────┴────┐                     │
│  │  Services (invoke) + Stores        │                     │
│  └────────────────┬───────────────────┘                     │
├───────────────────┼─────────────────────────────────────────┤
│  Tauri IPC        │                                         │
├───────────────────┼─────────────────────────────────────────┤
│  Rust 后端        │                                         │
│  ┌────────────────┴───────────────────┐                     │
│  │  Commands → Services → Repository  │                     │
│  └────────────────┬───────────────────┘                     │
│  ┌────────────────┴───────────────────┐                     │
│  │  SQLite / 文件系统 / PTY           │                     │
│  └────────────────────────────────────┘                     │
└─────────────────────────────────────────────────────────────┘
```

## 技术栈

| 层次 | 技术 | 用途 |
|------|------|------|
| 桌面框架 | Tauri 2 | Rust 后端 + 系统 WebView |
| 前端 | React 19 + TypeScript | UI 组件 |
| 状态管理 | Zustand 5 + Immer | 不可变状态更新 |
| UI 库 | shadcn/ui + Radix UI | 组件库 |
| 样式 | Tailwind CSS 4 | 原子化 CSS |
| 终端 | xterm.js + portable-pty | 前端渲染 + 后端 PTY |
| 分屏 | Allotment | 可拖拽分屏布局 |
| 数据存储 | SQLite (rusqlite) | 本地持久化 |
| 图标 | Lucide React | SVG 图标 |
| 构建工具 | Vite 6 | 前端构建 |

## 环境要求

- [Node.js](https://nodejs.org/) 22+
- [Rust](https://rustup.rs/) 1.83+
- [Tauri](https://v2.tauri.app/start/prerequisites/) 所需的平台特定依赖

## 快速开始

```bash
# 克隆仓库
git clone https://github.com/wuxiran/cc-pane.git
cd cc-pane

# 安装前端依赖
npm install

# 以开发模式运行（前端 + Rust 后端）
npm run tauri:dev
```

### WSL 原生开发

如果你想在 WSL 里作为 Linux 原生应用开发，而不是继续使用 `/mnt/d/...` 这种 Windows 挂载路径，推荐这样做：

```bash
# 1) 把仓库放到 WSL Linux 文件系统
mkdir -p ~/workspace
cd ~/workspace
git clone https://github.com/wuxiran/cc-pane.git cc-book
cd cc-book

# 2) 安装 Tauri/Linux 依赖
./scripts/setup-wsl-dev.sh

# 3) 安装前端依赖
npm install

# 4) 验证 Rust 工作区
cargo check --workspace

# 5) 启动开发环境（需要 WSLg / Linux 图形环境）
npm run tauri:dev
```

注意事项：

- 不要把 WSL 原生主开发仓库放在 `/mnt/c/...`、`/mnt/d/...` 这类挂载路径下，文件监听和构建性能都会更差
- 如果 `cargo` / `npm` 下载失败，先检查 `HTTP_PROXY` / `HTTPS_PROXY` 是否仍然指向有效代理
- 本仓库默认将 Cargo 构建输出放在仓库内的 `target/` 目录，避免绑定 Windows 专属路径

## 构建

```bash
# 构建生产应用
npm run tauri build
```

构建产物位于 `src-tauri/target/release/bundle/`。

## 开发

```bash
# 前端类型检查
npx tsc --noEmit

# 运行前端测试
npm run test:run

# Rust 检查
cargo check --workspace

# Rust lint
cargo clippy --workspace -- -D warnings

# Rust 格式化检查
cargo fmt --all -- --check

# 运行 Rust 测试
cargo test --workspace
```

### Dev/Release 隔离

Dev 和 Release 构建通过 `cfg!(debug_assertions)` 完全隔离，可同时运行互不冲突：

| | Dev (`npm run tauri:dev`) | Release (`npm run tauri build`) |
|---|---|---|
| 数据目录 | `~/.cc-panes-dev/` | `~/.cc-panes/` |
| 标识符 | `com.ccpanes.dev` | `com.ccpanes.app` |
| 窗口标题 | CC-Panes [DEV] | CC-Panes |

## 项目结构

```
cc-panes/
├── web/                    # React 前端源码
│   ├── components/         # React 组件
│   │   ├── panes/          # 分屏终端组件
│   │   ├── sidebar/        # 侧边栏组件
│   │   ├── providers/      # Provider 管理 UI
│   │   └── ui/             # shadcn/ui 基础组件
│   ├── stores/             # Zustand 状态管理
│   ├── services/           # 前端服务层（invoke 封装）
│   ├── hooks/              # 自定义 React Hooks
│   ├── types/              # TypeScript 类型定义
│   ├── i18n/               # 国际化
│   ├── lib/                # 前端共享辅助
│   └── utils/              # 工具函数
│
├── src-tauri/              # Tauri Rust 后端
│   └── src/
│       ├── commands/        # Tauri IPC 命令处理
│       ├── services/        # 业务逻辑层
│       ├── repository/      # 数据访问层（SQLite）
│       ├── models/          # 数据模型
│       └── utils/           # 工具（AppPaths, AppError）
│
├── cc-panes-*/             # 共享 Rust workspace crates
└── docs/                   # 设计文档、示例与文档资源
```


## 界面亮点

### Workspace 优先的组织方式

真实代码仍然放在原来的目录里，而 AI 工作流相关的元数据、提示词、文档和运行上下文则可以统一沉淀到 Workspace。Workspace 里还可以保留 AI 可读的上下文文件，例如 `CLAUDE.md`。这样做能让 Git 仓库更干净、AI 配置更集中、多项目更容易统一组织。

<p align="center">
  <img src="./docs/assets/images/community/workspace-overview.png" alt="Workspace 目录概览" width="760" />
</p>

<p align="center">
  <img src="./docs/assets/images/community/workspace-claude-md.png" alt="Workspace 中的 CLAUDE.md" width="760" />
</p>

### 可 Pin 的标签页和分屏终端

在 CC-Panes 里，终端标签页不只是能打开和关闭，还可以固定、改名、左右移动、拆分到右侧或下方，形成相对稳定的多面板布局。这意味着你不需要再担心“手误关掉正在跑任务的会话”。

<p align="center">
  <img src="./docs/assets/images/community/pin-menu.png" alt="标签页固定与拆分菜单" width="260" />
</p>

### 统一的项目启动入口

左侧项目菜单不只是“打开目录”，还可以直接承载常用 AI CLI 的启动入口。对于前后端分离、多仓库协作、多环境切换的项目来说，这会显著减少重复操作。

<p align="center">
  <img src="./docs/assets/images/community/cli-menu.png" alt="项目启动菜单" width="280" />
</p>

### MCP：把终端与工作区能力直接交给 AI

CC-Panes 很有辨识度的一点，是把大量终端和工作区操作暴露成了 **MCP（Model Context Protocol）能力**。这意味着 AI 不只是“看终端输出”，而是可以读取会话状态、向其他会话写入命令、创建工作区、导入项目、分发任务以及操作 Todo、文件和 Pane。

<p align="center">
  <img src="./docs/assets/images/community/mcp-overview.png" alt="MCP 服务能力概览" width="980" />
</p>

当前已覆盖的能力方向包括：

- 任务管理
- PTY 会话
- 工作区管理
- Todo
- 任务绑定
- 文件操作
- Pane 管理
- 历史记录

### Plan -> Codex 的 Team 编程工作流

CC-Panes 很适合“一个模型负责规划，另一个模型负责实现”的协作模式。典型流程是：

- 先让 Claude 做 Plan
- 再通过 `launch_task` 把任务分发给 Codex
- 之后由 Claude 或其他会话继续监控与推进

这不是简单地“开两个终端”，而是在构建一种可拆分的工作流：Plan 和 Implementation 分离，可扩展为多窗口并行执行，更接近“团队编程”而不是“单会话问答”。

<p align="center">
  <img src="./docs/assets/images/community/plan-to-codex.png" alt="Plan 到 Codex 的工作流" width="760" />
</p>

### WSL 不是附加项，而是核心场景之一

很多人在 Windows 上做 AI 编程，最后都会进入 WSL 场景。CC-Panes 的做法是：为同一个工作区保留 Windows 路径，同时支持 WSL 路径映射，并在界面里直接区分本地项目和 WSL 项目。

<p align="center">
  <img src="./docs/assets/images/community/workspace-wsl.png" alt="Workspace 中的本地与 WSL 项目" width="520" />
</p>

<p align="center">
  <img src="./docs/assets/images/community/self-dialogue.png" alt="WSL 与模型状态示意" width="760" />
</p>

这让下面这种混合开发方式更容易成立：

- 在 WSL 中读写代码
- 在 Windows 环境中编译、运行或调试
- 在一个可视化工作台里统一管理全部会话

### Todo 也是工作流的一部分

Todo 面板不是简单的任务列表。它支持状态、优先级、范围过滤、右侧编辑，并与项目、标签和会话结合。配合 MCP 与计划流，它更像是 AI 编程工作流中的任务调度层。

<p align="center">
  <img src="./docs/assets/images/community/todo-board.png" alt="Todo 面板" width="980" />
</p>

## 适合谁用

- Windows 上做多项目 AI 编程的开发者
- 同时管理多个终端和 AI CLI 工具的用户
- 希望 AI 工作流可协作、可拆分、可复用的团队
- 对项目目录洁癖，不想被 AI 配置污染 Git 仓库的人

**核心亮点：** Workspace 化管理、多 CLI 统一入口、Pin + 分屏布局、MCP 跨终端协作、Plan→Codex 任务分发、完整的 Todo/Specs/Skills/Memory 工作流。

## 未来方向

- SSH 远程项目支持
- 会话恢复与持久化
- MCP 自动化增强
- Team 编程工作流完善
- 多模型统一协作体验

## 支持的 CLI 工具

仓库中的 [`cc-cli-adapters/`](./cc-cli-adapters/) 已内建统一适配层，目前代码里已确认包含：

- `Claude Code`
- `Codex CLI`
- `Gemini CLI`
- `OpenCode`

其中 Claude Code 与 Codex 当前集成深度最高。

## 文档

设计文档位于 [`docs/`](./docs/) 目录，包括：

- Workspace 与项目基础模型
- Provider 与平台适配
- 本地历史
- Skill 系统
- Memory 系统
- GUI 演进与打包发布

## 反馈

发现 Bug 或有建议？欢迎加入微信群交流：

<img src="docs/assets/images/wechat-group.png" alt="微信群: cc-pane" width="200" />

## 贡献

欢迎贡献，建议先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md) 了解项目约定。

## 许可证

本项目采用 [GNU 通用公共许可证 v3.0](./LICENSE) 开源。

## 致谢

- [Tauri](https://tauri.app/) — 桌面应用框架
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — Anthropic 的 AI 编程助手
- [xterm.js](https://xtermjs.org/) — Web 终端模拟器
- [shadcn/ui](https://ui.shadcn.com/) — UI 组件库
