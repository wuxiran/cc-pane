# CC-Panes 项目概述

> Claude Code 多实例分屏管理工具

## 项目简介

CC-Panes 是一个跨平台的 Claude Code 多实例分屏管理桌面应用，基于 Tauri 2 + Vue 3 构建，提供工作空间/项目/任务三层管理、内置终端（PTY）、本地文件历史、会话日志、Git 集成等功能。

## 技术栈

| 层次 | 技术 | 说明 |
|------|------|------|
| 桌面框架 | Tauri 2 | Rust 后端 + 系统 WebView |
| 前端框架 | Vue 3 + TypeScript | Composition API |
| UI 库 | Reka UI + Tailwind CSS 4 | 组件库 + 原子化 CSS |
| 终端模拟 | xterm.js + portable-pty | 前端渲染 + 后端伪终端 |
| 数据存储 | SQLite (rusqlite) | 本地持久化 |
| 图标 | Lucide Vue Next | SVG 图标库 |
| 分屏 | splitpanes | 可拖拽分屏组件 |
| 通知 | vue-sonner | Toast 通知 |

## 项目结构

```
cc-panes/
├── src-tauri/                  # Tauri Rust 后端
│   ├── src/
│   │   ├── main.rs             # 应用入口
│   │   ├── lib.rs              # 库入口 (命令注册)
│   │   ├── commands/           # Tauri 命令层
│   │   ├── models/             # 数据模型
│   │   ├── repository/         # 数据访问层
│   │   └── services/           # 业务逻辑层
│   ├── Cargo.toml
│   └── tauri.conf.json
│
├── src/                        # Vue 3 前端
│   ├── App.vue                 # 根组件
│   ├── main.ts                 # 入口
│   ├── components/             # 组件
│   │   ├── MenuBar.vue         # 顶部菜单栏
│   │   ├── Sidebar.vue         # 左侧工作空间/项目树
│   │   ├── JournalPanel.vue    # 会话日志面板
│   │   ├── LocalHistoryPanel.vue
│   │   ├── SessionCleanerPanel.vue
│   │   ├── WorktreeManager.vue
│   │   ├── panes/              # 分屏终端组件
│   │   └── ui/                 # 通用 UI 组件
│   ├── composables/            # 状态管理
│   ├── services/               # 前端服务层
│   └── types/                  # TypeScript 类型定义
│
├── cc-panes-tui/               # TUI 版本 (已归档)
├── _archived_v1/               # 旧版本存档
├── docs/                       # 设计文档
├── Cargo.toml                  # Workspace 配置
├── package.json
└── vite.config.ts
```

## 架构图

```
┌─────────────────────────────────────────────────────────────┐
│  Vue 3 Frontend                                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐  │
│  │ Sidebar  │ │ Panes    │ │ Panels   │ │ UI Components │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └───────────────┘  │
│       │             │            │                            │
│  ┌────┴─────────────┴────────────┴────┐                     │
│  │  Services (invoke) + Composables   │                     │
│  └────────────────┬───────────────────┘                     │
├───────────────────┼─────────────────────────────────────────┤
│  Tauri IPC        │                                          │
├───────────────────┼─────────────────────────────────────────┤
│  Rust Backend     │                                          │
│  ┌────────────────┴───────────────────┐                     │
│  │  Commands → Services → Repository  │                     │
│  └────────────────┬───────────────────┘                     │
│  ┌────────────────┴───────────────────┐                     │
│  │  SQLite / 文件系统 / PTY           │                     │
│  └────────────────────────────────────┘                     │
└─────────────────────────────────────────────────────────────┘
```

## 概念模型（三层结构）

```
工作空间 (Workspace)                  # 多项目集合
├── 工作空间配置 / 别名               # 默认 provider、布局偏好等
├── 会话日志 (Journal)                # 工作空间级会话记录
└── 项目列表
    ├── 项目: frontend                # 前端 Git 仓库
    │   ├── 项目配置 / 别名
    │   ├── Local History             # 文件版本历史
    │   └── 任务列表
    │       ├── 任务: "组件开发"
    │       └── 任务: "样式调整"
    ├── 项目: backend
    │   └── ...
    └── 项目: shared-libs
        └── ...

层级关系：Workspace → Project → Task
共享规则：
- 同一项目下的任务共享 Local History、项目配置、Git 信息
- 工作空间级别设置默认配置，项目级可覆盖
- 会话日志按工作空间存储
```

## 实施阶段

| 阶段 | 名称 | 说明 | 状态 |
|------|------|------|------|
| 01 | [项目基础](./01-project-foundation.md) | 项目搭建、数据模型、工作空间/项目管理 | ✅ 已完成 |
| 02 | [跨平台兼容](./02-platform-adapter.md) | macOS 兼容性适配 | 📋 待实现 |
| 03 | [TUI 界面](./03-tui-interface.md) | TUI 命令行版本 | 🗄️ 已归档 |
| 04 | [Provider 管理](./04-feature-enhancement.md) | 工作空间级 Provider 切换 | 📋 待实现 |
| 05 | [Local History](./05-local-history.md) | 文件版本历史管理 | 🔨 部分完成 |
| 06 | [Skill 系统](./06-skill-system.md) | 应用内执行 Claude 任务 | 📋 待设计 |
| 07 | [通知中心](./07-alert-system.md) | 集中通知转发（微信/邮件） | 📋 待实现 |
| 08 | [文件浏览](./08-document-management.md) | 工作空间文件浏览 + Markdown 预览 | 📋 待实现 |
| 09 | [远程访问](./09-remote-access.md) | 移动端远程连接 | 📋 待设计 |
| 10 | [测试](./10-testing-release.md) | 单元测试、集成测试、CI/CD | 📋 待实现 |
| 11 | [GUI 基础](./11-tauri-gui-basic.md) | Tauri GUI 框架搭建 | ✅ 已完成 |
| 12 | [GUI 高级](./12-gui-advanced.md) | 高级 GUI 功能 | 🔨 部分完成 |
| 13 | [打包发布](./13-packaging.md) | 跨平台打包、自动更新 | 📋 待实现 |

## 已实现的核心功能

- [x] 工作空间/项目管理（创建、删除、别名）
- [x] 内置终端（PTY + xterm.js 分屏）
- [x] Git 集成（分支、状态、pull/push/fetch/stash）
- [x] Git Worktree 管理
- [x] Claude 会话管理与清理
- [x] 启动历史记录
- [x] Hooks/工作流系统
- [x] 会话日志（工作空间级）
- [x] Local History API（文件版本管理）
- [x] 主题切换（亮色/暗色）
- [x] 无边框模式
- [x] 侧边栏右键菜单
- [x] SQLite 数据持久化

## 存储结构

```
~/.cc-panes/                         # 全局配置目录
├── config.toml                      # 全局配置
├── workspaces/                      # 工作空间目录
│   └── <workspace-name>/
│       ├── workspace.json           # 工作空间配置
│       └── .ccpanes/
│           └── journal/             # 会话日志
└── data/
    └── cc-panes.db                  # SQLite 数据库

<project-path>/.ccpanes/             # 项目级配置
├── config.toml
├── history/                         # 本地文件历史
└── hooks/                           # 工作流定义
```

## 开发命令

```bash
# 安装依赖
npm install

# 开发模式
npm run tauri dev

# 前端类型检查
npx vue-tsc --noEmit

# Rust 检查
cargo check

# 构建应用
npm run tauri build
```
