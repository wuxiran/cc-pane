# 交叉评审：daemon 事件桥 + scrollback 落盘 + 两个衍生修复

你是**只读评审者**。不要修改任何文件、不要跑 `cargo build/test`（宿主正在编译，会抢锁）。
只读代码 + 给结论。工作目录：`D:\04_workspace_rust\cc-book`（WSL 下为 `/mnt/d/04_workspace_rust/cc-book`）。

## 背景（已确认的事故）

用户报告：重启后会话能恢复，但终端全空白、没有 resume 历史。

已定位两条链在「PTY 托管到 cc-panes-daemon 独立进程」之后静默断掉：

1. **resume id 捕获链**。`terminal-resume-id-detected` 由 `cc-panes-core/src/services/terminal_service.rs:2117`
   （claude 发号 `--session-id`）与 `terminal_service/osc_resume_capture.rs:302`（codex OSC 标题）emit。
   daemon 模式下这些代码跑在 daemon 进程，事件进 `cc-panes-daemon/src/ws_emitter.rs` 的
   `EventEmitter::emit`，那里只 match output/exit/killed，其余落 `_ => {}` 被丢。
   桌面侧 `src-tauri/src/lib.rs:1982` 的监听器因此收不到，`bind_resume_id` 一次没跑过。
   数据佐证：`launch_history.resume_session_id` 在 7-25 前 claude 覆盖率 ~100%（28 次中 20 次），
   7-26 起连续 5 天 48 次启动 **0 次**捕获。

2. **scrollback 落盘**。`src-tauri/src/lib.rs:2784` 退出时调
   `terminal_cleanup.get_all_session_outputs()`，读的是 app 进程内 `TerminalService.sessions`
   + `dead_buffers`，daemon 模式下恒为空。`~/.cc-panes/sessions/*.output` 最新文件停在 6-27。

3. 同类第三处：`terminal-launch-warning`（profile 回落 / codex resume 目标缺失）同样被丢，
   且它的 `profileMismatch` 载荷**没有 sessionId**，在 `emit` 开头的 sessionId 守卫就被吞。

## 已做的修改（请重点评审）

- `cc-panes-daemon/src/ws_emitter.rs`
  - `terminal-launch-warning` 提到 sessionId 守卫**之前**处理，发上 control 通道
  - 新增 `terminal-resume-id-detected` arm → control 通道，载荷原样透传
  - `terminal-exit` 时调 `persist_session_output(session_id)`
  - 新增 `output_store: Arc<RwLock<Option<Arc<SessionOutputStore>>>>` + `set_output_store`
- `cc-panes-daemon/src/session_output_store.rs`（新文件）：持 `Weak<TerminalService>`（避免与
  `set_emitter` 成环）+ `Arc<AppPaths>`，`persist_session` / `persist_all`
- `cc-panes-daemon/src/main.rs`：构造/注入 store，axum serve 返回后 `persist_all()`
- `cc-panes-core/src/services/session_restore_service.rs`：落盘逻辑抽成自由函数
  `write_session_output(&AppPaths, ..)`（daemon 没有 DB 句柄，不能用 `SessionRestoreService`），
  原方法改为委托
- `src-tauri/src/services/terminal_daemon_control_link.rs`：新增 `resumeIdDetected` /
  `launchWarning` 两种控制消息 → 转成同名 Tauri 事件
- `src-tauri/src/services/terminal_backend_state.rs`：3 条 clippy `unneeded return`（纯机械）

## 请你判断的具体问题

1. **载荷契约**：daemon 发的 `{"type":"resumeIdDetected","payload":{...}}` 里 payload 的字段名，
   与 `src-tauri/src/services/resume_binding_service.rs` 的 `ResumeIdDetectedPayload`
   （`#[serde(rename_all="camelCase")]`）是否完全对得上？漏一个必填字段就会整条静默失败。
   同样检查 `launchWarning` 与 `web/hooks/useLaunchWarnings.ts` 的载荷契约。
2. **`emit` 里做同步文件 IO 是否可接受**：`persist_session_output` 跑在 PTY reader 线程上，
   会不会阻塞输出流 / 造成死锁（注意 store 持 Weak，`upgrade()` 后调
   `TerminalService::get_all_session_outputs()`，那个函数会锁 `sessions` 与 `dead_buffers`；
   而 emit 的调用点本身可能已持有某些锁——请查 `terminal_service.rs` 里 emit 的调用上下文）。
3. **落盘时机是否有遗漏**：daemon 被强杀（SIGKILL / taskkill /F）时 `persist_all()` 不会跑。
   是否需要周期性快照？代价与收益怎么权衡？
4. **`webview_emits_allowed()` 门禁**：control link 的 emit 被这个开关挡着（WebView 自愈期间为 false）。
   resume id 这类身份事件在那个窗口期会被丢，是否应该绕过门禁？
5. 有没有**第四处**同类缺口是我漏掉的（我只按 `cc-panes-core` 里 7 类 emit 事件核对过）。

## 另外两个待修缺口（我正在改，也请你评估修法）

- **A. `/api/launch-task`（REST，ctl 与外部客户端走这条）不写 `launch_history` 行**。
  实测：ctl launch 起的会话，`bind_resume_id` 报 `launch_id=None; no launch_history row matched`，
  DB 无行。MCP 进程内路径 `orchestrator_service.rs:4614` 会写，UI 路径会写，只有 REST 这条不写。
  后果：这么起的会话永远无法 resume。
  请判断：应该在 `handle_launch_task`（约 8500 行）里补 `add_with_pty_session`，
  还是等前端 `orchestrator-launch-task` 事件回流时写？两种写法的竞态与重复行风险各是什么？
- **B. `uninstall_cleanup_service.rs` 删掉了 `DefaultSkillService::cleanup_injected`**。
  配合 skill 改为按会话挂载（`CliAdapterContext.skill_mount_paths`，不再写客户 Home）是自洽的，
  但**老版本已注入到用户 Home 的残留从此没人清**。请判断是否应保留一次性清理。

## 交付

读完后用 `mcp__ccpanes__report_to_leader` 上报，内容：
- 上面 5 个问题逐条结论（有问题请给出文件:行号）
- A/B 两个缺口的建议修法
- 你发现的任何其他阻断发版的问题
不要改代码。
