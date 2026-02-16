# CC-Panes 全项目独立评审报告

> 评审时间: 2026-02-15
> 评审范围: 全项目 114+ 源文件

---

## 评审报告 B：后端代码质量（已完成）

> 评审范围: `src-tauri/src/` 目录下全部 43 个 Rust 源文件

### Critical（必须修复）

**C-1. [src-tauri/src/repository/db.rs:58] Database::connection() 中 Mutex unwrap 可导致 panic**
- 问题: `self.conn.lock().unwrap()` 在 Mutex 被 poison 后将直接 panic，导致整个应用崩溃。这是所有 Repository 层方法的核心路径。
- 影响: 全局 -- ProjectRepository、HistoryRepository 的所有方法依赖此处
- 修复: 使用 `self.conn.lock().unwrap_or_else(|e| e.into_inner())` 恢复 poison 锁（项目其他位置如 history_file_repo.rs 已经采用了这种模式），或返回 Result

**C-2. [src-tauri/src/repository/db.rs:18] Database::new() 中 expect 导致启动时不可恢复的 panic**
- 问题: `Connection::open(&db_path).expect("无法打开数据库")` 以及第 38/53 行的 expect。磁盘空间不足或数据库损坏时，应用将无法启动且无 UI 反馈
- 影响: 应用启动失败时用户无法得到任何 UI 反馈
- 修复: 将 Database::new 改为返回 Result，在 lib.rs 的 run() 中进行错误处理和用户提示

**C-3. [src-tauri/src/commands/claude_commands.rs:361] clean_session_file 接受任意文件路径 -- 路径穿越风险**
- 问题: `clean_session_file(file_path: String)` 直接将用户传入的任意路径作为文件操作目标，没有任何路径校验。恶意前端或被注入的 WebView 可以传入任意路径导致读取和覆写任意文件
- 影响: 安全漏洞 -- 可被用于读取/修改系统文件
- 修复: 校验 file_path 必须位于 `~/.claude/projects/` 目录下，且扩展名必须为 .jsonl

**C-4. [src-tauri/src/commands/settings_commands.rs:83] migrate_data_dir 中 target_dir 缺少路径穿越保护**
- 问题: migrate_data_dir 接受用户传入的 target_dir 字符串，直接用于文件复制操作。没有限制目标路径范围。可将 providers.json（含 API Key）复制到攻击者可访问位置
- 影响: 数据泄露风险 -- providers.json 中包含 API Key 等敏感信息
- 修复: 至少限制目标路径不能是系统目录，或要求为空目录/新建目录

**C-5. [src-tauri/src/services/terminal_service.rs:172] sessions Mutex unwrap 可导致 panic**
- 问题: `self.sessions.lock().unwrap()` 出现在第 172、305、333、345、361 行共 5 处。任何一次锁持有期间 panic 后，后续所有终端操作都将 panic
- 影响: 全局终端功能不可用
- 修复: 统一使用 `.lock().unwrap_or_else(|e| e.into_inner())` 模式

---

### High（应该修复）

**H-1. [src-tauri/src/commands/history_commands.rs:6-28] history_commands 跳过 Service 层直接访问 Repository**
- 问题: add_launch_history、list_launch_history、clear_launch_history 直接注入 Arc<HistoryRepository>，完全绕过 Service 层
- 影响: 架构一致性。未来添加业务逻辑时修改点将分散
- 修复: 创建 LaunchHistoryService 封装，或合并到 ProjectService

**H-2. [src-tauri/src/commands/claude_commands.rs 全文] claude_commands 将大量业务逻辑放在 Command 层**
- 问题: 约 490 行代码，含会话解析、文件读取、JSON 处理、broken session 扫描清理等。ClaudeSession、BrokenSession、CleanResult 等模型也定义在 command 文件中
- 影响: 职责混乱，代码不可测试
- 修复: 提取 ClaudeService 到 services 模块，数据结构移到 models

**H-3. [src-tauri/src/commands/git_commands.rs 全文] git_commands 在 Command 层包含业务逻辑**
- 问题: run_git_command、auto_label_before_git、get_git_branch、get_git_status 等全部定义在 command 层，没有对应 GitService
- 修复: 提取 GitService 到 services 模块

**H-4. [src-tauri/src/commands/window_commands.rs 全文] window_commands 在 Command 层包含业务逻辑**
- 问题: enter_mini_mode 和 exit_mini_mode 包含多步窗口操作逻辑，所有 12 个命令仍使用 Result<T, String>
- 修复: 提取窗口操作逻辑到 service 层，统一使用 AppResult

**H-5. 错误处理不统一：大量命令仍使用 Result<T, String>**
- 问题: 约 65 个命令中有约 37 个未迁移到 AppResult
  - 未迁移: project_commands(6), window_commands(12), git_commands(7), claude_commands(5), history_commands(3), hooks_commands(6), worktree_commands(4), workspace_commands(11), settings_commands(4), provider_commands(7)
  - 已迁移: terminal_commands(5), local_history_commands(~20), journal_commands(3)
- 修复: 全面迁移到 AppResult

**H-6. [src-tauri/src/services/terminal_service.rs:191-252] 终端读取线程中的 PTY 资源清理不确定**
- 问题: kill() 时 session 从 HashMap 移除，但读取线程和等待线程仍在运行。reader 仍持有 PTY 引用
- 影响: 资源泄漏风险（线程和文件描述符）
- 修复: 使用 CancellationToken 或向子进程发送信号来显式终止

**H-7. [src-tauri/src/services/workspace_service.rs:15] WorkspaceService::new 中 expect 导致 panic**
- 问题: `fs::create_dir_all(&base_dir).expect("无法创建 workspaces 目录")` 磁盘满或权限不足将导致启动 panic
- 修复: 返回 Result

**H-8. 多处 Mutex unwrap 存在 poison panic 风险**
- 问题: settings_service.rs:51, provider_service.rs 多处（45,50,55,63,84,104,126,139行）, notification_service.rs（81,87,103行）
- 修复: 统一使用 `unwrap_or_else(|e| e.into_inner())` 模式

---

### Medium（建议修复）

**M-1. [多个 repo 文件] filter_map(|r| r.ok()) 静默丢弃查询错误**
- 文件: project_repo.rs:34, history_repo.rs:57, history_file_repo.rs（421,451,464,1003,1086,1107,1142,1166,1196行）
- 修复: 至少记录日志

**M-2. [src-tauri/src/utils/app_paths.rs:14-15] dirs::home_dir 回退到当前目录**
- 问题: 无法获取 home 目录时回退到 "."，可能导致数据创建在不可预测位置
- 修复: 返回 Result::Err

**M-3. [src-tauri/src/utils/app_paths.rs:24-25] 目录创建失败被静默忽略**
- 修复: 传播错误或记录日志

**M-4. [src-tauri/src/services/terminal_service.rs:373-400] infer_status 状态推断误报率高**
- 问题: 基于输出文本最后一行字符检测，程序输出中 `?` `>` 等字符会产生大量误报
- 修复: 增加更精确的 ANSI escape sequence 分析

**M-5. [src-tauri/src/utils/app_paths.rs:75] dir_size 参数类型应为 &Path**
- 修复: 改为 `fn dir_size(path: &Path) -> u64`

**M-6. [src-tauri/src/services/history_service.rs:44] silence_until 字段在 dispatch_event 和 event_loop 中各有独立副本**
- 问题: 两处静默窗口表不同步
- 修复: 统一使用一个 Arc<Mutex<...>> 共享

**M-7. [workspace_service.rs:214, settings_service.rs:28] 参数类型 &PathBuf 应为 &Path**

**M-8. [src-tauri/src/commands/workspace_commands.rs:94-98] scan_workspace_directory 跳过 Service 实例直接调用静态方法**

**M-9. [src-tauri/src/services/hooks_service.rs:59-172] Python hook 脚本硬编码在 Rust 源码中**
- 约 110 行 Python 代码
- 修复: 抽取为独立文件，使用 include_str! 宏

**M-10. [src-tauri/src/repository/history_file_repo.rs:359-363] 版本 ID 生成存在理论碰撞风险**
- 问题: AtomicU32 + Relaxed ordering + % 10000
- 修复: 使用 UUID 或纳秒级时间戳

**M-11. [src-tauri/src/services/terminal_service.rs:322-326] 时间计算可能 u64 下溢**
- 修复: 使用 saturating_sub

---

### Low（可选修复）

**L-1.** 多个 Command 文件中 `.map_err(|e| e.to_string())` 重复（迁移到 AppResult 后自动解决）

**L-2.** [claude_commands.rs:97-104] is_matching_project 路径匹配可能有 edge case（不同路径替换后碰撞）

**L-3.** [settings_commands.rs:170-207] copy_dir_recursive 跟随符号链接

**L-4.** [claude_commands.rs:79] 字符串长度比较使用字节数而非字符数

**L-5.** [claude_commands.rs:99] 反斜杠替换顺序依赖缺少注释

**L-6.** [notification_service.rs:43] format! 宏无参数，应直接使用 .to_string()

**L-7.** [lib.rs:100] history_repo 直接作为 State 注入，绕过 Service 层

**L-8.** [journal_service.rs:335-338] Default 实现使用空 PathBuf

**L-9.** [lib.rs:279] run() 中 expect（Tauri 惯用模式，可保持现状）

**L-10.** [terminal_service.rs:27] resolve_tui_binary 未使用 cfg(windows) 条件编译

---

### 后端评审总结

| 级别 | 数量 | 主要问题领域 |
|------|------|-------------|
| Critical | 5 | Mutex unwrap panic、路径穿越安全漏洞、启动时 expect panic |
| High | 8 | 架构分层违规、错误处理不统一、资源清理不确定性 |
| Medium | 11 | 静默丢弃错误、路径类型惯例、代码重复、时间溢出 |
| Low | 10 | 微小代码改进、可读性、跨平台兼容 |

**最需要优先关注的三个方向：**
1. **安全性**（C-3、C-4）: clean_session_file 和 migrate_data_dir 缺少路径校验
2. **健壮性**（C-1、C-2、C-5、H-8）: 大量 Mutex::lock().unwrap() 和 expect()
3. **架构一致性**（H-1 至 H-5）: 约 37 个命令仍使用 Result<T, String>，3 个命令模块绕过 Service 层

---

## 评审报告 A：前端代码质量（已完成）

> 评审范围: `src/` 目录下全部 80+ 个 TypeScript/TSX 源文件

### Critical（必须修复）

**A-C1. [src/components/panes/TerminalView.tsx:75-234] useEffect 闭包陈旧回调问题**
- 问题: 初始化 useEffect 依赖数组为 `[]`，但内部使用了 `props.onSessionCreated` 和 `props.onSessionExited` 等闭包变量。如果父组件重新传入不同的回调，终端仍然调用旧的 handler，导致 session 信息更新到错误的 pane
- 影响: 终端功能核心逻辑
- 修复: 使用 useRef 保存最新回调（callback ref pattern）

**A-C2. [src/components/panes/TerminalView.tsx:81-109] 终端主题硬编码为暗色**
- 问题: 终端 theme 对象硬编码了暗色背景 `#1a1a1a`，第 286 行外部容器也硬编码了 `bg-[#1a1a1a]`。全局主题切换时终端不响应
- 影响: 亮色模式下终端不可读/视觉不一致
- 修复: 从 useThemeStore 读取终端主题配置，动态更新 xterm theme

**A-C3. [src/stores/usePanesStore.ts:12-13] ID 生成器使用 Date.now() 可能碰撞**
- 问题: generateId 使用 `Date.now()` + `Math.random()`。快速连续操作时可能碰撞。同样出现在 App.tsx:141
- 影响: 面板/标签 ID 重复
- 修复: 统一使用 `crypto.randomUUID()`（项目中 ProviderSection.tsx:77 已使用此方式）

---

### High（应该修复）

**A-H1. [src/components/sidebar/WorkspaceTree.tsx:1-584] 组件过大（584行）**
- 问题: 包含工作空间 CRUD、项目 CRUD、别名管理、扫描导入、Git 分支获取、Worktree 缓存、Provider 设置、5 个 Dialog
- 修复: 拆分为 WorkspaceItem、ProjectItem 子组件，Dialog 状态提取到自定义 hook

**A-H2. [src/components/LocalHistoryPanel.tsx:1-451] 组件过大（451行）**
- 问题: 包含版本列表、diff 预览、删除文件恢复、标签管理等多种功能
- 修复: 拆分为 VersionList、VersionPreview、DeletedFilesView 子组件

**A-H3. [src/components/panes/TabBar.tsx:1-340] 组件过大（340行）**
- 问题: 包含拖拽排序、内联重命名、上下文菜单、主题切换、分屏操作等
- 修复: 将右侧工具栏区域（249-337行）提取为 TabBarActions 子组件

**A-H4. [src/components/Sidebar.tsx:10-19] Props Drilling**
- 问题: Sidebar 接收 9 个 props，onOpenTerminal、onOpenJournal 等直接透传给 WorkspaceTree。回调实际逻辑都是 useDialogStore.getState()
- 修复: 让 WorkspaceTree 直接使用 useDialogStore

**A-H5. [src/stores/useTerminalStatusStore.ts:7-8] Store 暴露内部实现细节**
- 问题: `_unlisten`、`_idleCheckInterval`、`_initialized` 不应暴露在 store 公共接口中
- 修复: 使用 module-level 变量（闭包）存储这些值

**A-H6. [src/stores/useSettingsStore.ts:97-98] 模块级别副作用**
- 问题: `useSettingsStore.getState().loadSettings()` 在模块加载时自动调用，测试困难
- 修复: 在 App.tsx 的 useEffect 中触发加载

**A-H7. [src/components/panes/SplitContainer.tsx:40] 无效的 style 属性**
- 问题: `pointerEvents: isResizing ? undefined : undefined` -- 无论 isResizing 为何值结果都是 undefined
- 修复: 应为 `isResizing ? "none" : undefined`

**A-H8. [src/stores/useProvidersStore.ts:43-58] Store 跨职责耦合**
- 问题: removeProvider 遍历所有 Workspace 清理悬空引用，导致 Provider store 直接依赖 Workspace service
- 修复: 在 Workspace store 中监听 Provider 变化

---

### Medium（建议修复）

**A-M1.** [src/components/panes/Panel.tsx:14-24] 从 store 提取 10 个独立 selector，可用 useShallow 合并
**A-M2.** [src/App.tsx:246-247] Dialog onOpenChange 内联箭头函数每次渲染创建新引用
**A-M3.** [src/components/MiniView.tsx:17-27] allPanels() 每次调用重新遍历树，建议在 store 中提供 allActiveTabs 派生
**A-M4.** [src/components/sidebar/WorkspaceTree.tsx:102-123] setState 回调内发起异步请求，应在外部执行
**A-M5.** [src/components/panes/TerminalView.tsx:128-132] terminalService.write() 缺少 .catch() 错误处理
**A-M6.** [src/services/terminalService.ts:41-64] 全局事件监听器，N 个终端注册 N 对监听器，每条消息被检查 N 次
**A-M7.** [src/stores/useThemeStore.ts:17-19] 模块级副作用访问 localStorage 和 DOM
**A-M8.** [src/components/settings/ProviderSection.tsx:46] eslint-disable 不必要，loadProviders 引用稳定可安全添加到依赖数组
**A-M9.** [src/hooks/useTauriEvent.ts:30] handler 参数在依赖数组中可能导致频繁重新订阅
**A-M10.** [src/components/panes/Panel.tsx:161-179] 所有标签同时挂载（含非活跃），仅 display:none 隐藏，内存占用大
**A-M11.** [src/stores/usePanesStore.ts:99-105] allPanels/activePane/findPaneById 定义为 state 方法而非 selector
**A-M12.** [src/stores/useShortcutsStore.ts:72] navigator.platform 已弃用

---

### Low（可选修复）

**A-L1.** [src/components/panes/TabBar.tsx:267] 嵌套 TooltipProvider 冗余（App.tsx 已有顶层 Provider）
**A-L2.** [src/App.tsx:135] eslint-disable 缺少详细理由注释
**A-L3.** [src/main.tsx:5] 缺少 React.StrictMode
**A-L4.** [src/utils/path.ts + 多处] 路径提取逻辑重复（usePanesStore.ts:43, App.tsx:143, SessionCleanerPanel.tsx:28, ScanImportDialog.tsx:22）
**A-L5.** [src/services/workspaceService.ts] 命名导出风格与其他服务不一致（其他用对象导出）
**A-L6.** [src/components/WorktreeManager.tsx:65, WorkspaceTree.tsx:163,185, GeneralSection.tsx:36,57] 使用 window.confirm 原生对话框
**A-L7.** [src/hooks/useTauriEvent.ts] 整个 hook 未被使用 -- dead code
**A-L8.** [src/stores/index.ts:13-21] 导出了非 store 相关的工具函数（parseKeyEvent 等）
**A-L9.** [src/components/panes/Panel.tsx:184] 空状态 "Cmd+K to search" 功能未实现
**A-L10.** [src/components/settings/AboutSection.tsx:11] 版本号 "0.1.0" 硬编码
**A-L11.** [src/components/panes/TerminalView.tsx:207-217] 用 setTimeout(500) 等待 shell 就绪
**A-L12.** [src/components/Sidebar.tsx:88-95] 直接操作 DOM style 实现 hover 效果
**A-L13.** [src/stores/useBorderlessStore.ts + useMiniModeStore + useFullscreenStore + useWindowControl] 直接调用 invoke 而非通过 service 层
**A-L14.** [src/components/panes/TabBar.tsx:136] WebkitAppRegion 类型断言

---

### 前端评审总结

| 级别 | 数量 | 主要问题领域 |
|------|------|-------------|
| Critical | 3 | useEffect 闭包陈旧、终端主题硬编码、ID 碰撞 |
| High | 8 | 过大组件(3个)、Props drilling、Store 设计、死代码 |
| Medium | 12 | 性能优化、事件监听效率、模块级副作用 |
| Low | 14 | 风格不一致、dead code、UI 原生对话框 |

**整体评价：良好（7/10）**
- 优点：无 any 类型逃逸、Zustand 划分合理、服务层封装清晰、immer 简化不可变更新
- 主要改进：组件拆分、Props drilling、终端主题响应、路径工具统一

---

## 评审报告 C：整体一致性 + TUI（已完成）

### Part 1: 前后端接口对齐结果

**总计 74 个前端 invoke 调用，全部在后端有对应实现。无缺失命令。**

**后端存在但前端未调用的命令（7个 dead code）：**
- `get_all_terminal_status` (terminal_commands.rs) -- 被事件机制替代
- `get_git_status` (git_commands.rs) -- 已定义未使用
- `git_pull/push/fetch/stash/stash_pop` (git_commands.rs) -- Git 操作命令未接入前端

**参数一致性：全部匹配。** Tauri 自动处理 camelCase -> snake_case 转换。

---

### Part 2: Tauri 配置评审

- **权限充分性**: OK -- dialog、notification、opener 权限均有实际功能使用
- **权限过度性**: 无过度声明
- **安全注意**: 后端通过 `std::process::Command` 直接执行 git/claude 命令，绕过了 Tauri shell 插件的安全沙箱
- **CSP 策略**: 合理，仅允许本地连接

---

### Part 3: 命名规范一致性

**关键发现：项目混用两种序列化风格**

- **camelCase rename 的结构体**（Settings/Provider/Terminal 系列）：前端 TS 接口使用 camelCase
- **无 rename 的结构体**（Project/History/Claude/Worktree/Workspace 等 19 个）：前端 TS 接口使用 snake_case

**前后端在数据传输上实际一致**（前端已适配），但两种风格共存增加维护成本。

**缺少 `serde(rename_all = "camelCase")` 的结构体清单（19个）：**
- Project, Workspace, WorkspaceProject, ScannedRepo (models/)
- ClaudeSession, BrokenSession, CleanResult (claude_commands.rs)
- LaunchRecord (history_repo.rs)
- JournalIndex (journal_service.rs)
- WorktreeInfo (worktree_service.rs)
- FileVersion, HistoryConfig, DiffLine, DiffHunk, DiffResult, LabelFileSnapshot, HistoryLabel, RecentChange, WorktreeRecentChange (models/history.rs)

---

### Part 4: cc-panes-tui 代码质量

#### High
- **[cc-panes-tui/Cargo.toml:23]** `tokio = { features = ["full"] }` 但从未启动 runtime，仅用 sync::mpsc | 修复: 改为 `features = ["sync"]` 或用 std::sync::mpsc
- **[cc-panes-tui/src/main.rs:136-137]** `std::env::set_var` 在 Rust 2024 edition 中为 unsafe | 修复: 通过函数参数或 OnceCell 传递
- **[cc-panes-tui/src/utils.rs:21-36]** 手动日期计算不考虑时区（使用 UTC） | 修复: 使用 chrono::Local::now()
- **[cc-panes-tui/src/pty.rs:82]** exit_code 的 u32->i32 可能溢出

#### Medium
- **[cc-panes-tui/src/claude.rs 整体]** 整个模块为死代码（被 PTY 方式替代），且第 6 行 `use std::os::windows::process::CommandExt` 未加 `#[cfg(windows)]`
- **[cc-panes-tui/src/git.rs:3]** `#![allow(dead_code)]` 抑制警告，`is_git_repo` 未使用
- **[cc-panes-tui/src/models/event.rs]** Event::Key/Resize/Tick 变体和 Action::Quit 均未使用
- **[cc-panes-tui/src/ipc.rs:47]** IPC 协议用 `find(':')` 切分，message 含冒号会被截断 | 修复: 用 `splitn(2, ':')`
- **[cc-panes-tui/src/app.rs:147-179]** 会话恢复对话框事件循环未抽取为独立方法

#### Low
- **[cc-panes-tui/src/terminal.rs:49]** 宽字符处理可能不正确
- **[cc-panes-tui/src/app.rs:444-454]** Ctrl 组合键只支持 A-Z
- **[cc-panes-tui/src/journal.rs:93-98]** 文件名解析用硬编码偏移
- **[cc-panes-tui/src/app.rs:524-560]** 剪贴板工具不可用时静默失败
- **[cc-panes-tui/src/main.rs:152]** `process::exit()` 跳过析构函数
- **[cc-panes-tui/src/main.rs:194]** `_port` 参数未使用

---

### Part 5: 配置文件一致性

- **版本号一致**: package.json、tauri.conf.json、两个 Cargo.toml 均为 "0.1.0"
- **共享依赖版本一致**: serde/serde_json/anyhow/portable-pty 版本对齐
- **建议**: 使用 `[workspace.dependencies]` 统一声明共享依赖

---

### 整体一致性评审总结

| 级别 | 数量 | 主要问题领域 |
|------|------|-------------|
| Critical | 0 | - |
| High | 4 | TUI tokio 依赖过重、env::set_var unsafe、日期时区、exit_code 溢出 |
| Medium | 7 | 命名风格混用、TUI dead code、IPC 协议、跨平台编译 |
| Low | 13 | 后端 dead code 命令、TUI 小问题、配置建议 |

---

---

# 三维评审汇总改进计划

## 全局统计

| 评审维度 | Critical | High | Medium | Low | 合计 |
|---------|----------|------|--------|-----|------|
| A: 前端 | 3 | 8 | 12 | 14 | 37 |
| B: 后端 | 5 | 8 | 11 | 10 | 34 |
| C: 一致性+TUI | 0 | 4 | 7 | 13 | 24 |
| **合计** | **8** | **20** | **30** | **37** | **95** |

---

## P0：安全问题、数据损失风险（2项）
- [ ] **B-C3**: clean_session_file 路径穿越 -- 可读写任意文件
- [ ] **B-C4**: migrate_data_dir 路径穿越 -- API Key 泄露风险

## P1：稳定性 + 架构缺陷（16项）
- [ ] **B-C1/C2/C5/H8**: Mutex unwrap / expect panic（db.rs, terminal_service, settings, provider, notification）
- [ ] **B-H7**: WorkspaceService::new expect panic
- [ ] **B-H1/H2/H3/H4**: 3 个命令模块绕过 Service 层 + claude/git 业务逻辑在 Command 层
- [ ] **B-H5**: ~37 个命令未迁移到 AppResult
- [ ] **A-C1**: TerminalView useEffect 闭包陈旧回调
- [ ] **A-C2**: 终端主题硬编码不响应全局主题切换
- [ ] **A-C3**: ID 生成器 Date.now() 碰撞风险
- [ ] **A-H1/H2/H3**: 3 个过大组件需拆分（WorkspaceTree 584行, LocalHistoryPanel 451行, TabBar 340行）
- [ ] **A-H4**: Sidebar props drilling
- [ ] **A-H7**: SplitContainer isResizing 死代码
- [ ] **C-H1**: TUI tokio full 依赖过重

## P2：代码质量、可维护性（30项）
- [ ] **B-H6**: PTY 资源清理不确定
- [ ] **B-M1**: filter_map(|r| r.ok()) 静默丢弃查询错误
- [ ] **B-M4**: 终端状态推断误报率高
- [ ] **B-M9**: Python hook 脚本硬编码
- [ ] **C**: 19 个结构体命名风格不统一（snake_case vs camelCase 混用）
- [ ] **C-TUI**: claude.rs 整个模块为死代码 + 跨平台编译问题
- [ ] **A-H5/H6/H8**: Store 设计问题（暴露内部状态、模块级副作用、跨职责耦合）
- [ ] **A-M6**: 全局事件监听器效率问题（N 终端 * N 监听器）
- [ ] 其余 Medium 级别问题

## P3：风格统一、文档完善（37项）
- [ ] **B-M5/M7**: &PathBuf -> &Path
- [ ] **A-L4**: 路径提取逻辑重复，应统一使用 utils/path.ts
- [ ] **A-L5**: workspaceService 导出风格不一致
- [ ] **A-L6**: window.confirm 原生对话框
- [ ] **A-L7**: useTauriEvent 整个 hook 未使用
- [ ] **A-L13**: 窗口控制 store 直接调用 invoke 而非 service 层
- [ ] **C**: 7 个后端命令 dead code
- [ ] 其余 Low 级别问题
