# 阶段 1：项目基础（已完成）

> 状态：✅ 已完成

## 目标

搭建 Tauri 2 + Vue 3 项目框架，实现工作空间和项目管理、内置终端、Git 集成等核心功能。

## 任务清单

- [x] 初始化 Tauri 2 + Vue 3 + TypeScript 项目
- [x] 配置 Vite + Tailwind CSS 4
- [x] 定义数据模型 (Project, Workspace, Terminal)
- [x] 实现 SQLite 数据层 (repository/)
- [x] 实现工作空间管理 (WorkspaceService)
- [x] 实现项目管理 (ProjectService)
- [x] 实现内置终端 (PTY + xterm.js)
- [x] 实现 Git 集成 (分支/状态/pull/push)
- [x] 实现启动历史记录
- [x] 实现会话日志 (Journal)
- [x] 实现 Hooks/工作流系统
- [x] 实现 Worktree 管理
- [x] 实现侧边栏工作空间树 (Sidebar.vue)
- [x] 实现分屏终端布局 (splitpanes + PaneContainer)
- [x] 实现主题切换和无边框模式

## 项目结构

```
cc-panes/
├── src-tauri/                    # Tauri 后端 (Rust)
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs               # 入口
│       ├── lib.rs                # 库导出
│       ├── commands/             # Tauri 命令（前端调用）
│       ├── models/               # 数据模型 (Project, Workspace, Terminal 等)
│       ├── repository/           # SQLite 数据层 (rusqlite)
│       ├── services/             # 业务逻辑层
│       ├── pty/                  # PTY 终端管理 (portable-pty)
│       └── git/                  # Git 集成
│
├── src/                          # 前端 (Vue 3 + TypeScript)
│   ├── App.vue
│   ├── main.ts
│   ├── components/               # Vue 组件 (Reka UI)
│   ├── composables/              # 组合式函数
│   ├── stores/                   # Pinia 状态管理
│   ├── lib/                      # 工具库
│   └── assets/                   # 静态资源
│
├── package.json
├── vite.config.ts
└── tsconfig.json
```

## 关键依赖

**后端 (Rust):**
- `tauri 2.x` - 桌面应用框架
- `portable-pty` - 跨平台伪终端
- `rusqlite` - SQLite 数据库
- `git2` / Git CLI - Git 操作

**前端 (TypeScript):**
- `Vue 3` + `TypeScript` - 界面开发
- `xterm.js` - 终端渲染
- `splitpanes` - 分屏布局
- `Reka UI` - UI 组件库
- `Pinia` - 状态管理
- `Tailwind CSS 4` - 样式

## 下一步

进入 [阶段 2：跨平台兼容](./02-platform-adapter.md)
