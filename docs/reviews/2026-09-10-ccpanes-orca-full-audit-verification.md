# 对 `2026-09-10-ccpanes-orca-full-audit.md` 的对证审阅

- 对证日期：2026-09-10
- 被审文档：`docs/reviews/2026-09-10-ccpanes-orca-full-audit.md`
- 对证树：`D:\04_workspace_rust\cc-book`，`dev/v0.12.17` / `eb35eae9522b516626f36d4530e2ae2a0f2a5fd0`，包版本 `0.12.17`
- Orca：`D:\04_workspace_rust\references\orca` / `f7137395`（与原文一致）
- 性质：只读对证。不修改产品代码；本文件是对原审计的事实核对，不是第二份全量模块审阅。

## 结论

原文档的**机制判断大体正确**，Orca 对照路径也基本还在，可以作为问题地图和路线图。

不能把每一条都当成「已证实的生产事故」。若干条目把架构缺口写成了静默丢数据、全窗口卡死或几十 GB 内存；基线 SHA 写错；有几条建议在当前树里已经落地。

WebGL「没有足够证据称根治」这一句同意。卡顿主因更像背压不完整、粗锁、同步 polling、无全局预算叠加，而不是再拧一个 xterm 旋钮——这条主结论成立。

## 基线

| 原文档 | 对证结果 |
|---|---|
| `dev/v0.12.16` / `4922530e` / `0.12.16` | `4922530e` 是当天 **开始** v0.12.16 开发的 chore，不是发布点。当前 HEAD 是 `dev/v0.12.17` / `eb35eae9`，`package.json` / 根 `Cargo.lock` 为 `0.12.16` 之后的 `0.12.17`。 |
| 覆盖矩阵文件数 | 多数仍准：`web/lib` 72、`web/types` 45、`web/i18n` 44、`cc-panes-core/src` 189、`cc-panes-daemon/src` 9、`cc-panes-web/src` 48、`cc-panes-api/src` 3。`web/components` 879→885，`web/services` 148→150，`web/stores` 180→182，`web/hooks` 81→83，`src-tauri/src` 115→118，`cc-cli-adapters/src` 13→14。 |
| 大文件行数 | `server.rs` 3139、`db.rs` 2003 完全对上。`orchestrator_service.rs` 18792→18798，`terminal_service.rs` 8847→8850，`lib.rs` 3647→3693，`cc-cli-adapters/src/lib.rs` 2591→2600。 |
| Orca `f7137395` | 对，就是现在的 detached HEAD。 |

行号大多还能对上，说明原文审的是接近 0.12.16 发布 / 0.12.17 开头的树，不是 `4922530e` 那个空起点。原文 SHA 应改成当时的真实 `HEAD`（例如 `803c3895` 或本对证用的 `eb35eae9`）。

判定用语：

- **成立**：代码行为与描述一致，严重度也站得住。
- **过述**：机制对，但「静默 / 不可恢复 / 全卡 / 几十 GB」推得过远。
- **证据有误**：路径、库、或「代码里已经有的防护」写错了。
- **建议已落地**：原文当缺口写，当前树已经有对应实现。

## P0 / P1

### P0-1 SSH 输出流控是有损的 — 机制成立，丢失语义过述

证据行号 `terminal_output_flow.rs:35-38`、`:50-61` 对。`OutputFlowGate::disabled()` 只给 SSH（`terminal_service.rs:3570-3574`）。本地/WSL 才 park。

队列满时不是静默丢：reader 先把字节推进 `ReplayBuffer`，再 `try_send`；满则 emit `TERMINAL_DESYNC`（`terminal_service.rs:4040-4057`）。daemon `WsEmitter` 满载也会打 desync。

「不可恢复的内容缺口」只在环形窗把那段也挤掉、或 desync 没到前端时成立。Stage-4 的 park 超时 desync 对 SSH 不跑（`park_if_paused` 直接 `NotParked`）。

Orca 对照少写了一句：Orca 的 SSH relay 会 `pause()` + credit（`pty.setDeliveryPaused`），不只本地 `node-pty.pause()`。原文拿 `pty-producer-flow-control.ts` 对比方向仍对，但不是「Orca 只停本地 PTY」。

### P1-1 daemon 创建持有全局写锁 — 成立，症状归因过述

`session_visibility.write()` 在 `server.rs:867` 拿到，一直持到 handler 返回（约 `:975`），跨过 `spawn_blocking` 和 45s 的 `DAEMON_CREATE_DEADLINE`。list / status / resize / write / kill / 新 WS upgrade 都要同一把锁。

WSL IO 已经在 blocking 池，Tokio worker 等的是锁，不是在 worker 上跑 WSL。已打开的 WS `handle_ws`、snapshot/output HTTP **不拿这把锁**，已有 pane 的输出流不必停。

把它说成「切后台后所有窗口一起卡」是因果跳跃。隐藏走 control 连接的 `hiddenSessions`，不走 create 写锁。

锁的释放点也不是原文写的 `:886-930`，timeout 路径仍持锁直到 `return Err`。

### P1-2 同步 daemon TCP 占用异步线程 — 对 web/polling 成立

`std::net::TcpStream` 在 `daemon_client.rs:765-770`（原文写 741 稍偏）。默认读超时 2s，create 60s，kill 15s。

`cc-panes-web` 的 100ms polling（`ws_handler.rs:141-165`）和多数 `routes/terminal.rs`（list/status/resize/write/snapshot/kill）直接在 async 任务上调同步 backend，没有 `spawn_blocking`。create/cancel 已经隔离。

桌面 `get_terminal_replay_snapshot` 是同步 Tauri command，不是同一类 Tokio worker 问题。polling 路径只在 web 使用 daemon manifest 时启用。

### P1-3 replay 没有全局内存预算 — 无进程级预算成立；数量级过述

前端 `terminalScrollback.ts:8-17`：200–100_000，默认 5_000。后端 `live_replay_max_bytes` = `max(8MB, rows×120)`。100k 行约 12MB/会话，**地板已经是 8MB**。另有 20MB 明文 `OutputBuffer`。没有进程级 cap。TOML 里的裸 `u32` 后端不按 100k clamp。

错误：

- `src-tauri/src/models/settings.rs:468` 不存在。字段在 `cc-panes-core/src/models/settings.rs:468`。
- `terminal_service.rs:4875-4904` 是 `get_all_session_outputs`（明文缓冲落盘），不是 replay 存储。

64 会话是几百 MB 到低 GB，不是「几十 GB」。也解释不了 `vmmemWSL`（那是 WSL VM 提交量）。

### P1-4 kill 与 wait 都可能 reap — 成立

`pty/mod.rs:202-215` kill 后 Unix `reap_child`（`:564-571`，`waitpid` + `WNOHANG`）。wait 线程在 `terminal_service.rs:4160-4169` 再 `process.wait()`，失败记 `-1`。`AtomicBool` 不转移 wait 所有权。行号只差 1。

### P1-5 裸 PID 清理 — Unix 成立；Windows 写漏了 Job Object

`taskkill /T /F /PID` 和 Unix `killpg` 确实没有 creation time / pidfd。Windows 结构体已经有 `job: Option<ProcessJob>`（`KILL_ON_JOB_CLOSE`，宿主暴毙清树）。docs/83 T6 还把它记成相对 Orca 的反超。显式 `kill()` 仍走 PID，PID 复用风险在，不能写成「只存了 pid」。

Orca 侧也没有 pidfd；Windows PTY 的 CreationDate 在 Orca 仍是 #10680 待办。原文引用 docs/83「先验身份再树杀」只能算部分（ancestry / `ps lstart`）。

### P1-6 WebGL 共享 atlas / visibility 竞态 — 路径成立，当作已证 bug 过述

`terminalRendererController.ts:167-201` dispose + `loseContext`，`:203-225` 清共享 atlas 并广播，`:263-290` context-loss / atlas-change 刷新。`terminalRenderer.ts:242-281` Wayland / 无 identity / 软件渲染降 DOM。行号对。

缺 per-pane generation 是设计缺口，不是这几行能证明的黑屏。原文后半「未根治、要现场闭环」比标成 P1 更准确。

### P1-7 alternate screen 靠 marker — 架构差成立，恢复已比原文强

`terminalBufferMode.ts:296` 只是类型别名，不是恢复实现。`ReplayBuffer`（`terminal_service.rs:713`）确实是 raw VT 环。前端 `terminalReplayBufferMode.ts` 已在 marker 被挤掉时用 snapshot 上的 `bufferMode` 再灌 `1049h/l`。Orca 把 `snapshotAnsi` / `scrollbackAnsi` / `modes` / `rehydrateSequences` / tail 拆开仍是真差距。「1049h 一丢就空屏」过强。

### P1-8 OpenCode 配置超时不取消 worker — 成立

`opencode.rs:547-565` `std::thread::spawn`；`:582-595` 超时只 `cancelled.store`。标志在 `write_session_configs` **返回后**才看。无法打断阻塞 IO，无线程上限。

### P1-9 WebSocket 接收路径同步 backend — 成立

`ws_handler.rs:183-203` 主循环调 `handle_client_message`；`:227-241` 同步 `write`/`resize`；二进制 `:191-198` 同样。可进入 `TerminalDaemonClient` 的 2s `TcpStream`。一个慢 daemon 会卡住该连接的后续消息。

### P1-10 输入队列没有容量上限 — 成立

`terminalService.ts:243-270` 只 `pending.push`，无 byte/chunk cap。`:282-317` 上一批 `await writeTerminalInputNow` 完才冲下一批。

### P1-11 磁盘库失败切内存库 — 行为成立，「静默」过述

`src-tauri/src/lib.rs:1607-1622` 失败则 `Database::new_fallback()`。`db.rs:1154-1168` 是纯内存 SQLite。日志有 `error!(..., "trying in-memory fallback")`，UI 没有 `PersistenceDegraded`。生产上确实危险，但不是完全无痕。

## P2 / 第三轮

| ID | 判定 | 核对 |
|---|---|---|
| P2-1 WS send 结束后 recv 仍等 | 成立 | `server.rs:1633-1641` 分离；`send_task.abort()` 只在 recv 结束之后（`:1677`）。 |
| P2-2 退出落盘每会话一条线程 | 成立 | persist 在 `ws_emitter.rs:486`。实现是 **daemon** `session_output_store.rs:40-48`（不是 core），`sleep(500ms)` 后同步写盘。 |
| P2-3 polling prefix diff | 成立 | `replay_snapshot_delta` 用 `strip_prefix`；滚动窗挤掉前缀就 `Mismatch` → desync。 |
| P2-4 scrollback 与 Orca 不一致 | 成立 | CCP 200–100k；Orca `terminal-scrollback-policy.ts` 默认 5k、1k–50k、backlog `max(2MiB, rows×120)`。 |
| P2-5 Ctrl+wheel / TUI mouse | 部分过时 | 已有 `mouseTrackingMode`、`enable-mouse-events` CSS、`__ccPanesReplayedTerminalWheelEvent`。真耦合在 `useTerminalWheelZoom.ts:51-56`：`capture:true` 的 Ctrl+wheel 会 `preventDefault`。 |
| P2-6 recorder 缺 correlation | 缺 paneId/generation 成立 | `TerminalMetric` **已有** `session_id`。15s 采样、有界事件队列、context loss / atlas 字段都在。 |
| P2-7 Panel 订阅过宽 | 成立 | `Panel.tsx:53-58` 订 `rootPane`/`allPanels`/`layouts`；`:109`、`:116` 全树算 paneCount/tabNumbers。 |
| P2-8 hidden 全量扫描 | 成立，比原文更糟 | `useHiddenSessionReporter.ts:124` 订整个 panes store。`setHiddenTerminalOutputSessions` 在「同值跳过」**之前**就调用。 |
| P2-9 restore O(leaves × saved) | 成立 | `useTerminalSessionRestore.ts:211-217` 一次加载全部 saved；`:234-241` 每 leaf `saved.filter`。 |
| P2-10 单 SQLite Mutex | 主库成立，证据混库 | 主库 `db.rs:1104-1107` `Mutex<Connection>`，`busy_timeout=5000`。`history_file_repo` 是每项目 `history.db`，**不是**那把锁。不能拿它证明历史扫描卡住 session restore。 |
| P2-11 WS 无 max frame | 成立 | `ws_handler.rs` upgrade 未设 `max_message_size`/`max_frame_size`；整段文本 `serde_json::from_str`。 |
| P2-12 permissive CORS | 成立 | `routes/mod.rs:860` `CorsLayer::permissive()` 盖住 API、terminal WS、media WS。 |
| P2-13 target 14.92 GiB | 评论和脚本成立；数字是现场快照 | `Cargo.toml:18` 承认 debug 膨胀。真实 target 由 `scripts/cargo-target-dir.cjs` 解析，`.cargo/config.toml` 指到 `../cc-book-target`，不是 `src-tauri/target`。 |
| P2-14 两个 Cargo.lock | 成立 | 根锁 `name` 条目 921，`cc-panes` 现为 **0.12.17**（原文写 0.12.16）。`src-tauri/Cargo.lock` 527 条，`cc-panes` 仍是 `0.1.0`。 |
| P2-15 VT 查询回写放大 | 风险成立 | 7 个 parser handler（CPR×2、DA、Kitty、OSC 4/10/11）走 `source: "system"`，仍进同一输入队列，缺的是速率限制。不是完全绕开队列。 |
| P2-16 模块远超 800 行 | 成立 | 项目约定见 `AGENTS.md` / `CLAUDE.md`。行数见上文，相对 800 行差一个数量级。 |
| P3-1 发布矩阵不完整 | 成立 | `@xterm/xterm ^6.0.0`、`@xterm/addon-webgl ^0.19.0`、React 19、Vite 7。静态检查不能代替 Win32/WebView2/Wayland/SSH 组合验证。 |

## Orca 对照

下列原文引用在 `f7137395` 仍然存在，行号可用：

- `pty-producer-flow-control.ts:1-13`：HIGH/LOW 256KiB/32KiB，5s reassert
- `terminal-webgl-auto-policy.ts:74-120`：Linux Wayland / 无 renderer identity 禁用 WebGL
- `pane-webgl-renderer.ts:107-120` `loseContext`；`:151-175` 单 addon
- `terminal-snapshot.ts:4-19`、`terminal-snapshot-ansi-buffers.ts:3-20`、`terminal-mode-rehydrate-sequences.ts:8-46`
- `terminal-scrollback-policy.ts:1-41`
- `daemon-server.ts:1183-1200` 慢 snapshot ≥25ms
- daemon `Session.detachClient`：`attachedClients.length === 0` 时 resume producer

措辞偏差：mouse-wheel「runtime flag」在 Orca 里是 CSS class `enable-mouse-events`，另有 `mouseTrackingMode === 'none'`。docs/83「进程身份校验」没有 pidfd。

## 原文当缺口、当前树已经有的

1. 有界通道满发 desync，不是静默丢（P0-1 的「禁止静默丢」一半已做）。
2. Windows Job Object 宿主暴毙清树（P1-5）。
3. 前端 `bufferMode` 元数据 + 显式 `1049h` 重灌（P1-7）。
4. TUI wheel 的 mouse-reporting gate 和 replay 标记（P2-5）。
5. daemon create 的 WSL/PTY 已 `spawn_blocking`（锁的问题还在，worker 占死不是主因）。

## 仍建议按这个顺序做

证据硬、现在就能动手：

1. **P1-1** 把 `session_visibility` 收成短临界区：先登记 `Launching`，冷启动锁外执行。这是最硬的全局停顿点，最长 45s。
2. **P1-2 / P1-9** web 侧 daemon 调用统一 `spawn_blocking` 或异步 client；取消每连接 100ms 同步 snapshot 轮询。
3. **P1-10 + P2-15** 输入队列硬上限 + 查询类 reply 的 token bucket。
4. **P1-4 / P1-5** 单一 wait owner；Unix 用 starttime/pidfd，Windows 显式 kill 走 Job 而不是裸 `taskkill /PID`。
5. **P1-11** 生产禁止无提示内存库。
6. **P0-1** SSH 不要假装和本地一样；丢弃时带 seq/desync，replay 挤掉时承认 gap。完整 credit/spool 仍然值得做，但不是「现在就在静默丢不可恢复字节」。

P1-3 做全局 budget 有价值，但不要指望它单独解释 vmmemWSL。P1-6 继续要现场 JSONL 闭环，不要先大改 renderer。

## 原文最该改的三处

1. 基线 SHA：不要用 `4922530e`。
2. P0-1：删掉「静默 / 必然不可恢复」；写清 desync + ReplayBuffer 以及环形窗挤掉才丢史。
3. P1-1：不要把 create 写锁映射成「切后台全窗口卡」。
