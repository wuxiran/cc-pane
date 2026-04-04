# 阶段 11：Tauri GUI 基础（已完成）

## 目标

搭建 Tauri 2 + Vue 3 桌面应用框架，实现核心界面和基础功能。

## 状态

✅ 已完成

## 任务清单

- [x] 初始化 Tauri 2 + Vue 3 + TypeScript 项目
- [x] 配置 Vite + Tailwind CSS 4
- [x] 集成 Reka UI 组件库
- [x] 实现 Tauri 命令层 (commands/)
- [x] 实现前端服务层 (services/)
- [x] 实现 Composables 状态管理
- [x] 实现 MenuBar 菜单栏
- [x] 实现 Sidebar 侧边栏（工作空间树、项目列表、右键菜单）
- [x] 实现 Pane 分屏系统（PaneContainer + SplitContainer + Panel）
- [x] 实现 TerminalView 终端视图 (xterm.js)
- [x] 实现 TabBar 标签栏
- [x] 实现 Dialog / ContextMenu / DropdownMenu 等 UI 组件
- [x] 实现主题切换 (useTheme)
- [x] 实现无边框模式 (useBorderless)
- [x] 实现全屏模式 (useFullscreen)

## 最终架构概览

### 后端（src-tauri/src/）

```
src-tauri/src/
├── main.rs                 # Tauri 入口
├── lib.rs                  # 库入口，注册命令和插件
├── commands/               # Tauri 命令（前端调用入口）
│   ├── workspace_commands.rs
│   ├── project_commands.rs
│   ├── pty_commands.rs
│   └── ...
├── services/               # 业务逻辑层
│   ├── workspace_service.rs
│   ├── project_service.rs
│   ├── pty_service.rs
│   └── ...
├── models/                 # 数据模型
└── db/                     # SQLite 数据库操作
```

### 前端（src/）

```
src/
├── App.vue                 # 根组件
├── main.ts                 # 入口
├── assets/                 # 静态资源、CSS
├── components/             # UI 组件
│   ├── layout/             # MenuBar, Sidebar, TabBar, PaneContainer...
│   ├── ui/                 # Dialog, ContextMenu, DropdownMenu...
│   ├── terminal/           # TerminalView (xterm.js)
│   └── panels/             # 各功能面板
├── composables/            # 状态管理 (useWorkspace, useTheme, usePanes...)
├── services/               # Tauri invoke 封装
└── types/                  # TypeScript 类型定义
```

## 关键技术决策

| 决策 | 选择 | 原因 |
|------|------|------|
| 分屏方案 | splitpanes 库 | 成熟稳定，拖拽调整大小体验好 |
| UI 组件库 | Reka UI | 比 shadcn-vue 更轻量，无样式绑定 |
| 状态管理 | Composables | 比 Pinia store 更灵活，适合 Tauri 场景 |
| 终端方案 | 内置 PTY (portable-pty + xterm.js) | 跨平台一致体验，无需依赖外部终端 |
| 样式方案 | Tailwind CSS 4 | 原子化 CSS，开发效率高 |
| 数据库 | SQLite | 轻量嵌入式，适合桌面应用 |

## 下一步

完成阶段 11 后，进入 [阶段 12：GUI 高级功能](./12-gui-advanced.md)。
