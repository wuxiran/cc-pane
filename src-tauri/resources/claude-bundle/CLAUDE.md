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
| `docs/57-ccpanes-ctl-and-mcp-orphan.md` | cc-panes-ctl 规格 + MCP 孤儿缺口（经 Codex 同行评审重写） |
| `docs/58-feature-tips.md` | 功能提示（tips）系统：让积累的能力偶尔冒出来 |
| `docs/62-worktree-project-hygiene.md` | worktree 项目嵌套显示 + 残留记录回收（写入自动化/删除手动化的单向流根因） |
| `docs/59-update-notification.md` | 版本更新右下角提示卡片 |
| `docs/60-notify-ui-handoff.md` | 打扰闸门+更新卡片+功能提示 交接指令 |
| `docs/64-ai-panel-templates.md` | AI 面板模板化 + fleet 编排拓扑视图（方向文档 + 原型，**未排期**） |
| `docs/65-skill-observation-contract.md` | **Skill 观测契约**：状态判读表 / 同形陷阱 / 停手规则 / 收尾字段——launch 与编排类 skill 回引此文 |
| `docs/66-0114-session-recovery-promotion.md` | **0.11.4 计划**：会话恢复转正（单主线）——灰度 + Windows 验收 + 开关默认开启 |
| `docs/67-discoverability-plan.md` | **发现性计划**：主页装修（对标 orca）+ tips 扩容 + 补 4 篇新能力 guide（与 68 交互质量分工） |
| `docs/67-storyboards.md` | 67 附录 · 素材分镜脚本：主页 GIF 与 in-app tips 的唯一共享物，两边各实现一次 |
| `docs/68-interaction-quality-plan.md` | **交互质量计划**：关闭标签杀 agent 会话无确认 / 终端聚焦时 7 个快捷键静默失效 / 空态不统一（与 67 发现性分工，未排期） |
| `docs/references.md` | 外部参考项目索引 |
| `docs/archive-v1.md` | 旧版本归档说明 |
