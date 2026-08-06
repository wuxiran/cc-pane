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
├── cc-panes-ctl/                  # 控制面 CLI（人/AI 的兜底通道 + stdio MCP 代理）
│   └── src/
│       ├── discovery.rs           # 双源端点发现（orchestrator/daemon）+ 身份分级核对
│       ├── mcp.rs                 # MCP HTTP 客户端（tools/list、tools/call）
│       ├── commands.rs            # status/sessions/bindings/launch/tools/call
│       ├── offline_db.rs          # bindings 离线写逃生阀（schema+CAS+回读）
│       └── proxy.rs               # mcp-proxy：可恢复 stdio↔HTTP 代理
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
| `cc-panes-ctl/src/discovery.rs` | 双源端点发现 + 身份分级核对（ctl 与 mcp-proxy 共用） |
| `cc-panes-ctl/src/proxy.rs` | mcp-proxy：可恢复 stdio↔HTTP MCP 代理（根治 MCP 孤儿） |
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

# 构建控制面 CLI（改动后需拷到 <target-dir>/debug/binaries/）
cargo build -p cc-panes-ctl

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
- **`tauri dev` 不重建 external binaries（daemon/web/cli-hook）**：`build.rs` 只放占位符，`debug\binaries\` 里的 daemon 是手动构建的拷贝。改 `cc-cli-adapters`/`cc-panes-daemon` 后主程序会热重编，但**会话启动走的 daemon 还是旧二进制**——新代码"测试全绿却不生效"（0.11.1 opencode 透明修复曾因此白测三轮：binaries 里躺着 14 天前的 daemon）。修改后必须 `cargo build -p cc-panes-daemon` 并拷贝到 `<target-dir>\debug\binaries\`，再重启 dev。
- **PTY 迁到 daemon 后，任何"从 app 进程内 TerminalService 取数据"的链路都会静默失效**：daemon 模式下 `TerminalService.sessions` 在 app 侧恒为空，emit 也只进 daemon 的 `WsEmitter`。已因此断掉两条：①`terminal-resume-id-detected`（claude 发号 / codex OSC 捕获）落进 `ws_emitter.rs` 的 `_ => {}`，`launch_history.resume_session_id` 从此全 null，恢复出来的会话没有历史对话；②app 退出时 `get_all_session_outputs()` 读空，`sessions/*.output` 停产，会话真死后重放全空白。两处都表现为"功能还在、就是没数据"，没有任何报错。新增跨进程数据链路时先问：daemon 模式下这份数据在谁的地址空间里？桥接口径：会话镜像走 per-session WS，低频身份/生命周期事件走 `/ws/control`（`terminal_daemon_control_link.rs`）。
- **各 worktree 的 `.cargo/config.toml` 用相对 `target-dir = "../cc-book-target"`，所有 worktree 共享同一个 target 目录**：另一个 worktree 构建的 `cc-panes-core`/`cc-cli-adapters` 会被本 worktree 复用，报出**本地源码里根本不存在的**编译错误（实测：`missing field expected_saved_session_id`，而该字段只存在于 `cc-book-wt-restore-release`）。判定：报错提到的标识符 `grep` 不到就是命中。解法是 `touch` 相关 crate 的源文件强制重编，别去改代码迎合幻影错误。**同一个 target 目录还有第二种踩法：并发跑两个 cargo**（哪怕在同一个 worktree 里），同样会报出与实际源码对不上的编译错误——区别在于报错标识符**能**在本地 grep 到，串行重跑即消失。两种都别去改代码。
- **判断分支能否删除不能用 `git branch -d`，本仓库是 squash-merge 工作流**：内容已进 main 的分支，提交对象仍不是 main 的祖先，`-d` 照样报 `not fully merged`。要用 `git cherry origin/main <branch>` 按**内容**比。但 `git cherry` 也只看提交、看不出「能力已被 main 上更好的实现取代」——实测 `pr-22` 被标 `+`，而 main 上那个能力的起点就是这个 PR，之后又迭代了 4 次，合并它等于回退。完整判据（三层）与四条老分支的判定结论见 docs/72。
- **agent 可能整场都在驱动另一个实例（dev/release 串台），且完全无法自察**：`healthy_orchestrator_info()` 为 `None` 时（本实例 orchestrator 挂了），`CC_PANES_API_PORT/TOKEN/BASE_URL` 一个都不注入（`terminal_service.rs:1606-1620`），也不生成 `mcp-<sessionId>.json`，CLI 于是**静默回退**到 `~/.claude.json` 的 project 级单例——那份可能是另一个实例最后写的。表现：MCP 工具全部正常返回（只是另一个实例的数据）、派出去的 worker 在别的实例里、它的 `report_to_leader` 被丢弃（对侧日志 `leader session not found`）。自查方法：`$CC_PANES_LAUNCH_ID` 必须等于所连 MCP URL 里的 `launchId`，不等即串台。详见工作空间文档 `cc-book-workspace/docs/62-agent-instance-identity.md`（不在本仓库）。
- **WSL 里启动的 CLI 必须是原生 Linux 版，否则报错会伪装成我们的路径 bug**：PATH interop 会让 `claude` 静默解析到 Windows 那份 `claude.exe`，它收到 `/mnt/c/...` 参数后按 Windows 语义当成**盘符相对路径**，拼成 `D:\mnt\c\Users\...`，最终报 `MCP config file not found: D:\mnt\c\Users\<user>\.cc-panes\wsl-claude-mcp-<sessionId>.json`。**报错里既不提 Windows 也不提 WSL**，看着完全像 CC-Panes 的 WSL 路径转换写错了（0.11.4 期实测据此误判过一次，派出去的 plan 整节都在让 worker 找不存在的转换 bug）。判定：`wsl.exe -d Ubuntu -- bash -lc "type -a claude"` 第一条必须是 ELF，不能是 `/mnt/` 下的 `.exe`。成因常是 npm 全局包半装——postinstall 没跑完，`bin/claude` 只是个几百字节的 "native binary not installed" 提示脚本，软链还停在 `.claude-<随机>` 临时名；`npm i -g @anthropic-ai/claude-code` 重装即可。注意 gemini/opencode 解析到 `/mnt/` 下的 node shim 是**正常**的（它们本就是 JS），只有原生二进制类 CLI 有这个坑。
- **派出去的 WSL Codex worker 可能"活着但一动不动"，判活不能只看 `status`**：prompt 以位置参数传入后可能停在 TUI 里**从未提交**，此时进程活着、cwd/YOLO 都对，但 PTY 零输出、CPU 零占用、`lastOutputAt` 永远停在派发那一刻——与"刚启动还没输出"**完全同形**，plantocodex 基于 `lastOutputAt` 停滞的软超时兜底会一直判"继续等"，无人值守派工静默永久卡死。判定要用 `wsl.exe -d Ubuntu -- bash -lc "ps aux | grep codex"`（进程活着 + PTY 空 = 命中），解法是 `write_to_session(sessionId, "\r")` 发一个裸 CR，**不要直接 kill 重发**（大概率再次命中）。详见工作空间文档 `cc-book-workspace/docs/61-wsl-codex-prompt-unsubmitted.md`（不在本仓库）。
- **`cargo clippy ... | tail` 会掩码退出码，让失败看着像通过**：管道的退出码取自最后一个命令（`tail` 永远成功），失败信息又常被 tail 截掉——0.11.2 合并期实测据此误报过一次"clippy 全绿"，实际败在一个历史遗留 lint。判定成败必须 `echo "EXIT=${PIPESTATUS[0]}"` 或干脆不加管道。同理适用于 `cargo test`、`npx tsc`。
- **运行中的 exe 无法覆盖，但可以改名**：Windows 会锁住正在运行的 `debug\binaries\*.exe`（`os error 32`），`cargo build`（src-tauri 的 build.rs 要碰这些文件）会整个失败。不必杀掉用户正在跑的实例——先把旧 exe **改名**（Windows 允许重命名运行中的文件，进程继续持有旧 inode），再把新文件拷进原位；新拷贝在下次 spawn 时生效。
- **orchestrator 死了不等于没救：daemon 是跨 app 重启存活的锚点**。PTY 会话真身活在 daemon 里（`runtime/daemon-manifest.json` 给出 addr+token），orchestrator 随 app 生死。app 侧全灭时用 `cc-panes-ctl --release sessions list/read/submit` 经 daemon 接管（0.11.2 事故中就是这么救回 5 条在途 worker 的）。**能力分层**：MCP 88 类工具与 `launch` 依赖 orchestrator；会话原语可走 daemon 降级；`bindings` 写默认禁止（绕过 TaskBindingService 不变式），逃生阀 `--force-offline-db`。
- **服务端新增的身份/协议字段必须可缺失**：`/api/health` 的 `service`/`pid`/`startedAt` 是后加的，运行中的 daemon 与安装版都还是旧二进制。把缺失当失败会让排障工具恰好在版本错配（最需要它）的时段完全不可用。分级判定：字段**缺失**→降级可用并**打印警告**（token 是主认证）；字段**存在但对不上**→硬失败（真冒充信号）。见 `cc-panes-ctl/src/discovery.rs::validate_identity`。
- **worktree 的项目记录是「写入自动化、删除手动化」的单向流**：skill 流程与扫描导入会自动 `add_project_to_workspace`，而 `remove_worktree` 只跑 git、`remove_project` 只删记录，两侧不联动——实测一个工作空间 21 条项目里 14 条指向已删目录。已补上三态存在性判定 + 手动批量清理 + 删除联动（docs/62）。新增「自动注册项目」的入口必须同时想清楚谁负责回收。
- **判断项目路径是否存在，必须先过 `canonical_project_path` / `projectIdentityKey`**：注册路径可能以 `/mnt/d/x` 或 `\\wsl.localhost\Ubuntu\mnt\d\x` 形式存着，直接 `Path::exists()` 会把合法的 Windows 路径判成 missing。且判定要三态——WSL 发行版未运行时无法区分「真没了」与「暂时看不到」，判成 missing 会诱导用户误删有效注册。
- **`git worktree list` 从任何一个 worktree 跑都返回同一份全量列表**：拿它做父子关系会互认成环。正确用法是当**分组键**（取 `isMain` 那条的身份 key），父节点定义为「自身身份 == repoKey」的那个。另需守卫「自身必须是列表里一条非 main 的 worktree 根」，否则 monorepo 子目录项目会被误认成假 worktree。
- **`launch_history.project_id` 是「每次启动唯一的 launch id」，不是项目 id**（`proj-` 前端生成 / `orch-` orchestrator 生成；实测 cc-book 有 307 行、307 个不同值）。列名极具误导性：按「项目 id」去理解，会以为 `WHERE project_id = ?` 的 UPDATE 要误伤整个项目的历史，实际只命中 1 行。而 tab 手里的 `props.projectId` 是它**上一次** launch 的 launch_id——**恢复路径复用它去 `bind_pty_session` 必然落空**（那行的 `pty_session_id` 已被上次的 PTY 占用，不满足 `IS NULL OR = 本次`）。0.11.7 期实测：18/18 个 tab 恢复后全无 resumeId，6 条已送达的 resume id 事件全被丢弃，且**不可自愈**（恢复出的会话不写行 → 下次重启又没 resumeId → 永久退化）。新增「跨重启复用 launch id」的链路前先问：这个 id 是每次启动新生成的，还是稳定的？详见 docs/69。
- **stdio MCP 服务器不能给 `Stdio::null()` 的 stdin，它靠 stdin 活着**：`shared_mcp_service.rs::spawn_server_process` 对所有 bridgeMode 一律 null 掉三个流，stdio 类服务器于是启动后 1ms 就 `Shutting down (stdin end)`，三次重启耗尽后彻底停摆。**用户侧的表现完全不像"MCP 挂了"**——AI 拿不到那套工具就静默退到别的工具，实测「让 AI 打开 chromedev」变成打开 CC-Panes 自己的浏览器窗格，看着像 AI 乱点。判定：看该 MCP 自己的 `--logFile`，`connected` 紧跟 `Shutting down (stdin end)` 即命中。注意 Windows 上内层 `cmd /c` **不能去掉**（`npx` 是 .cmd 脚本，直接 spawn 起不来），修复只能落在 stdin 传递上。详见 docs/70。
- **resume id 出问题先分清是「捕获链」还是「落库链」，两者会互相伪装**：日志里**没有** `bind_resume_id` 行 = 事件根本没到 app（捕获/跨 daemon 传输断，docs/45、CLAUDE.md 的 daemon 边界那条）；**有**但报 `no launch_history row matched` = 拿到了 id 但没地方存（落库断，docs/69）。两种都表现为 `resume_session_id` 全 null、恢复出空会话，症状完全同形，但修的是完全不同的两段。
- **`pty/job.rs` 的 Job Object 现在承载两件事：`KILL_ON_JOB_CLOSE` + 资源策略，两段式下发**：进程回收与资源限制是**分开的两次设置**，第二段（优先级/配额）失败**不得赔掉第一段**（回收兜底必须始终生效），改这里时别把两者合成一次 set。资源策略是 0.11.8 批次1 加的（Windows 降 `PRIORITY_CLASS` / Unix `nice`），此前 PTY 子进程与 UI 线程平等竞争，**任一窗格的 `cargo build` / `rg` 大目录都能把整机吃满**。注意仍未覆盖：WSL 会话（需 systemd cgroup scope）、内存/CPU 硬上限、全局并发闸门；runner 就是普通 PTY 会话（`orchestrator_service.rs`），走同一套策略。`OpenProcess` 已带 `PROCESS_SET_QUOTA`，加限制不需要提权。剩余批次与三类"卡"的判据见 docs/71。
- **验证 `#[cfg]` 分支时，`cargo check` 通过可能是假绿**：cfg 没命中的代码根本不参与编译，也就不报错——只在 Windows 上编过就发版，等于把未编译代码发给 mac/Linux 用户。判定方法：往目标分支里**故意塞一个不存在的类型**，看是否报 `E0425`，报了才说明该分支真的在这个平台参与编译，之后再还原并核对 diffstat/hunk 数。另注意跨平台跑 cargo 必须设独立 `CARGO_TARGET_DIR`，否则 Linux 产物会覆盖共享 `target-dir` 里的 Windows 同名文件，污染所有 worktree。
- **判断"卡"属于哪一类，先看整机 CPU**：整机 CPU 高（非 CC-Panes 程序也卡）= 子进程资源争抢（docs/71 第 2 节）；整机 CPU 不高但 UI 掉帧 = xterm 输出洪水（docs/71 第 3 节）。两者症状同形、治法完全不同，搞反了会去优化渲染而实际是编译器在吃满核。输出链路现状（0.11.8 后台暂停 + 0.11.9 批次收尾后）：后台标签有 512KB 隐藏积压 + 边沿 flush（**溢出不再打截断提示**——可见性回归时自动走 snapshot 重放恢复画面，截断提示仅剩退出兜底路径）；后台分层降档（5min 挂 WebGL / 30min **休眠**——SerializeAddon 全量序列化后 dispose 实例，切回经 epoch 重建回放，`terminalHibernation.ts`）；写流控全平台启用；daemon/web 广播改有界 256 + **desync 契约**（溢出绝不掐 VT 中段，整段跳过、排空后发 `{"type":"desync"}`，前端 `terminalResync.ts` 走 snapshot 重放）。改这条链路时守住三条不变式：丢弃只能整段、回放数据必须过 `renderTerminalData`、休眠唤醒不得丢字。
- **WSL 会话在资源视图里恒显示 ~8 MB / 0% CPU，那是假的**：`wsl.exe` 只是瘦客户端，真实负载在 `vmmemWSL`（实测 4 个 WSL 会话对应 10.7 GB，且未归属任何会话）。两个后果：①`get_resource_tree` 与状态栏 popover 对 WSL 会话的读数**接近于零且不可信**，"WSL 会话很闲"与"WSL 会话在狂吃内存"完全同形；②Job Object 对 WSL 会话**完全无效**（那些进程不是 Windows 进程）。WSL 侧要用 `systemd-run --user --scope` + cgroup v2（实测 `user@1000` 已委派 `cpu memory pids`，无需 root、无需 `wsl --shutdown`）。注意 CC-Panes 起的 WSL 会话落在 `/init.scope` 而非 `user.slice`，**不显式包 scope 就没有任何约束**；注入点 `wsl_codex.rs:748-755`。详见 docs/71 第 7 节。
- **`wsl --shutdown` 的杀伤面远超"我的 WSL 会话"**：它终止**所有**发行版——实测本机除 `Ubuntu` 外还跑着 `docker-desktop`，一次 shutdown 等于拆掉用户整个 Docker 环境（容器全停、Docker Desktop 需重启），而用户点按钮时完全想不到这层。任何"改 `.wslconfig` 后引导生效"的流程必须先 `wsl.exe --list --running` 算出完整影响面并对基础设施发行版单独高亮，绝不能把重启做成写入的副作用。另注意 `/etc/wsl.conf` 是 per-distro 且**写入需 root**，只能只读+给命令，不能代写。
- **读 `.wslconfig` 必须直读文件，且它是 INI 不是 TOML**：碰 `\\wsl$` 或调 `wsl.exe` 会拉起/保活 Vmmem VM（issue #37，`usage_stats_service.rs:131`）——一个"读 WSL 配置"的功能若把 VM 唤醒了，自己就成了新的资源问题；需判断 VM 状态时用 `wsl_discovery_service.rs:92` 的 `is_wsl_vm_running()`（只查 vmmemWSL 进程，零副作用）。解析上 `memory=80GB` 这种裸值会让 `toml` crate 直接失败，且写回时必须保留用户注释与键顺序（实测用户配置里带注释说明为何调高 memory）。另注意「文件不存在」≠「无配置」，而是全部取默认（`processors` 默认 = **全部逻辑核**），UI 必须展示 effective 值。详见 docs/71 第 7.4 节。
- **别用 MSIX 打包的进程去验证 Windows Job 限制**：MSIX 容器自带一层 job，嵌套 job 下 `QueryInformationJobObject(NULL)` 只报**最内层**，会把真实的 PTY 会话 job 完全遮住——实测用 MSIX 的 pwsh（`WindowsApps\...\pwsh.exe`）探到 `LimitFlags=0x800`(BREAKAWAY_OK)，换 System32 的 `powershell.exe` 才看到真值 `0x2000`。同理适用于任何"从子进程反查父级 job 配置"的排障。
- **终端"乱了"要先分清是 buffer 乱还是渲染乱，两者同形、治法完全不同**：错乱内容**能选中复制出来** = buffer 级——我们对 claude/codex 主动剥掉 alt-screen（`terminalBufferMode.ts:138`），TUI 的相对定位锚点会在主缓冲区滚动时被 xterm 的 `cursorUp` **静默截断**（`InputHandler.ts:902` 钳到 `scrollTop`），之后每帧都画错行；此时渲染层刷新永远无效，只有让 CLI 自己重绘（SIGWINCH）才修得掉。错乱是色块/字形碎片、复制出来却是正常文本 = 渲染级（WebGL atlas），那才是右键「刷新终端显示」的原始目标场景。用户报"刷新没用"时大概率是前一类。详见 docs/73。
- **Windows 上终端渲染器恒为 DOM，一切 WebGL 补救路径都是死代码**：`windows-cjk-guard` 与 `wallpaper-transparency` 两条都把 auto 打到 DOM（`terminalRenderer.ts:167/179`）。任何写在 `if (webglAddon)` 里的修复在 Windows 主力场景下**从不执行**——`clearTextureAtlas` 首行就 `return false`。写完自测"没报错"不等于生效。
- **`openEditor` 在 Files 视图下不建 pane tab 而是静默返回 `null`**（`editorTabActions.ts:70-75`）：`appViewMode === "files"` 时它改走 `useEditorTabsStore.openFile()`，落进 Files 视图自己的 tab 列表，**分屏区毫无反应**——从分屏区里的入口调用时看着完全像「点了没用」。分屏区内的调用方必须传 `{ forcePaneTab: true }`。同理，editor 是**两份数据**（Files 视图的 `useEditorTabsStore` + pane 树的 editor tab），MCP `list_open_files` 是两者并集，同一文件双开会出现两条。
- **统计 pane 树里的 tab 不要用 `collectTerminalTabs`**：它第一步就把非终端全过滤掉了，拿它数「有多少标签」会漏掉 7 种 `contentType` 里的 6 种。通用遍历是 `collectTabs`（`lib/paneSessions.ts`，基于 `collectPanels`）。另有两条必须照抄的规避：**starred 布局是镜像**（`panes/starredMirrors.ts`），直接统计会把同一 tab 数两遍；**当前布局的活树在 store 工作副本 `rootPane` 上**，不在 `layouts[i].rootPane`，取错了当前布局的数字永远是旧的。详见 docs/75。
- **Zustand selector 里不要调用返回新集合的 store 方法**：`usePanesStore((s) => s.listLayouts())` 这类写法，因 `listLayouts` 内部是 `filter().map()` 每次返回新数组，`useSyncExternalStore` 的快照永不相等 → `Maximum update depth exceeded` 崩页。正确做法是选稳定引用（如 `s.layouts`）后用 `useMemo` 本地派生；`.getState().listLayouts()` 在渲染外调用则不受影响。
- **关标签/删布局/快照覆盖的会话回收只有一个入口：`destroyPipeline` + `removeTabsInternal`**（0.12.0 批1 落地，docs/78）。此前 5 份散落的 kill 实现已收编，新增任何销毁路径都必须走这两个出口并在 `DESTROY_POLICY` 矩阵补一行（7 个维度：可否决/记撤销/尊重 pinned/杀不杀/关不关弹窗/KillReason 映射），穷举测试会逼着同步。**`killSession` 的调用点有白名单扫描测试守着**，第 6 份实现在 CI 就会被拒。两条不变式：①回收先于树操作（树 splice 后 tab 数据就找不回来了）；②pinned 豁免在「资源收集」与「树操作」两处必须同口径判定，否则会出现「会话杀了但标签还在」或反之。
- **树操作与销毁必须分开：搬空 pane 只能用 `removeEmptyPane`，绝不能借道 `closePane`**。`moveTab` / `moveTabToLayoutPane` 把 tab 搬走后要收掉空壳，而 `closePane` 自 0.12.0 起会销毁 pane 内的 tab（回收 PTY）——借道它等于**用户拖一下标签就杀掉自己正在跑的 agent 会话**。`removeEmptyPane` 非空即拒 + dev 告警，是类型层面的隔离而非防御式冗余。
- **`applyLayoutSnapshotPayload` 的差集真杀在 `terminal.snapshotApplyKillEnabled` 开关后面（默认关），观察期零误报前别翻开**：跨端同步每 5s 跑一轮 `apply → reconcileTerminalSessions → runBackgroundLayoutRestore`，整树替换后旧树会话虽然失去引用，但**常常马上被收养回来**（新树经 `savedSessionId` 引用同一个会话）。差集算错 = 杀光用户所有活会话。0.12.0 起观察链已修齐四缺陷：保护集与孤儿 GC 同源（`sessionReferenceCollector.ts`：树引用 ∪ SelfChat ∪ runner ∪ task binding ∪ 后端活会话）、任一保护集来源不可达即 `abandonSnapshotKillCandidates`（**绝不带残缺保护集 finalize**——少一路保护集只会放大杀集）、begin/finalize 带 `isTauriRuntime()` 门控、悬挂候选 60s TTL。开闸操作 = 打开设置开关（真杀走 `performSnapshotApplyKills`：orphan-reclaim + 单轮上限 10 + 多实例守卫）；开闸判据 = `[destroy] snapshot-apply would-kill (post-settle, re-verified)` 与 `[orphan-reconcile] sweep` 长期逐条一致。
- **收集要杀的会话必须用 `collectTerminalSessionIdsWithSaved`（含 `savedSessionId`），不是 `collectTerminalSessionIds`**：`savedSessionId` 是「恢复中但尚未 attach」的会话，背后是**真实存在的 PTY**，漏掉就是孤儿。旧口径函数保持原样另有消费者，两者并存且有守护测试防「顺手合并」。
- **从 Immer draft 里带出数据做异步处理必须深拷贝**：`{ ...tab }` 浅拷贝的 `terminalRootPane` 仍指向 draft，`set()` 结束后 proxy 被 revoke，异步回收再读就抛 `Cannot perform 'get' on a proxy that has been revoked`。用 `structuredClone(current(tab))`。**这条只在异步路径触发，测试断言照常通过、仅报未处理拒绝**，极易漏过去。
- **改了销毁链路后测试挂了，先分清是「功能坏了」还是「测试观察点过时」**：0.12.0 批1 实测三轮失败里两轮是后者——`vi.mock("@/services")` 只 mock 了桶文件，而 `destroyPipeline` 从 `@/services/terminalService` **直接** import，绕过 mock，表现为「回收没发生」；另一类是测试注入假 `closeTab` 断言旧协作方式，而改道后 UI 只把 tabId 交给出口。直接改测试让它变绿的话，混在里面的**真**退化（当时是 dirty 守卫按 contentType 分派后终端标签的未保存确认静默消失）就被盖过去了。
- **可见性的唯一事实源是 `useTabViewStateStore`，键是 `owner:role` 而不是 tabId**（0.12.0 批2）：**可见性属于「视图」，不属于「标签」**——同一个 PTY 可能被主标签、星标镜像、弹出窗口三个视图同时观看，而 SelfChat 跑着真实 Claude 会话却根本没有 tabId（它是全屏主视图，不在 pane 树里）。不要给无 tab 的视图伪造 tabId：`TerminalView` 的 `tabId` prop 被 `findTabAcrossLayouts`/`updateTerminalLaunchId` 当作真标签 id 用，塞假值会静默查不到（docs/69 同类坑）。降档/休眠判据是聚合的 `anyVisible`（**任一视图可见就不休眠**），渲染/WebGL 与 scheduler 焦点判据看单视图——两者不能混用。
- **降档判据改了信号源就必须同时加 store 订阅**：其他视图（星标镜像、弹出窗口）的可见性翻转不会让本组件 render，每帧 effect 够不着。没有订阅的话「打开星标页」不会取消原 tab 已经启动的休眠计时——修完 bug 只修了一半。
- **积压 flush 有两条防线，删任何一条都会丢字**（0.12.0 批2 复核结论，与初版设计相反）：`terminalHiddenWriteBuffer` 的 drain-on-push 解决「可见性翻转与数据到达的**竞态**」（顺序不由 buffer 决定，漏拼会让积压排到新数据之后）；`TerminalView` 每帧 effect 的边沿 flush 解决「**静默会话**切回可见时的补投」——drain-on-push 只在有新数据时排空，而切回一个已经跑完、不再产出的后台标签时 push 永远不会被调用，积压将永远显示不出来。两者覆盖的不是同一件事。
- **组件里加 hook 必须在所有提前 return 之前**：0.12.0 批2 实测把可见性上报 hook 插在了 `if (!tabData) return` 之后，React 直接报「Hooks 调用顺序变化」并使组件崩溃——测试表现为「找不到 testid」，看着像渲染逻辑坏了，实际是 Hooks 规则违规。
- **`useTerminalStatusStore.statusMap` 由后端事件整条覆盖，别往里塞前端侧字段**：塞进去的会被下一个 `terminal-status` 事件抹掉。轴1 输入活跃因此独立成 `useTerminalInputActivityStore`。
- **新增跨 daemon 事件必须先改 `cc-panes-core/src/services/boundary_events.rs` 契约表**（0.12.0 批3）：daemon 架构本身没出过问题，出问题的全是边界——resume id 掉进 emitter 的 `_ => {}`（docs/45）、scrollback 停产、notifier 整族静默丢失，同一种病。emitter 有穷举守卫：对表中每个 `origin: Emit` 的事件真跑一次投递，没有任何投递就是落进了 `_ => {}`，CI 直接报错。注意表里的 `origin` 维度区分三类来源——`terminal-desync` 是 emitter 在队列排空后**自行插入**的出站信号，不经 emit，所以 emit 里没有也不该有它的分支。TS 侧 `daemonEventContract.ts` 是镜像表，测试**真去扫源码**验证三处分发（Rust per-session、Rust control、前端监听器）都有 handler。
- **hidden 闸门按连接记账，不是按会话**（0.12.0 批3）：daemon 是多客户端共享的（桌面+web+手机），桌面把标签切后台**不得掐断手机端正在看的同一个会话**。闸门只掐可丢的输出（`drop_on_full=true`），exit/killed 这类必达事件即使隐藏期也要送达——丢了会让前端永远显示一个已经死掉的「运行中」会话。**连接断开必须清 hidden 标记**，否则重连后的新订阅被旧标记压住，表现为「重连后永久收不到输出」且零报错。接线已完成（0.12.0 收尾期）：关联协议复用 per-session WS 既有的 instanceId（control URL 带同一个，同源即关联），control link 双向化 + `set_hidden_terminal_sessions` command + 前端 `useHiddenSessionReporter`。**上报不保证生效**（旧 daemon 静默丢弃/断线/web 模式无 control 通道），前端 512KB 积压是永久兜底，不得因上报存在而放松；且要求 daemon 二进制已更新并重启（binaries 陈旧 gotcha 在这条链路上的表现是「一切正常但 WS 流量不归零」）。
- **`launchId` 每次启动都要新生成，绝不能复用 `projectId`**（docs/69 活体暗雷，0.12.0 批4 修）：`launch_history.project_id` 存的其实是「每次启动唯一的 launch id」（列名极具误导性），而 `bind_pty_session` 要求那行的 `pty_session_id` 满足 `IS NULL OR = 本次`——拿一个已被上次 PTY 占用的 id 去绑必然落空，resume id 丢失且**不可自愈**（恢复出的会话不写行 → 下次重启又没 resumeId → 永久退化）。修的时候发现既有测试断言 `launchId === projectId`，**把错误行为写成了规格**——改这类 bug 要一并检查测试是不是在锁死错误。
- **终端「现在什么状态」用 `phaseOf()` 派生，别自己组合那 7 个字段**（0.12.0 批5）：restoring / savedSessionId / restoreBlockedReason / leaseReadOnly / launchError / launchAttempt / disconnected 的合法组合从未被声明过，各消费方脑补的结果是同一状态在不同地方判出不同结果。优先级顺序本身是规格：已退出压倒一切 → 启动失败压过恢复中 → **被挡住的恢复压过恢复中**（否则显示永远转圈的假恢复）→ 断连压过运行中。`isLivePhase` 把 restoring 算作活的（会话已建），这条直接决定销毁链路会不会漏杀。

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
| `docs/57-ccpanes-ctl-and-mcp-orphan.md` | cc-panes-ctl 规格 + MCP 孤儿缺口（经 Codex 同行评审重写） |
| `docs/58-feature-tips.md` | 功能提示（tips）系统：让积累的能力偶尔冒出来 |
| `docs/62-worktree-project-hygiene.md` | worktree 项目嵌套显示 + 残留记录回收（写入自动化/删除手动化的单向流根因） |
| `docs/59-update-notification.md` | 版本更新右下角提示卡片 |
| `docs/60-notify-ui-handoff.md` | 打扰闸门+更新卡片+功能提示 交接指令 |
| `docs/64-ai-panel-templates.md` | AI 面板模板化 + fleet 编排拓扑视图（方向文档 + 原型，**未排期**） |
| `docs/65-skill-observation-contract.md` | **Skill 观测契约**：状态判读表 / 同形陷阱 / 停手规则 / 收尾字段——launch 与编排类 skill 回引此文 |
| `docs/66-0115-session-recovery-promotion.md` | **0.11.5 计划**：会话恢复转正（单主线）——灰度 + Windows 验收 + 开关默认开启 |
| `docs/67-discoverability-plan.md` | **发现性计划**：主页装修（对标 orca）+ tips 扩容 + 补 4 篇新能力 guide（与 68 交互质量分工） |
| `docs/67-storyboards.md` | 67 附录 · 素材分镜脚本：主页 GIF 与 in-app tips 的唯一共享物，两边各实现一次 |
| `docs/68-interaction-quality-plan.md` | **交互质量计划**：关闭标签杀 agent 会话无确认 / 终端聚焦时 7 个快捷键静默失效 / 空态不统一（与 67 发现性分工，未排期） |
| `docs/69-resume-id-binding-gap.md` | **resume id 落库缺口**：恢复出来的会话只能恢复一次（捕获链 vs 落库链的区分判据） |
| `docs/70-shared-mcp-stdio-death.md` | **shared MCP 启动即自杀**：stdio 服务器被 `Stdio::null()` 掐死（**待修**，含 Chrome 9222 责任归属决策） |
| `docs/71-multi-pane-resource-contention.md` | **多窗格资源争抢**：一个窗格 `cargo build` 拖垮整机（批次1 已落地，含三类"卡"的判据与输出洪水链路现状） |
| `docs/72-legacy-branch-triage.md` | **老分支收编判定**：`git cherry` 说「未合并」≠「还有价值」——四条分支的判定结论与三层判据 |
| `docs/74-dev-ledger.md` | **开发台账方向文档**：编排面板重定位为进行中/台账两模式，工作项骨干 = task_binding，worktree/todo/plan 为切面——四批 roadmap，实施逐批抽 plan |
| `docs/75-layout-card-rework.md` | **布局卡片改造**：状态三重编码（形状+色+数）/ 七类 contentType 归四桁计数 / 点击跳转轮换 / 补齐浏览器·文件新建入口——新增 contentType 必须同步 `lib/tabContentType.ts` 两张表 |
| `docs/78-tab-lifecycle-and-recovery-rework.md` | **Tab 生命周期与恢复统一重构总纲**：useTabLifecycle 钩子 + 三轴模型 + 登记表/销毁管线 + 可见性单源 (tabId,role) + checkpoint+delta 恢复归一 + daemon 边界契约——五批 roadmap（0.11.11+ 逐批抽 plan + codex 评审），含 Orca 源码对照判决 |
| `docs/81-abnormal-exit-session-recovery.md` | **异常退出会话的冷恢复**：旧 daemon 不支持安全认领时的「杀旧建新」人工入口——决策表 / 文案 / 验收标准（fail-closed 未破，只对 `claims-unsupported` 开放） |
| `docs/82-provider-context-window.md` | **Provider 上下文窗口与用量修复**：模型行 `contextWindowTokens` + migration v30 + 窗口解析优先级（jsonl > provider 配置 > `WINDOW_UNKNOWN` 降级）；含 `--settings` 注入的两条待真机验证项 |
| `docs/references.md` | 外部参考项目索引 |
| `docs/archive-v1.md` | 旧版本归档说明 |
