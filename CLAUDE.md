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
├── cc-panes-mobile/               # Flutter 移动客户端（连接 cc-panes-web 的远程终端）
│   ├── lib/
│   │   ├── core/                  # Result<T,ApiFailure>、常量
│   │   ├── api/                   # dio+cookie jar、auth/sessions API、WS 封装
│   │   ├── models/                # ServerProfile / AuthStatus / SessionInfo
│   │   ├── state/                 # riverpod providers
│   │   └── ui/                    # screens + widgets
│   └── test/                      # 镜像 lib 结构
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

# 移动端（cc-panes-mobile/ 目录内）
flutter pub get && flutter analyze && flutter test
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
- [x] Git 提交时间线 + 提交/工作区 Diff 视图（NUL 协议解析、双端 parity）
- [x] 项目身份统一（Windows//mnt//WSL UNC 跨形式等价 + 迁移去重）
- [x] Local History watcher 惰性化（跟随活跃终端会话,45s 宽限,全局开关）

## Known Gotchas

- **终端回车必须发 CR（`\r`）不是 LF**：Windows PowerShell 只认 CR。`write_to_session` 的提交路径已按此实现（`terminal_service.rs` 的 `write_unlocked(.., "\r")`），修改时勿回退成 `\n`。
- **portable-pty 的 `kill()` 只杀直接子进程**：CC-Panes 显式关闭走 `taskkill /T /F`（`cc-panes-core/src/pty/mod.rs::kill_process_by_pid`）能杀整棵树，但宿主崩溃时靠 `pty/job.rs` 的 Job Object（`KILL_ON_JOB_CLOSE`）由内核清树——**没有替代方案前不要移除 Job**。
- **React 19 严格模式 dev 下 useEffect 双挂载**：终端组件可能触发两次 spawn/清理，dev 日志里"创建即销毁"的 PTY 是正常现象，新终端类组件需容忍双挂载。
- **会话状态只信 OSC/hook，不信输出文本**：状态跃迁来自 hook HTTP 通道与 OSC in-band 通道（`osc_state_detect.rs`，跨通道去重见 `session_state_machine.rs`）。不要往 `infer_status` 加文本模式匹配——TUI spinner 每帧重绘、随版本变化，文本猜测必然抖动。
- **OSC 7 上报的 cwd 是正斜杠 URL 形式**（`file://host/C:/...`）：Windows 下消费方传给 fs 命令前必须剥前缀并规范化分隔符。
- **不要在 tauri.conf.json 预创建隐藏 WebView 窗口**：长期隐藏的 WebView2 会被系统置为失效状态（0x8007139F），之后每条 `app.emit` 广播都失败并刷一条 wry ERROR；日志的 Webview target 还会把错误 emit 回失效 WebView，形成自放大洪水（实测 13 条/秒、烧满 CPU、前端假死）。ccchan 窗口已改为启用时按需创建（`ccchan_service.rs::ccchan_window` get-or-create），新增辅助窗口也必须按需创建；`lib.rs` 中对 `tauri_runtime_wry` 有日志限流兜底（`wry_log_allowed`）。
- **根目录新增大目录必须同步 `vite.config.ts` 的 `server.watch.ignored`**：`.cargo/config.toml` 把 Rust 的 `target-dir` 指到了仓库根，实测 `target/` 达 22 万文件；chokidar 默认只跳过 `node_modules`/`.git`，漏掉的大目录会被递归监听，叠加 `tauri dev` 期间 cargo 持续写入形成事件风暴——实测 Vite 进程烧到 2.9GB 内存、2091 秒 CPU 后彻底停止响应，窗口永久停在 `Loading CC-Panes...`（看着像卡死，其实是 dev server 不返回任何模块）。判断方法：`curl 127.0.0.1:14200` 超时但端口在 Listen。
- **`cargo` 的 `incremental/` 不会自动回收**：按构建会话堆积，本仓库实测积到 1164 个目录、176GB（其中超 7 天的占 155GB）。定期删除旧目录即可，增量缓存对 cargo 是可丢弃数据，缺了只是那次非增量重编。
- **不要给全部注册项目起常驻监视/轮询**：0.10.20 曾给 129 个注册项目各起一个 2 秒轮询线程,28.6 核持续忙碌(docs/41)。watcher/扫描类资源必须跟随**活跃会话**惰性起停（`HistoryWatchManager`）,且剪枝规则要支持嵌套目录（根锚定的 `node_modules/**` 剪不到 monorepo 嵌套依赖）。
- **portable-pty 对无效 cwd 会静默回退 HOME 而不是报错**（Unix 回退 `$HOME`,Windows 回退 `USERPROFILE`,见 docs/46 黑屏调查）：应用层必须在 `spawn_pty` 前校验 cwd 存在且为目录,否则会话"成功"启动在错误目录,agent 在错误的仓库里干活。
- **Claude Code 的 SessionEnd hook 带 reason,`clear` 不是进程退出**：`/clear` 会触发 SessionEnd(reason="clear"),hook 层必须按 reason 过滤（HTTP 与 OSC 双通道）,否则活会话被状态机标 Exited、daemon 桥发合成 `terminal-exit(-1)` 并停流（docs/44）。看到 `-1` 退出码 = 合成码,非真实进程退出。
- **Codex 的 resume id 依赖 OSC 标题捕获,Codex CLI 升版会静默打断**：v0.145 曾令捕获链全灭（launch_history 的 codex `resumeSessionId` 全 null,docs/45）,resume 静默变新会话。捕获链修改需配 rollout 目录扫描兜底,且降级必须对用户可见。
- **Zustand selector 里不要调用返回新集合的 store 方法**：`usePanesStore((s) => s.listLayouts())` 这类写法，因 `listLayouts` 内部是 `filter().map()` 每次返回新数组，`useSyncExternalStore` 的快照永不相等 → `Maximum update depth exceeded` 崩页。正确做法是选稳定引用（如 `s.layouts`）后用 `useMemo` 本地派生；`.getState().listLayouts()` 在渲染外调用则不受影响。

## 文档引用

> 面向**使用者**的操作手册（怎么用）见 [`docs/guide/`](docs/guide/README.md)。下表是面向**开发者**的设计文档（怎么设计 / 实现）。

详细设计文档位于 `docs/` 目录：

| 文档 | 内容 |
|------|------|
| `docs/00-overview.md` | 项目总览、概念模型、实施阶段 |
| `docs/01-project-foundation.md` | 阶段 1：项目基础（✅ 完成） |
| `docs/05-local-history.md` | Local History 设计 |
| `docs/11-tauri-gui-basic.md` | GUI 基础（✅ 完成） |
| `docs/12-gui-advanced.md` | GUI 高级功能 |
| `docs/22-frontend-design-refactor.md` | 前端设计重构：分区/色彩 token 映射/拆分索引/UX 约定 |
| `docs/46-frontend-styleguide.md` | **前端风格宪法**：原语选择/in-flight 分级/状态色映射/琥珀约定/UX 评审 rubric——所有 UI 改动提交前对照 |
| `docs/41-wallpaper-perf-investigation.md` | 0.10.20 卡顿事故复盘（轮询扫描器根因 + 项目身份统一记录） |
| `docs/44-clear-sessionend-exit-bug.md` | `/clear` 误判会话退出：SessionEnd reason 语义与修复 |
| `docs/45-codex-resume-capture-dead.md` | Codex resume 捕获链失效调查与修复规格 |
| `docs/46-cross-platform-launch-blackscreen.md` | 跨平台启动黑屏 + portable-pty HOME 回退暗雷（与 46 风格宪法同号不同文件） |
| `docs/references.md` | 外部参考项目索引 |
| `docs/archive-v1.md` | 旧版本归档说明 |
