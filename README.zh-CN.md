# CC-Panes

> [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 多实例分屏管理器 — 基于 Tauri 2 的跨平台桌面应用。

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)
[![Built with Tauri](https://img.shields.io/badge/Built%20with-Tauri%202-FFC131?logo=tauri)](https://v2.tauri.app/)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript)](https://www.typescriptlang.org/)

[English](README.md)

<p align="center">
  <img src="images/screenshot-main.png" alt="CC-Panes 主界面" width="800" />
</p>

## 什么是 CC-Panes？

CC-Panes 让你在分屏终端布局中**并排运行多个 Claude Code CLI 实例**。通过工作空间、项目和任务来组织你的 AI 驱动开发工作流 — 一切尽在一个桌面应用中。

## 功能特性

- **分屏终端** — 在灵活的水平/垂直分屏布局中运行多个终端，支持拖拽调整大小
- **工作空间管理** — 将项目组织到工作空间中，支持置顶、隐藏和重新排序
- **内置终端** — 全功能终端（xterm.js + PTY），支持多标签页
- **Claude Code 集成** — 启动 Claude Code 会话、恢复对话、管理 Provider、自我对话模式
- **Git 集成** — 分支状态、pull/push/fetch/stash、Worktree 管理和 git clone
- **会话管理** — 追踪启动历史，最近启动面板、清理异常会话、恢复之前的工作
- **本地历史** — 文件版本追踪，支持 diff 查看、标签、分支感知快照和还原
- **文件浏览器** — 项目文件树浏览，支持搜索、创建、重命名、删除、复制和移动操作
- **代码编辑器** — 基于 Monaco 的编辑器，支持 60+ 语言语法高亮、Markdown 预览和图片预览
- **快速搜索** — 全局文件搜索（Ctrl+K），跨工作空间所有项目搜索
- **截图** — 区域截图，支持全局快捷键、多显示器和剪贴板复制
- **会话日志** — 工作空间级别的会话日志记录
- **待办 & 计划** — 任务管理，支持优先级、子任务和计划归档
- **Memory & Skills** — 按项目管理 Claude 记忆和自定义技能
- **MCP 服务器配置** — 按项目配置 MCP 服务器
- **Hooks/工作流** — 工作空间级别的 Hook 自动化系统
- **Provider 管理** — 多 API Provider 支持（Anthropic、Bedrock、Vertex、代理、配置档案）
- **目录扫描导入** — 从目录批量导入 Git 仓库
- **主题支持** — 亮色/暗色模式，毛玻璃设计
- **无边框、迷你 & 全屏模式** — 无边框窗口模式、紧凑迷你视图和 F11 全屏切换
- **系统托盘** — 最小化到托盘，带状态监控
- **桌面通知** — 会话退出、等待输入和待办提醒通知，支持防抖
- **键盘快捷键** — 所有主要操作支持自定义快捷键
- **国际化** — 中英文界面

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
git clone https://github.com/wuxiran/cc-panes.git
cd cc-panes

# 安装前端依赖
npm install

# 以开发模式运行（前端 + Rust 后端）
npm run tauri:dev
```

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
├── src/                    # React 前端
│   ├── components/         # React 组件
│   │   ├── panes/          # 分屏终端组件
│   │   ├── sidebar/        # 侧边栏组件
│   │   ├── settings/       # 设置子组件
│   │   ├── memory/         # Memory 管理
│   │   ├── skill/          # Skill 管理
│   │   ├── todo/           # 待办管理
│   │   └── ui/             # shadcn/ui 基础组件
│   ├── stores/             # Zustand 状态管理
│   ├── services/           # 前端服务层（invoke 封装）
│   ├── hooks/              # 自定义 React Hooks
│   ├── types/              # TypeScript 类型定义
│   ├── i18n/               # 国际化
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
└── images/                 # 截图
```

## 截图

<details>
<summary>更多截图</summary>

| 分屏布局 | 面板视图 |
|:-:|:-:|
| ![分屏](images/screenshot-no-layout.png) | ![面板](images/screenshot-panel.png) |

| 待办列表 | 新 UI |
|:-:|:-:|
| ![待办](images/screenshot-todolist.png) | ![新 UI](images/screenshot-new-ui.png) |

</details>

## 贡献

欢迎贡献！请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 了解贡献指南。

## 许可证

本项目采用 [GNU 通用公共许可证 v3.0](LICENSE) 授权。

## 致谢

- [Tauri](https://tauri.app/) — 桌面应用框架
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — Anthropic 的 AI 编程助手
- [xterm.js](https://xtermjs.org/) — Web 终端模拟器
- [shadcn/ui](https://ui.shadcn.com/) — UI 组件库
