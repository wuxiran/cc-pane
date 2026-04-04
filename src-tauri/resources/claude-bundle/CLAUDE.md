# CC-Panes

> Claude Code 多实例分屏管理桌面应用

## 项目概述

CC-Panes 是一个基于 Tauri 2 的跨平台桌面应用，用于管理多个 Claude Code 实例的分屏布局。采用 **三层模型**：Workspace → Project → Task。

- **Workspace**: 多项目集合，包含工作空间级配置、会话日志、Provider 设置
- **Project**: 对应一个 Git 仓库，包含 Local History、项目配置
- **Task**: 项目下的具体任务，对应一个终端标签页

## 技术栈

| 层次 | 技术 | 说明 |
|------|------|------|
| 桌面框架 | Tauri 2 | Rust 后端 + 系统 WebView |
| 前端框架 | React 19 + TypeScript | 函数组件 + Hooks |
| 状态管理 | Zustand 5 + Immer | 不可变更新 |
| UI 库 | shadcn/ui + Radix UI | 组件库 |
| 样式 | Tailwind CSS 4 | 原子化 CSS |
| 终端 | xterm.js + portable-pty | 前端渲染 + 后端 PTY |
| 分屏 | Allotment | 可拖拽分屏布局 |
| 数据存储 | SQLite (rusqlite) | 本地持久化 |
| 图标 | Lucide React | SVG 图标 |
| 构建 | Vite 6 | 前端构建 |

## 架构与数据流

```
React Component → Zustand Store → Service (invoke) → Tauri IPC → Command → Service → Repository → SQLite/FS
```

```
┌─────────────────────────────────────────────────────────────┐
│  React Frontend                                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐  │
│  │ Sidebar  │ │ Panes    │ │ Panels   │ │ UI Components │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └───────────────┘  │
│       │             │            │                           │
│  ┌────┴─────────────┴────────────┴────┐                     │
│  │  Services (invoke) + Stores        │                     │
│  └────────────────┬───────────────────┘                     │
├───────────────────┼─────────────────────────────────────────┤
│  Tauri IPC        │                                         │
├───────────────────┼─────────────────────────────────────────┤
│  Rust Backend     │                                         │
│  ┌────────────────┴───────────────────┐                     │
│  │  Commands → Services → Repository  │                     │
│  └────────────────┬───────────────────┘                     │
│  ┌────────────────┴───────────────────┐                     │
│  │  SQLite / 文件系统 / PTY           │                     │
│  └────────────────────────────────────┘                     │
└─────────────────────────────────────────────────────────────┘
```

## 编码规范

### TypeScript (前端)

- **函数组件 + Hooks**，不使用 class 组件
- **Zustand + Immer** 进行不可变状态更新（`set((state) => { state.x = y })` 风格）
- **Service 层** 封装所有 `invoke()` 调用，组件不直接调用 Tauri API
- **路径别名** `@/` 映射到 `web/`
- **co-located 测试**：测试文件与实现文件同目录（`*.test.ts`）

### Rust (后端)

- **`AppResult<T>`** 统一错误处理（`Result<T, AppError>`）
- **State 注入服务**：命令通过 `State<'_, Arc<XxxService>>` 获取服务
- **分层架构**：Command → Service → Repository，职责分明
- **内存 SQLite** 用于测试（`:memory:`）

### 通用

- 小文件（<800 行）、小函数（<50 行）
- 不可变数据优先
- 错误显式处理，不 swallow
- 输入验证在系统边界

## 项目结构

```
cc-panes/
├── web/                           # React 前端
│   ├── main.tsx                   # 应用入口
│   ├── App.tsx                    # 根组件
│   ├── components/                # React 组件
│   │   ├── panes/                 # 分屏终端组件
│   │   ├── sidebar/               # 侧边栏组件
│   │   ├── settings/              # 设置子组件
│   │   └── ui/                    # shadcn/ui 基础组件
│   ├── stores/                    # Zustand 状态管理
│   ├── services/                  # 前端服务层（invoke 封装）
│   ├── hooks/                     # 自定义 Hooks
│   ├── types/                     # TypeScript 类型定义
│   ├── lib/                       # 工具库
│   └── utils/                     # 工具函数
│
├── cc-panes-core/                 # 领域核心（零框架依赖）
│   └── src/
│       ├── lib.rs
│       ├── events.rs              # EventEmitter trait
│       ├── models/                # 数据模型
│       ├── repository/            # 数据访问层
│       ├── services/              # 业务逻辑
│       ├── pty/                   # PTY 抽象
│       └── utils/                 # AppPaths, AppError
│
├── cc-panes-api/                  # HTTP API 适配器
│   └── src/
│       ├── lib.rs
│       ├── routes/                # REST 路由
│       ├── ws/                    # WebSocket
│       └── error.rs               # HTTP 错误转换
│
├── src-tauri/                     # Tauri Rust 后端（薄包装层）
│   └── src/
│       ├── main.rs                # 应用入口
│       ├── lib.rs                 # 命令注册入口
│       ├── commands/              # Tauri IPC 命令层
│       ├── services/              # 业务逻辑层
│       ├── repository/            # 数据访问层 (SQLite)
│       ├── models/                # 数据模型
│       └── utils/                 # 工具（AppPaths, AppError）
│
├── docs/                          # 正式设计文档、样例与文档资源
├── .claude/                       # 项目内命令、agents 与 hooks 源目录
└── .cargo/config.toml             # Rust 构建输出配置（target-dir）
```

## 关键文件

### 前端

| 文件 | 说明 |
|------|------|
| `web/App.tsx` | React 根组件，布局 + Dialog 挂载 |
| `web/stores/usePanesStore.ts` | 分屏状态管理（Zustand + Immer 范例） |
| `web/stores/useProjectsStore.ts` | 项目状态管理 |
| `web/stores/useWorkspacesStore.ts` | 工作空间状态管理 |
| `web/services/workspaceService.ts` | 工作空间服务（invoke 封装范例） |
| `web/services/projectService.ts` | 项目服务 |
| `web/services/terminalService.ts` | 终端服务 |
| `web/types/index.ts` | 类型定义汇总导出 |
| `web/components/panes/TerminalView.tsx` | 终端视图（xterm.js） |
| `web/components/Sidebar.tsx` | 左侧工作空间树 |

### 后端

| 文件 | 说明 |
|------|------|
| `src-tauri/src/lib.rs` | 命令注册 + 服务初始化入口 |
| `src-tauri/src/commands/workspace_commands.rs` | 工作空间命令（Tauri Command 范例） |
| `src-tauri/src/commands/project_commands.rs` | 项目命令 |
| `src-tauri/src/commands/terminal_commands.rs` | 终端命令 |
| `src-tauri/src/services/project_service.rs` | 项目业务逻辑 |
| `src-tauri/src/services/terminal_service.rs` | 终端服务（PTY 管理） |
| `src-tauri/src/repository/db.rs` | 数据库初始化 + 表结构 |
| `src-tauri/src/repository/project_repo.rs` | 项目 CRUD（Repository 范例） |
| `src-tauri/src/models/project.rs` | Project 数据模型 |
| `src-tauri/src/utils/error.rs` | `AppError` + `AppResult<T>` |
| `src-tauri/src/utils/app_paths.rs` | 应用路径管理 + `APP_DIR_NAME` 常量 |
| `src-tauri/tauri.dev.conf.json` | Dev 覆盖配置（identifier + 窗口标题） |

## 开发命令

```bash
# 安装前端依赖
npm install

# 开发模式（使用 dev identifier，与 release 版隔离）
npm run tauri:dev

# 开发模式（原始，不隔离）
npm run tauri dev

# 前端类型检查
npx tsc --noEmit

# 前端构建
npm run build

# Rust 检查
cargo check --workspace

# Rust lint
cargo clippy --workspace -- -D warnings

# Rust 格式化检查
cargo fmt --all -- --check

# 运行前端测试
npm run test:run

# 运行后端测试
cargo test --workspace

# 构建 release 安装包
npm run tauri build
```

## Dev/Release 隔离

`tauri dev`（debug build）和 `tauri build`（release build）通过 `cfg!(debug_assertions)` 实现完全隔离，可同时运行互不冲突。

| 项目 | Dev (`tauri:dev`) | Release (`tauri build`) |
|------|-------------------|------------------------|
| 数据目录 | `~/.cc-panes-dev/` | `~/.cc-panes/` |
| App identifier | `com.ccpanes.dev` | `com.ccpanes.app` |
| 窗口标题 | CC-Panes [DEV] | CC-Panes |
| 托盘 tooltip | CC-Panes [DEV] | CC-Panes |
| 截图快捷键默认值 | `Ctrl+Alt+Shift+S` | `Ctrl+Shift+S` |
| 截图窗口类名 | `CCPanesDevScreenshotOverlay` | `CCPanesScreenshotOverlay` |

核心常量定义在 `src-tauri/src/utils/app_paths.rs` 的 `APP_DIR_NAME`。

`tauri:dev` 脚本通过 `--config src-tauri/tauri.dev.conf.json` 覆盖 identifier 和窗口标题。

## 新功能开发流程（7 步）

1. **Model**: 在 `src-tauri/src/models/` 定义 Rust 数据模型，在 `web/types/` 定义 TS 类型
2. **Repository**: 在 `src-tauri/src/repository/` 实现数据访问
3. **Service (Rust)**: 在 `src-tauri/src/services/` 实现业务逻辑
4. **Command**: 在 `src-tauri/src/commands/` 注册 Tauri 命令，在 `lib.rs` 添加到 `invoke_handler`
5. **Service (TS)**: 在 `web/services/` 封装 `invoke()` 调用
6. **Store**: 在 `web/stores/` 创建或更新 Zustand store
7. **Component**: 在 `web/components/` 实现 UI 组件

## 存储结构

```
~/.cc-panes/                         # Release 全局配置目录
~/.cc-panes-dev/                     # Dev 全局配置目录（结构相同）
├── config.toml                      # 全局配置
├── workspaces/                      # 工作空间目录
│   └── <workspace-name>/
│       ├── workspace.json           # 工作空间配置
│       └── .ccpanes/
│           └── journal/             # 会话日志
├── providers/                       # Provider 配置
│   └── providers.json
├── screenshots/                     # 截图存储
└── data.db                          # SQLite 数据库

<project-path>/.ccpanes/             # 项目级配置
├── config.toml
├── history/                         # 本地文件历史
└── hooks/                           # 工作流定义
```

## 已实现功能

- [x] 工作空间/项目管理（CRUD、别名、Provider 绑定）
- [x] 内置终端（PTY + xterm.js 多标签分屏）
- [x] Git 集成（分支、状态、pull/push/fetch/stash）
- [x] Git Worktree 管理
- [x] Claude 会话管理与清理
- [x] 启动历史记录
- [x] Hooks/工作流系统
- [x] 会话日志（工作空间级）
- [x] Local History（文件版本管理 + Diff + 标签 + 分支感知）
- [x] 主题切换（亮色/暗色）
- [x] 无边框模式 + 迷你模式
- [x] 系统托盘
- [x] Settings 面板（通用、终端、快捷键、代理、Provider、关于）
- [x] SQLite 数据持久化
- [x] Provider 管理（多 API Provider 支持）
- [x] 目录扫描导入
- [x] Dev/Release 隔离（并行运行互不冲突）

## 文档引用

详细设计文档位于 `docs/` 目录：

| 文档 | 内容 |
|------|------|
| `docs/00-overview.md` | 项目总览、概念模型、实施阶段 |
| `docs/01-project-foundation.md` | 阶段 1：项目基础（✅ 完成） |
| `docs/05-local-history.md` | Local History 设计 |
| `docs/11-tauri-gui-basic.md` | GUI 基础（✅ 完成） |
| `docs/12-gui-advanced.md` | GUI 高级功能 |
