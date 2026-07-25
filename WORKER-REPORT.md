# 0112 Reliability Worker Report

## 完成情况

- 状态：IMPLEMENTED，Part A / Part B 均已完成并分别提交。
- 工作树/分支：`/mnt/d/04_workspace_rust/cc-book-wt-reliability` / `0112-reliability`。
- 未修改两份 plan，未触碰 `TerminalView`，无前端改动，未 push。
- 本单未修改 `cc-panes-core`；因此 leader **不需要因本单重建 daemon 二进制**。根因核证读取了 core daemon client，但修复位于 Tauri bridge 侧。

## Part A：WebView2 ProcessFailed 通道核证

实际接入通道如下：

1. Tauri setup 在 `src-tauri/src/lib.rs:1695` 为主窗口安装 handler。
2. Windows 实现在 `src-tauri/src/webview_reliability.rs:179-231`：`WebviewWindow::with_webview`（188）取得 wry WebView，`controller().CoreWebView2()`（190），再调用 `ICoreWebView2::add_ProcessFailed`（208）。这是 Tauri 2.11.0 / wry 可用的原生 WebView2 COM 通道。
3. ProcessFailed kind 的原始值映射在 `src-tauri/src/webview_reliability.rs:27-55`；回调分派在 193-204。
4. `BrowserProcessExited` 的一次性恢复状态机在 `src-tauri/src/webview_reliability.rs:59-117`；主窗口 destroy/rebuild 与重装 handler 在 235-268；10 秒 watchdog 在 272-293。
5. crash marker 在 `src-tauri/src/webview_reliability.rs:152-175`，包含 kind、action、detected/decided 毫秒时间线；正常自裁使用 `app_handle.exit(70)`。
6. 重建期间 `RunEvent::ExitRequested` 被 `prevent_exit()` 托住，见 `src-tauri/src/lib.rs:2509-2513`；正常退出仍进入 `RunEvent::Exit`。
7. 单实例锁释放已核证到已锁定依赖 `tauri-plugin-single-instance 2.4.2`：其 Windows `on_event(RunEvent::Exit)` 调 `destroy`，随后 `ReleaseMutex + CloseHandle`（cargo registry `platform_impl/windows.rs:111-124`）。因此 `app.exit(70)` 会走释放锁的正常退出路径，而不是留下无头持锁进程。
8. WebView 失效后 emit 止血覆盖主要通道：`src-tauri/src/emitter.rs:20-26,94-102`、`src-tauri/src/services/terminal_daemon_event_bridge.rs:157-161`、`src-tauri/src/services/terminal_daemon_control_link.rs:46-52`。

### 自愈 / 自裁触发条件

| 触发条件 | 动作 | 最终结果 |
|---|---|---|
| 首次 `BrowserProcessExited`，状态为 Ready | 立即暂停 WebView emit；只尝试一次主窗口重建；重建期间阻止最后窗口触发退出 | 成功则恢复 emit 与 UI，daemon 会话保留 |
| 重建进行中再次收到 browser failure | Ignore，不并发启动第二次重建 | 保持单次重建上限 |
| 已成功重建后再次 `BrowserProcessExited` | 写 crash marker，`app.exit(70)` | 正常退出并释放单实例锁 |
| 主窗口重建失败、超过 10 秒或超时后才完成 | 写 crash marker，`app.exit(70)` | 不允许无头僵尸继续运行 |
| `RenderProcessExited` | 先 reload renderer | reload 成功则继续运行 |
| renderer reload 失败且 browser 重建额度未用 | 升级为同一份主窗口重建额度 | 成功恢复；失败/超时则自裁 |
| renderer reload 失败且重建额度已耗尽 | 写 crash marker，`app.exit(70)` | 正常退出 |
| `RenderProcessUnresponsive` 或未知 kind | 限量 warn，暂不做破坏性恢复 | 保持运行，避免误杀 |
| ProcessFailed handler 注册失败 | 写 `handler-registration-failed` marker，`app.exit(70)` | 避免以无保护状态继续运行 |

## Part B：10055 根因定性与修复

### 根因

源码核证结论：**不是单 session WebSocket 句柄无限泄漏，而是 WebSocket 失败后 100ms polling fallback 造成的短 TCP 连接 churn。**

- pre-fix `run_session` 每个 session 只调用一次 `stream_session`，失败后永久进入 polling；`SessionBridgeState.started` 也阻止同 session 并发重复 bridge。当前对应 guard 仍在 `src-tauri/src/services/terminal_daemon_event_bridge.rs:109-138`。
- 持续消耗来自 pre-fix `poll_session`：每 100ms 分别请求 replay snapshot 与 status。
- 每次请求都会在 `cc-panes-core/src/services/daemon_client.rs:348-388` 新建 `TcpStream`，并发送 `Connection: close`（369）。错误/完成路径依赖 RAII 关闭 socket，没有发现旧 WebSocket 后台重试叠加或遗留持有者。
- 31 会话最坏速率为 `31 * 10 tick/s * 2 request = 620` 个短 TCP 连接/秒；持续 TIME_WAIT / 非分页池压力与两天后的 WSAENOBUFS 10055 更吻合。

### 修复

- `src-tauri/src/services/terminal_daemon_bridge_reliability.rs:31-49`：最多 3 次连接，3 秒 connect timeout，250ms -> 500ms 指数退避，1 秒封顶。
- `src-tauri/src/services/terminal_daemon_bridge_reliability.rs:69-105,162-220`：全局 semaphore 限制同时握手为 4；RAII guard 在成功、错误、timeout/cancel 路径都释放 active slot。
- `src-tauri/src/services/terminal_daemon_event_bridge.rs:164-218`：重试用尽或已连接 stream 出错后单向进入 polling；同一 bridge 生命周期不再启动 WS 探活。
- `src-tauri/src/services/terminal_daemon_bridge_reliability.rs:10-19,244-265` 与 event bridge 330-358：fallback 改为每秒一次 snapshot、每 5 tick 一次 status，并使用 `MissedTickBehavior::Skip` 防慢请求后 burst 追赶。31 会话理论降为 `31 * 1.2 = 37.2` 个短连接/秒，约减少 94%。
- 健康 WebSocket 的兜底 status 检查由 500ms 降为 5 秒，见 `src-tauri/src/services/terminal_daemon_event_bridge.rs:221-230`。
- `BridgeStats` 包含 tracked/connecting/websocket/polling sessions、attempts/failures/fallbacks、active/max concurrent connects，定义于 `src-tauri/src/services/terminal_daemon_bridge_reliability.rs:267-279`；`get_bridge_stats` 命令位于 `src-tauri/src/commands/terminal_commands.rs:196-203`，注册于 `src-tauri/src/lib.rs:2156`。

## 验证结果

### 明确通过

- TDD RED：新增 bridge 契约首次聚焦编译按预期失败（缺少 retry policy、telemetry、poll schedule）。
- Part A 状态机测试：4/4 通过。
- Part A 既有 terminal bridge 聚焦测试：9/9 通过。
- Part B reliability 新测试：7/7 通过，覆盖重试上限、失败/成功 mock 序列、指数退避封顶、并发握手上限、timeout 释放、poll 分频、BridgeStats。
- terminal-daemon 相关聚焦测试：20/20 通过。
- `cargo clippy -p cc-panes --lib -- -D warnings`：通过。
- `cargo clippy --workspace -- -D warnings`：退出码 0，通过（35.26s）。
- `cargo fmt --all -- --check`：退出码 0，通过。
- `git diff --check`：通过。
- 最小临时 Windows-target crate 验证 WebView2 ProcessFailed handler 与窗口重建 API 类型链：通过。

### 限制 / 未宣称通过

- `cargo test --workspace` 按纪律只执行一次。命令完成了 workspace 编译并进入各 test binary，但工具等待会话提前丢失，最终汇总与退出码未捕获；**不宣称全量测试通过，也不重跑**。可见阶段只有 `cc-cli-adapters` 3 个既有 dead-code warning，随后 runner integration 与 `cc-panes-web` test binary 均已运行，最终 cargo 进程退出。
- 完整项目 Windows 交叉 check 受当前 WSL 环境缺少 MSVC `lib.exe` 阻塞，失败点在 ring/libsqlite C build script，并非已观察到的项目 Rust 源码错误。
- 尚未在 Windows host 验证真实 WebView2 crash/rebuild、单实例锁释放、WebView2 子进程与 31-session 长稳行为；这些不能由 WSL 单测替代。
- Part A 临时验证目录：`/tmp/ccpanes-webview-check.UyasPj`；共享独立 target：`/tmp/cc-panes-0112-target`。

## 31 会话 / 24h 长稳验证方案（leader / Windows host）

1. 在同一台 Windows 主机、同一 release 构建上建立 31 个 daemon terminal 会话；记录 CC-Panes PID 与 daemon 监听端口。先跑旧版基线，再跑本分支构建，工作负载与采样周期保持一致。
2. 每 60 秒采样一次、持续 24 小时：
   - `Get-NetTCPConnection -OwningProcess <cc-panes-pid> | Group-Object State`：按进程观察 ESTABLISHED/CLOSE_WAIT 数量。
   - 按 daemon port 过滤 `Get-NetTCPConnection`：统计包含 PID 已归零的 TIME_WAIT，避免 Windows TIME_WAIT 无法可靠归属原进程的问题。
   - `Get-Process -Id <cc-panes-pid> | Select-Object HandleCount,PM,NPM,CPU`：观察句柄、私有内存与非分页池相关趋势。
   - 每 5 分钟调用 `get_bridge_stats`，记录各 mode、attempts/failures/fallbacks 与 active/max concurrent connects。
   - 收集 `cc-panes.log` 中 10055、ProcessFailed、crash marker、fallback 计数。
3. 通过标准：`activeConnects <= 4`、`maxConcurrentConnects <= 4`；tracked sessions 的 mode 总和一致；socket/TIME_WAIT/HandleCount/NPM 在热身后形成平台而非单调增长；24h 内无新增 10055、无 emit 洪水、无无头主进程。
4. 故障注入：分别终止 renderer 与 browser WebView2 子进程。确认 renderer reload；首次 browser failure 只重建一次；重建失败/二次 browser failure 后进程退出且立即可重新启动，不再出现 `second launch blocked`。

## 提交

- Part A：`01ca4d8be26374c2b189e0652dee7be6b64e5e1d` `fix: recover from WebView2 process failures`
- Part B：`a1eb8186f81fafe85b3c721198065fd0790f09ff` `fix: bound terminal daemon bridge connections`

本报告按指令保持未提交，不创建第三个 commit。

## 补单：句柄继承修复

### 修改内容

- 保留补单预置的两条 TDD 测试，新增 `bind_non_inheritable_listener(SocketAddr)` 并让 orchestrator 唯一生产 bind 点 `bind_fixed_port` 使用该 helper。
- Windows 分支使用 `socket2::Socket::new`；当前锁定的 `socket2 0.6.2` 在 Windows 内部通过 `WSASocketW` 同时设置 `WSA_FLAG_OVERLAPPED | WSA_FLAG_NO_HANDLE_INHERIT`，从 socket 创建时即关闭继承，不存在 bind 后再清 flag 的竞态窗口。非 Windows 分支使用 `std::net::TcpListener::bind`，设 nonblocking 后转 Tokio listener。
- 核证 `cc-panes-web`：无 daemon manifest 时会创建 `InProcessTerminalBackend`，`POST /api/sessions` 最终进入 `TerminalService::create_session -> spawn_pty`，因此 Web listener 同样可能被其后启动的长寿命 PTY 继承。已将 `cc-panes-web/src/main.rs` 的唯一生产 bind 点换为同语义 helper。
- `src-tauri/Cargo.toml` 与 `cc-panes-web/Cargo.toml` 只在 Windows target 下新增已锁定的 `socket2 = "0.6"` 直接依赖，并同步 `Cargo.lock`。未修改 plan、前端、`cc-panes-daemon` 或其 listener。

### bind 点与 spawn 路径核证

- 桌面 orchestrator：生产 listener 只有 `orchestrator_service.rs` 的 `bind_fixed_port` 一处；同文件另一个 `std::net::TcpListener::bind` 是测试 server，不改。
- 桌面内置 PTY：`TerminalService::create_session` 在 orchestrator 启动后可调用 `cc_panes_core::pty::spawn_pty`，是确定的长寿命子进程继承路径；新 helper 从句柄创建时阻断继承。
- 桌面 Web 子进程：启动阶段的 daemon/Web lifecycle 位于 orchestrator 之前，初次启动不会继承尚未创建的 orchestrator listener；但 `start_web_access` / `restart_web_access` 可在运行期再次 spawn `cc-panes-web`，因此同样受 orchestrator listener 的 non-inherit 修复保护。
- terminal daemon：当前 `TerminalDaemonLifecycle::connect_or_start` 只在启动阶段、orchestrator 创建前 spawn；且补单硬约束明确不动 daemon 二进制，故未修改 `cc-panes-daemon/src/main.rs` 的 listener。
- 独立 Web 服务：在 in-process fallback 下自身会在 listener 建立后 spawn PTY，因此一并替换其生产 bind；测试 listener 保持原样。

### 验证结果

- TDD RED：`cargo test -p cc-panes --lib -- orchestrator_listener` 首次按预期编译失败，缺少 `bind_non_inheritable_listener`。
- TDD GREEN：同命令退出码 0，WSL 可运行的 `orchestrator_listener_releases_fixed_port_after_drop` 1/1 通过，238 个测试被过滤；Windows-only 句柄断言在 WSL 不运行。
- `cargo clippy -p cc-panes --lib -- -D warnings`：退出码 0，通过。
- `cargo fmt --all -- --check`：退出码 0，通过。
- `cargo check -p cc-panes-web`：退出码 0，通过（覆盖新增 Web bind 调用点的当前平台编译）。
- `git diff --check`：退出码 0，通过。
- 完整 `cargo check -p cc-panes --lib --target x86_64-pc-windows-msvc`：按预期受 WSL 缺少 MSVC `lib.exe` 阻塞，停止在第三方 `ring 0.17.14` build script，尚未到达项目源码；不宣称完整 Windows target 通过。
- 最小临时 Windows-target crate 使用相同 `socket2` helper，并包含 `GetHandleInformation` / `HANDLE_FLAG_INHERIT` 断言；`cargo check --tests --target x86_64-pc-windows-msvc` 退出码 0，Windows helper 与测试类型链通过。临时目录已删除。
- 未跑全量测试；尚未在 Windows host 实测父进程退出后 47821 端口释放与真实子进程句柄表，这两项仍需 Windows host 验证。

本补单明确要求新增一个 fix commit；该要求覆盖上一段针对原 Part A / Part B 的“不创建第三个 commit”说明。
