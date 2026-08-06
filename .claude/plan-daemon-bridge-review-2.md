# 交叉评审 2：daemon 身份/副作用桥（6/7/8）+ 基线错位评估

你是**只读评审者**。不修改任何文件、不运行 `cargo build/test`（宿主在编译，会抢锁）。
仓库：`D:\04_workspace_rust\cc-book`（WSL 下 `/mnt/d/04_workspace_rust/cc-book`）。

## 待评审的两个提交

```
8a77e49  fix(daemon): 补齐 daemon 边界上被静默丢弃的三条链
dd6e1b4  fix(daemon): 身份事件可持久投递 + notifier 桥(评审 6/7/8)
```

`git show 8a77e49`、`git show dd6e1b4` 看全量 diff。第一轮评审（你上次给的结论）已按
1-5+9 修完并合进这两个提交；本轮请重点看 dd6e1b4 引入的新机制。

### dd6e1b4 做了什么

- **6（control 无重放）**：daemon 侧按 session 留存身份事件（`ws_emitter.rs`
  `IdentityEventStore`，上限 1024 保序淘汰），新增只读端点
  `GET /api/sessions/identity`（`identity_routes.rs`）；桌面 control link 每次
  （重）连后调 `list_identity_events()` 补拉并逐条 `bind_resume_id`。
- **7（WebView 门禁）**：control 消息按处置方式分流为 `ControlAction`：
  `Emit`（受 `webview_emits_allowed()` 门禁，sessionKilled / launchWarning）
  vs `BindResume`（直接落库，完全不经 WebView）vs `Notify`。
- **8（NoopNotifier）**：新增 `ControlSessionNotifier` 把
  `notify_waiting_input` / `notify_session_exited` / `cleanup_session` 经 control
  转发；桌面把已有的 `CcChanSessionNotifier` 托管进 Tauri state 供 control link 复用。

### 请判断

1. **补拉的幂等性**：`bind_resume_id` 会被同一条 resume id 重复应用（live 一次 +
   每次重连补拉一次）。`should_replace_source` / "已绑定到另一条记录" 的分支在重复
   应用下是否真的无副作用？会不会刷 launch_history 的 `resume_source` 或误报？
2. **留存的生命周期**：`IdentityEventStore` 只增不删（除了越界淘汰），会话 kill 后
   条目仍在，daemon 长跑下每次重连都会重放全部历史条目。是否需要在会话消亡时清理？
   1024 条的重放成本（每条一个 `tauri::async_runtime::spawn` + DB 查询）可接受吗？
3. **notifier 去重**：hook 通道（`apply_hook_status`）与 PTY 推断现在都能驱动桌面
   notifier。会不会对同一会话重复通知（系统通知弹两次 / CCChan 播两次）？
   `notify_session_exited` 与 daemon event bridge 合成的 `terminal-exit`
   （`terminal_daemon_event_bridge.rs:451-471`）是否会双触发 last_prompt 回填？
4. **notifier 事件顺序**：control 是单一广播流，`sessionExited` 与 `cleanup` 紧邻
   发出（实测确实如此）。桌面侧 `cleanup_session` 会不会在 `notify_session_exited`
   的异步工作完成前把状态清掉？
5. **`try_state` 时序**：control link 在 `lib.rs:1827` 附近就启动，而 notifier 的
   `app.manage()` 在 1960 附近才执行。启动早期到达的 notifier 事件会拿不到 state
   而被丢（当前是 debug 日志后返回）。这个窗口要紧吗？
6. 其他你认为阻断发版的问题。

## 另一件事：基线错位（请一并评估）

本分支 `fix/cli-resolution-and-schema-drift` 分叉于 `20fc2fe`，**不包含已发布的
v0.11.4 / v0.11.5 / v0.11.6**（这三个 tag 也不在 `main` 上，发布线是
`release/v0.11.6` 分支）。用户实际安装的就是 0.11.6。

已确认在 v0.11.6 上三个缺口原样存在（`ws_emitter.rs` 仍 `_ => {}`、daemon 仍
`NoopNotifier`、`lib.rs` 退出仍读 `get_all_session_outputs()`），所以本修复不冗余。

但 v0.11.5（`9d2d130 fix(terminal): restore conversations across app restarts`）
大改了 `cc-panes-daemon/src/server.rs`（+352 行）、`terminal_backend.rs`、
`terminal_commands.rs`、`app_paths.rs`、`settings_service.rs`。

**请评估**：把 8a77e49 + dd6e1b4 移植到 `release/v0.11.6` 之上，
- 哪些文件会真冲突？（重点 `cc-panes-daemon/src/server.rs` 的路由表与
  `DaemonConfig`、`cc-panes-core/src/services/daemon_client.rs`、
  `src-tauri/src/lib.rs` 的启动顺序）
- v0.11.5 的原子认领/claim 改动会不会与本次的身份补拉在语义上打架？
- 移植顺序建议（cherry-pick 两个提交？还是在 v0.11.6 上重做？）

另：本分支还有一个提交 `c4f6f26 feat: CLI 解析与 schema 漂移修复批`，是工作树
未提交改动的整体归档，其中 settings 迁移（auto_adopt 默认开启）与恢复诊断事件
**与 v0.11.5 已发布内容明显重叠**。请判断这批是否应该整体作废、只挑出未重叠部分
（WSL 原生 hook sidecar、skill 按会话挂载、cli-adapters 拆分、行数棘轮）。

## 交付

`mcp__ccpanes__report_to_leader` 上报：上面 6 条逐条结论（给 文件:行号）+ 移植方案
建议 + c4f6f26 的处置建议。不要改代码。
