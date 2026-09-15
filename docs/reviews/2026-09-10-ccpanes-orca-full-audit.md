# CC-Panes 0.12.16 全量模块与 Orca 对比审阅

审阅日期：2026-09-10；CC-Panes 基线：`dev/v0.12.16` / `4922530e`；版本 `0.12.16`。
对证日期：2026-09-12；对证树：`dev/v0.12.17` / `eb35eae9`。无效条目已折叠，详见 `docs/reviews/2026-09-10-ccpanes-orca-full-audit-verification.md`。

Orca 基线：`/mnt/d/04_workspace_rust/references/orca` / `f7137395`。
审阅性质：只读；本次只新增本报告，没有修改源代码、测试、锁文件或配置。

## 结论先行

当前版本已经有一批针对终端卡顿的防线：本地/WSL 输出 ACK 水位和生产者暂停、滚动 replay、WebGL context-loss 降级、共享 atlas 通知、JSONL 性能记录。这些机制能减少单次故障的影响，但还不能把“不卡死、不丢输出、不崩溃”作为已证明的结论。

最需要先处理的是四件事：

1. **P0：输出流控的 SSH 分支仍是有损降级。** 本地 PTY 能暂停生产者，SSH 只记账、不 park；超水位靠有界通道丢实时流并发 desync。环形窗再挤掉时才会丢史，不是静默、必然不可恢复。
2. **P1：daemon 的创建路径持有全局写锁。** WSL 冷启动、探活和 PTY 创建期间，其他 pane 的 list/status/resize/write/kill 和新 WS upgrade 会排队。已打开的输出流不走这把锁；不能用它解释“切后台后所有窗口一起卡”。
3. **P1：同步 daemon TCP 调用仍可进入 Tokio/IPC 边界。** 慢 daemon 的读超时可达秒级，叠加 100ms polling，会占用执行线程并放大尾延迟。
4. **P1：replay 缓冲只有单 session 上限，没有全局预算。** 每会话约 `max(8MB, scrollback * 120)`，另有 20MB 明文缓冲；缺进程级 cap。多 pane 是几百 MB 到低 GB，解释不了 `vmmemWSL`。

WebGL 的结论是：**目前不能称为根治**。代码已有 context-loss 检测、显式释放 context、atlas 重建和 DOM fallback；缺的是现场 JSONL 闭环，不是再把「共享 atlas 竞态」当 P1 事故。

对证后折叠（默认隐藏，点开可看原文）：P1-6 当作已证 WebGL 竞态、P1-7 1049h 淘汰即空屏、P2-5 runtime gate 未落地、P2-10 主库与 `history.db` 混锁、P2-13 `src-tauri/target` 14.92 GiB 当产品缺陷。

## 审阅范围与覆盖矩阵

本次先用 `rg --files` 建立全量文件清单，再沿终端生命周期、pane 隐藏/恢复、输出传输、PTY、IPC、渲染和性能记录关键调用链逐行核对。源码规模如下：

| 模块 | 文件数 | 审阅重点 | 覆盖结论 |
|---|---:|---|---|
| `web/components` | 879 | pane、TerminalView、renderer、visibility、mouse wheel、replay | 关键终端路径逐行审阅；其余 UI 组件完成清单审阅 |
| `web/services` | 148 | terminal service、API/IPC、性能记录 | 终端、API、性能相关服务逐行审阅 |
| `web/stores` | 180 | pane/session/settings 状态边界 | pane、session、settings 相关 store 逐行审阅 |
| `web/hooks` | 81 | 生命周期、可见性、快捷键、resize | 终端和 pane 生命周期 hooks 逐行审阅 |
| `web/lib` | 72 | scrollback、renderer、replay、输入辅助 | 终端相关纯模块逐行审阅 |
| `web/types` / `web/i18n` | 45 / 44 | 跨层契约、事件名、设置默认值 | 终端/性能字段和设置契约审阅 |
| `src-tauri/src` | 115 | command、IPC bridge、daemon、recorder、持久化 | 终端、性能、命令注册和错误边界逐行审阅 |
| `cc-panes-core/src` | 189 | terminal service、PTY、replay、输出流控、SSH/WSL | 关键调用链逐行审阅 |
| `cc-panes-daemon/src` | 9 | session registry、HTTP/WS、emitter、落盘 | 全量审阅 |
| `cc-panes-web/src` | 48 | Web API、WS handler、polling fallback | terminal routes/WS 全量审阅 |
| `cc-cli-adapters/src` | 13 | CLI 启动、配置临时目录、取消和超时 | adapter 超时/线程路径审阅 |
| `cc-panes-api/src` | 3 | HTTP/WS adapter | 接口边界和阻塞调用审阅 |
| `cc-memory/src` / `cc-memory-mcp/src` / `cc-notify/src` | 7 / 4 / 10 | 辅助服务、通知和持久化 | 依赖关系和终端通知边界审阅 |
| `cc-panes-ctl/src` / `cc-panes-cli-hook/src` | 10 / 13 | 进程启动、hook、跨平台桥接 | 启动边界、退出码和 WSL 兼容性审阅 |
| `cc-panes-mobile`（lib/test/scripts/android/ios） | 38 / 6 / 1 / 18 / 39 | 移动端终端/输入契约 | 与桌面终端共享协议的边界审阅 |

“每个模块”在这里表示每个 workspace crate 和 frontend 一级模块都已纳入清单与边界审阅；由于当前仓库约 2,000 个源码文件，报告把逐行证据集中在会造成卡死、崩溃、丢数据和内存爆炸的共享路径，没有把未命中的普通 UI 文件伪装成逐行深审。

## P0：必须先处理

### P0-1 SSH 输出流控是有损的

**证据：** `cc-panes-core/src/services/terminal_output_flow.rs:35-38` 明确说明 SSH 不 park，超水位依靠有界通道整段丢弃；同文件 `:50-61` 的高低水位和 failsafe 只保护能暂停 reader 的本地/WSL 路径。调用链是 `SSH reader -> OutputFlowGate::disabled -> bounded channel -> emitter`。

**影响：** SSH pane 在后台或 WebView 长任务时，实时流可能被有界通道丢掉。丢掉时会发 `TERMINAL_DESYNC`，字节已在 `ReplayBuffer`；只有环形窗也挤掉、或 desync 没到前端，才会变成真正的内容缺口。缺口若包含 TUI 状态切换、CSI 序列或 prompt，表现可能是花屏、滚动位置错乱或“看起来卡住”。

**建议：** 给 SSH transport 增加可协商的 per-channel credit/window；不能暂停共享 SSH 传输时，必须把数据落入有界磁盘 spool 或 per-session ring，并在丢弃时带 source range。desync 已经有，不要按“静默丢整段字节”来修。

**验证：** 让 SSH 会话连续输出 10 分钟并在前端隐藏/恢复；记录 source sequence、received sequence、desync 次数和最终 snapshot hash，要求无静默 gap。

**Orca 对照：** `orca/src/main/ipc/pty-producer-flow-control.ts:1-13` 在 PTY 生产端暂停并有 5 秒重断言；CC-Panes 对 SSH 的“只记账、不暂停”是行为差异，不是等价实现。

## P1：卡死、崩溃和大内存风险

### P1-1 daemon 创建持有全局写锁

**证据：** `cc-panes-daemon/src/server.rs:867` 获取 `session_visibility.write()`，直到 `:886-930` 完成 WSL 冷启动、探活、`spawn_blocking` 和最长 deadline 才释放；读路径 `:1010-1015`、`:1024-1029`、WebSocket upgrade `:1423-1437` 都要取得同一锁。

**风险：** 一个慢 WSL 启动会阻塞所有 pane 的 list/status/resize/write/kill/新 WS upgrade（最长约 45s）。锁虽然包住了部分“创建+claim”原子性，但临界区跨过 `spawn_blocking` 等待，属于全局停顿点。已打开的 WS 输出和 snapshot HTTP 不拿这把锁。

**建议：** 把锁拆成“session registry/claim/provenance”短锁和“单 session launch state”锁；先登记 `Launching`，锁外执行冷启动，完成后用 CAS 提交；同一 session 以 per-session future 去重，其他 session 不等待。

**验证：** 同时启动一个冷 WSL pane 和 20 个已有 pane 的 status/resize/write，记录 `lock_wait_ms` 和 p99；要求冷启动期间已有 pane 的 p99 不超过正常基线的 2 倍。

### P1-2 同步 daemon TCP 调用可能占用异步执行线程

**证据：** `cc-panes-core/src/services/daemon_client.rs:741-770` 使用同步 `std::net::TcpStream`，读超时由调用者传入；`cc-panes-web/src/ws_handler.rs:141-165` 在 100ms interval 中直接调用 `backend.get_session_replay_snapshot`。同类 terminal route 位于 `cc-panes-web/src/routes/terminal.rs:456-466`、`:527-557`、`:562-645`。

**风险：** daemon 不响应时，每个 polling WS 可能持有 Tokio worker 或 IPC 调用线程到秒级；多个后台 pane 会线性放大线程占用和尾延迟。

**建议：** 优先使用异步 HTTP/WS client；过渡期统一 `spawn_blocking`，加全局 semaphore、每 session 一个 polling task、指数退避和取消 token。禁止每个连接独立 100ms 无限轮询。

**验证：** 注入 daemon 2 秒读延迟和断连，开 32 个隐藏 pane，测 Tokio worker busy、poll 请求数、p95/p99 和恢复时间。

### P1-3 replay 没有全局内存预算

**证据：** `web/lib/terminalScrollback.ts:8-17` 允许 200–100,000 行；`cc-panes-core/src/services/terminal_service.rs:1379-1395`、`:3566-3568` 按 session 用 `max(8MB, rows×120)` 建 replay；`cc-panes-core/src/models/settings.rs:468` 仅保存裸 `u32`，后端没有进程级总量预算。

**风险：** 100,000 行约 12MB replay/会话，地板已是 8MB，另有 20MB 明文 `OutputBuffer`。多 pane 可到几百 MB～低 GB。没有全局 cap 是真缺口；“几十 GB / vmmemWSL”不成立。

**建议：** 后端强制 clamp 到 Orca 的 1,000–50,000 行范围；维护进程级 replay/output budget；按 session 活跃度做 weighted LRU，后台 pane 优先降级为磁盘/压缩 snapshot；暴露 `budget_used`, `budget_limit`, `evictions`。

**验证：** 1/8/32/64 个 session 分别设置最大 scrollback，输出固定 1GB，记录 RSS、匿名页、replay bytes 和 eviction；要求总预算硬上限可证明。

### P1-4 kill 路径和 wait 线程都可能回收 child

**证据：** `cc-panes-core/src/pty/mod.rs:202-215` kill 后调用 Unix `reap_child`；另一个 wait 线程在 `cc-panes-core/src/services/terminal_service.rs:4159-4169` 调用 `process_for_wait.wait()`。`reap_child` 实现见 `pty/mod.rs:564-571`。

**风险：** 两条路径竞争 `waitpid`，可能出现 `ECHILD`、错误退出码 `-1`、重复清理或退出通知顺序异常。`AtomicBool` 只能表示状态，不能把 wait 所有权转移给唯一 owner。

**建议：** 明确 child wait owner；kill 只发信号/关闭 job，最终退出和 reap 由唯一 wait task 完成；使用一次性状态机 `Running -> KillRequested -> Exited`，所有通知从状态机发出。

**验证：** 并发 kill、自然退出、daemon reaper 和窗口关闭 1,000 次，要求每个 session 恰好一条 terminal-exit，退出码不出现非预期 `-1`。

### P1-5 裸 PID/进程组清理存在 PID 复用误杀

**证据：** Unix 路径只按 pid/pgid 杀（`pty/mod.rs:520-553`）。Windows 显式 kill 仍是 `taskkill /T /F /PID`（`:493-517`），没有 creation time / pidfd。结构体已有 `job: Option<ProcessJob>`（`KILL_ON_JOB_CLOSE`），不是“只存了 pid”。

**风险：** 子进程退出后 PID 被复用时，延迟 kill 或 orphan-reaper 可能杀掉无关进程。强制 `/F` 还会放大数据损坏风险。Windows 宿主暴毙清树已经由 Job 覆盖。

**建议：** 显式 kill 也走 Job，不要只靠 `taskkill /PID`；Unix 使用 pidfd（不可用时校验 `/proc/<pid>/stat` starttime + pgid），kill 前再次确认身份。

**Orca 对照：** `docs/83-orca-gap-rescan-3.md:36` 记录 Orca 树杀前做 ancestry / `ps lstart`；没有 pidfd。CC-Panes Unix 路径仍是裸 PID。

<details>
<summary>P1-6 WebGL 恢复存在共享 atlas/visibility 竞态 — 对证无效（已隐藏）</summary>

对证：dispose / `loseContext` / 共享 atlas 广播 / Wayland+软件渲染降 DOM 已经存在。缺 generation 是设计缺口，不是这几行能证明的黑屏。WebGL「未根治」见文末专节，不按 P1 事故跟踪。

**原证据：** `web/components/panes/terminalRendererController.ts:167-201` 释放 addon 和 context，`:203-225` 清共享 texture atlas，`:263-290` 在 context loss 和 atlas 变化时触发刷新；`web/components/panes/terminalRenderer.ts:242-281` 按 Wayland、软件 renderer 和 identity 选择 DOM/WebGL。

**原风险：** context loss、pane 隐藏/重新可见、snapshot parsing 同时发生时，刷新可能落在 xterm paused-render gate 之前或之后；共享 atlas 清理会影响其他 pane。表现可能是黑屏、旧字形、恢复后不滚动。

**原建议：** 为每个 pane 增加 generation；所有 atlas change、visibility reveal、snapshot replay、renderer attach 只接受当前 generation；恢复顺序固定为 `dispose -> fit -> replay/refresh -> visible paint`。将 context-loss 后一段时间的 WebGL attach 熔断为 DOM，并记录原因。

**Orca 对照：** `orca/src/renderer/src/lib/pane-manager/terminal-webgl-auto-policy.ts:74-120` 禁用 Wayland/无 renderer identity；`pane-webgl-renderer.ts:107-120` 显式 `loseContext`，`:151-175` 保证单 addon。

</details>

<details>
<summary>P1-7 alternate screen 恢复依赖 marker 解析 — 对证无效（已隐藏）</summary>

对证：`terminalBufferMode.ts:296` 只是类型别名。前端 `terminalReplayBufferMode.ts` 已在 marker 被挤掉时用 snapshot 的 `bufferMode` 再灌 `1049h/l`。「1049h 一丢就空屏」不成立。Orca 把 alt body / scrollback / modes 拆开仍是中期架构差，不按 P1 恢复事故跟踪。

**原证据：** CC-Panes `web/components/panes/terminalBufferMode.ts:296` 和 `cc-panes-core/src/services/terminal_service.rs:713` 以 raw VT chunk、buffer mode 和前端 strip/native 组合恢复；当 `1049h` marker 被 rolling buffer 淘汰或 chunk 截断时，normal/alternate 内容边界不再可靠。

**原风险：** Grok/OpenCode 等全屏 TUI 在后台切换、重连或 checkpoint 为空时，可能恢复到空屏、baseY/viewportY 为 0 或无法继续滚动。

**原建议：** 像 Orca 一样把 emulator snapshot、normal scrollback、alternate body、modes、rehydrate sequence、partial escape tail 设为独立字段；不要从已裁剪 raw snapshot 反推 buffer 边界。

**Orca 对照：** `orca/src/main/daemon/terminal-snapshot.ts:4-19`、`terminal-snapshot-ansi-buffers.ts:3-20`、`terminal-mode-rehydrate-sequences.ts:8-46` 明确分离这些字段，并保存 mouse protocol。

</details>

### P1-8 OpenCode 配置超时不会取消真实 worker

**证据：** `cc-cli-adapters/src/opencode.rs:547-565` 每次配置写入 `std::thread::spawn`；`:567-595` `recv_timeout` 超时只设置 `cancelled`，无法终止已经阻塞的 filesystem/adapter 调用。

**风险：** 慢磁盘或并发启动时，超时请求返回后 worker 仍占线程和临时目录；连续 retry 会积累线程和资源。

**建议：** 使用可取消的分阶段 IO；或建立有界 adapter worker pool，超时后回收任务句柄和临时目录，禁止无限 spawn。

## P2：性能、可靠性和可维护性问题

### P2-1 WS send task 结束后主循环可能仍等待客户端

`cc-panes-daemon/src/server.rs:1633-1641` 将发送任务与接收循环分离；发送端因为 sender drop、session exit 或 socket error 结束时，`handle_ws` 的 `ws_rx.next()` 不一定结束。建议用 `tokio::select!` 监听 send task、session exit、socket receive，并在任一终止事件发生时关闭另一半。

### P2-2 每个 session exit 都创建独立持久化线程

`cc-panes-daemon/src/ws_emitter.rs:484-487` 在退出事件中调用持久化，`session_output_store.rs:40` 的实现每次 `std::thread::spawn`，还会 sleep 500ms 再同步写盘。短命 session 批量退出时会制造线程峰值。建议单个有界队列 + 1–2 个持久化 worker，并在退出事件中提交 immutable snapshot。

### P2-3 polling fallback 的 snapshot delta 仍有全量重放风险

`cc-panes-web/src/ws_handler.rs:141-165` 通过整串 `last_snapshot` 做前缀比较，遇到 rolling front eviction 会判定 mismatch 并发送 desync。应优先使用 raw UTF-8 byte cursor、epoch/endSeq 和 suffix delivery；只有 cursor 不连续时才重建全屏。

### P2-4 前端 scrollback 上限与 Orca 不一致

CC-Panes `web/lib/terminalScrollback.ts:8-10` 是 200–100,000 行；Orca `orca/src/shared/terminal-scrollback-policy.ts:1-4` 是默认 5,000、范围 1,000–50,000，并把 backlog 至少设为 2MiB、按 rows*120 放大（`:27-41`）。建议统一迁移策略，兼容旧值但后端拒绝超限。

<details>
<summary>P2-5 Ctrl+wheel zoom 与 TUI mouse report 有事件优先级耦合 — 对证无效（已隐藏）</summary>

对证：`mouseTrackingMode`、`enable-mouse-events` CSS、`__ccPanesReplayedTerminalWheelEvent` 已经落地，原文建议的 runtime gate 和 replay 标记不是缺口。Ctrl+wheel 与 TUI 的剩余耦合在 `useTerminalWheelZoom.ts:51-56`（`capture:true` + `preventDefault`），不按本条原文跟踪。

**原文：** CC-Panes `web/components/panes/terminalTuiWheelMultiplier.ts:186-200` 使用 `attachCustomWheelEventHandler` 并在 microtask 补发；Ctrl+wheel 的浏览器缩放/终端滚动分支需要在同一层明确优先级。Orca `pane-terminal-mouse-wheel.ts:106-119` 仅在 mouse reporting runtime flag 开启时介入，建议采用同样的 runtime gate 并为 replayed event 加不可变标记。

</details>

### P2-6 recorder 已有基础，但缺少跨层 correlation

已有实现：`web/services/performanceService.ts:45-84` 每 15 秒采集 heap、timer lag、long task、visibility 和 terminal metrics；`src-tauri/src/services/performance_recorder/models.rs:20-79` 记录 queue、in-flight、renderer、resync、context loss、atlas clear；`performance_recorder/mod.rs:14-24` 使用有界事件队列。

缺口：没有统一 `paneId/connectionId/generation` correlation（`session_id` 已有），也没有 lock wait、snapshot encode/decode、WS reconnect reason、mouse mode、source cursor range、renderer attach duration。没有这些字段，现场只能知道“卡过”，不能定位卡在 producer、IPC、parser、WebGL 还是主线程。

## Orca 差异矩阵

| 主题 | Orca 新版 | CC-Panes 当前 | 差异与优先级 |
|---|---|---|---|
| Scrollback | `terminal-scrollback-policy.ts:1-41`，1k–50k，backlog 与 rows 联动 | `web/lib/terminalScrollback.ts:8-17`，200–100k；后端总预算不足 | 内存风险，P1/P2 |
| Producer flow control | `pty-producer-flow-control.ts:1-13,41-73`，256KiB/32KiB、5s reassert、release | `terminal_output_flow.rs:20-38,50-61` 本地/WSL 等价，SSH 有损 | SSH 丢输出，P0 |
| Snapshot | emulator state + atomic drain/snapshot + sequence | raw VT/replay + rolling eviction；legacy prefix mismatch 仍存在 | 重连和后台恢复，P1 |
| Alternate screen | snapshotAnsi、scrollbackAnsi、modes、rehydrate、tail 独立 | 已有 bufferMode 元数据重灌；字段拆分仍是中期差 | ~~P1 恢复事故~~（对证无效） |
| Mouse wheel | runtime mouse flag gate，microtask 按行补发 | 已有 mouse-reporting gate 和 replay 标记 | ~~事件误判 P2~~（对证无效） |
| WebGL policy | 禁用 Wayland/软件 renderer；显式 loseContext；单 addon | 已有同类 policy、loseContext 和 atlas refresh | 未根治见文末；~~P1 竞态事故~~（对证无效） |
| Hidden/park | attached client 数为 0 即 resume producer | 有 visibility/replay 逻辑，但要证明 reveal 顺序和 generation | 后台 pane，P1 |
| Daemon idle | 追踪空闲、客户端、session 后再关闭 | daemon session visibility 写锁较粗 | 多 pane 尾延迟，P1 |
| Snapshot telemetry | `daemon-server.ts:1183-1200` 记录慢 snapshot（>=25ms） | recorder 记录较丰富，但未统一 correlation | 可观测性，P2 |
| PTY identity | Orca 树杀前 ancestry / `ps lstart`（无 pidfd） | Unix 裸 PID/pgid；Windows 已有 Job，显式 kill 仍 `taskkill /PID` | 误杀，P1（Unix / 显式 kill） |

## xterm 与前端渲染优化策略

### 第一阶段：先控制工作量

- 统一 scrollback 预算：前端只做 UX clamp，后端负责硬上限和全局 budget。
- 每个 pane 只保留一个 writer scheduler；写入按 byte budget 和 frame budget 切片，后台 pane 不触发高频 DOM layout。
- 隐藏 pane 只接收 source cursor/低频 snapshot，恢复时使用一次 atomic replay，不逐 chunk 触发 React 状态更新。
- `requestAnimationFrame` 内只做 xterm write/refresh，不做 JSON decode、VT 解析或大字符串拼接。
- 对 WebView hidden 状态暂停 long-task 采样和非必要 polling；已有 `startPerformanceSampling` 的 hidden 页面保护应扩展到 terminal polling。

### 第二阶段：修复 renderer 生命周期

- 建立 `RendererGeneration`：attach、detach、context-loss、atlas-clear、visibility reveal、snapshot restore 都携带 generation。
- context loss 后默认 DOM 熔断窗口（例如 30 秒），同一 pane 不立即反复创建 WebGL context。
- 多 pane 共享 atlas 采用引用计数和版本号；atlas clear 必须广播版本，旧版本 refresh 请求丢弃。
- 在 WebGL/DOM 切换后固定执行 `fit -> replay -> refresh`，并记录每一步耗时和终端尺寸。
- 用 Orca 的硬件/软件 renderer policy 做默认策略；用户强制 WebGL 仅作为诊断开关，不能覆盖 context-loss 熔断。

### 第三阶段：降低解析和重放成本

- 后端发送 source spans 和 end sequence，前端只对缺口重放；不要把整屏 snapshot 当普通 output append。
- parser tail、modes、alternate/normal buffer 分离存储；避免重复扫描大 ANSI 字符串寻找 `1049h`。
- snapshot 序列化用增量/压缩，并记录 `snapshot_bytes`, `serialize_ms`, `parse_ms`, `replay_ms`。

## 线程、锁、通道和进程模型建议

推荐的目标模型：

```text
PTY reader (per session)
  -> bounded byte queue / source sequence
  -> one session scheduler
  -> daemon WS/Tauri emitter
  -> per-pane xterm writer
```

- reader 只能被 output-flow gate 暂停/恢复，不能直接操作前端状态。
- 每 session 一个 scheduler，避免每个订阅者重复轮询/解析。
- 全局只保护 registry；session 状态用 per-session mutex/state machine。
- 所有阻塞 filesystem、TCP、SSH、进程等待必须显式标记并放入有界 blocking pool。
- child 的 wait/reap 只有一个 owner；kill、timeout、window close 都发送状态事件。
- 通道必须有 `capacity`, `sent`, `dropped`, `acked`, `desync` 计数；满时不能默默丢关键控制消息。
- 使用 cancellation token 贯穿 WS、polling、snapshot、adapter worker；socket 关闭必须让下游阻塞任务退出。

## 性能打点方案

### 统一事件信封

所有前后端事件统一带：

```json
{
  "ts": 0,
  "bootId": "...",
  "paneId": "...",
  "sessionId": "...",
  "connectionId": "...",
  "generation": 0,
  "rendererGeneration": 0,
  "runtime": "local|wsl|ssh",
  "visibility": "visible|hidden",
  "kind": "pty_read|queue|ack|snapshot|ws|poll|renderer|lock|process",
  "bytes": 0,
  "seqStart": 0,
  "seqEnd": 0,
  "durationMs": 0,
  "reason": "..."
}
```

### 必采样指标

| 层 | 字段 | 触发/采样 |
|---|---|---|
| PTY | read bytes、read wait、pause/resume、failsafe、exit latency | 每次状态变化，byte counter 15s 汇总 |
| Queue | depth、high/low crossing、oldest wait、dropped、desync | 每批 flush + 15s 汇总 |
| IPC/WS | connect、write、read、reconnect、poll count、timeout | 每次请求，采样 1/10 普通成功请求，100% 错误 |
| Snapshot | serialize/parse/replay ms、bytes、requested/applied rows、cursor gap | 每次 snapshot；慢于 25ms 100% 记录 |
| xterm | write calls、queued chars、callback max、refresh rows | 已有 metric 扩展 pane/generation |
| WebGL | attach/dispose、context loss、atlas clear/change、DOM fallback、DPR | 100% 生命周期事件 |
| Lock | lock wait/hold、锁名、owner stage | 慢于 5ms 记录，慢于 50ms 100% 记录 |
| Process | pid/starttime/creation time、kill reason、wait owner、exit code | 100% 创建/kill/exit |
| Memory | replay bytes、heap、RSS、global budget、eviction | 15s；超过阈值即时事件 |

### 现场判定规则

- `timerLag > 200ms` 且 `longTaskMax > 100ms`：前端主线程阻塞。
- `queue_oldest_wait > 500ms` 且 `lock_wait < 5ms`：渲染/写入侧瓶颈。
- `lock_wait > 100ms`：后端锁或 blocking call 阻塞。
- `in_flight_bytes` 连续 10s 上升：ACK/WS/前端消费断链。
- `desync > 0` 且 source cursor 不连续：传输或 replay 协议问题。
- `context_loss > 0` 或 `atlas_clear` 后 `recovery_duration > 500ms`：WebGL/可见性恢复问题。
- `global_replay_bytes / budget > 0.8`：提前驱逐后台 pane，避免 OOM。

## 严格代码坏味道审阅

1. **全局锁包外部 IO：** `server.rs:867-930` 把锁作用域和业务原子性混为一体。
2. **同步 API 穿过异步边界：** `daemon_client.rs:753-770` 让调用者必须记得自行隔离阻塞。
3. **裸 PID 作为对象身份：** Unix kill 和 Windows `taskkill /PID` 缺乏生命周期身份；Job Object 只覆盖宿主暴毙清树。
4. **退出流程分散：** kill、wait、reaper、emitter、persist 各自发通知，缺少唯一状态机出口。
5. **字符串协议隐式耦合：** raw VT marker、JSON `type`、前缀 snapshot 比较使协议正确性依赖调用顺序。
6. **魔数散落：** 100ms polling、500ms persist sleep、2s TCP read、120s resume heuristic 应集中到带单位的 policy 类型。
7. **失败被吞掉：** 多处 `catch {}`/`let _ =` 保护 UI，但没有统一计数和 correlation；恢复失败会变成静默黑屏。
8. **每次超时 spawn：** OpenCode adapter 的取消标志不等于取消线程。
9. **重复渲染入口：** `refresh`, `fit`, atlas clear、visibility reveal 各自安排 RAF，缺少 per-pane coalescer。
10. **设置层与运行时层职责重复：** scrollback 在前端 clamp、后端 replay、daemon 落盘各自限制，容易出现边界不一致。
11. **hidden pane 语义不统一：** visibility、attached client、renderer active、producer paused 是四套状态，缺少可验证状态图。
12. **测试难以覆盖真实序列：** 现有单测可覆盖 buffer/flow helper，但没有多 pane、断连、context loss、WS slow consumer 的端到端压力矩阵。

## 设计模式适用点

| 位置 | 推荐模式 | 用法 |
|---|---|---|
| session 生命周期 | State Machine | `Launching/Running/Paused/KillRequested/Exited/Disposed`，统一退出通知和 reap owner |
| terminal backend | Strategy | `LocalPty/WslPty/SshPty/DaemonProxy` 各自实现 flow-control、snapshot 和 cancellation 能力 |
| output delivery | Credit-based flow control | source span + cumulative ACK + generation，避免无界队列和静默丢失 |
| renderer | State + Circuit Breaker | WebGL/DOM 为策略，context loss 后熔断，超过窗口才探测恢复 |
| snapshot | Memento | emulator state、modes、buffers、tail 组成不可变 snapshot；禁止从 raw 字符串反推状态 |
| event handling | Event Sourcing-lite | 关键 sequence/ack/desync/renderer 事件写 ring log，现场可重建因果链 |
| locks | Actor/per-session mailbox | registry 之外的 session 操作串行化，减少跨层 mutex |
| persistence | Producer/Consumer | 一个有界落盘队列和固定 worker，代替 exit 时独立 spawn |
| policy | Typed Configuration Object | scrollback、watermark、timeouts 带单位和上下限，启动时一次 normalize |

## 验证计划与当前阻塞

### 必跑命令

```bash
npx tsc --noEmit
npm run test:run
cargo fmt --all -- --check
cargo check --workspace
cargo clippy --workspace -- -D warnings
cargo test --workspace
git diff --check -- docs/reviews/2026-09-10-ccpanes-orca-full-audit.md
```

### 当前证据边界

- 本次是只读审阅，没有修改源码，因此没有把任何测试结果伪装成“修复后通过”。
- WSL 的 Rust 定向 `cargo check` 曾被 `openssl-sys` 缺少 Linux OpenSSL 开发库阻断；这不是源码通过证据。应在 Windows/CI 环境补跑完整 workspace 检查。
- WebGL、WebView2、Win32 PTY、全屏恢复和 Windows installer 必须在 Windows 主机验证；WSL 静态检查不能证明这些行为。
- 当前工作树有用户既有脏修改和历史记录文件；本报告不把它们归因于本轮，也没有清理。

## 优先级路线图

### 立即（P0/P1）

1. 修复 SSH 有损输出：credit/spool，丢弃时带 seq/range；desync 已有。
2. 缩小 daemon `session_visibility` 锁，所有外部 IO 锁外执行。
3. 统一 blocking call 隔离和取消，取消 100ms 无限 polling。
4. 建立全局 replay/output budget，后端 clamp 到 1k–50k rows。
5. 收敛 kill/wait/reap 到单一 session 状态机；Unix 身份校验，Windows 显式 kill 走 Job。

### 短期（P2）

1. 替换 whole-snapshot prefix diff 为 cursor/epoch/suffix 协议。
2. 把退出落盘改成固定有界队列。
3. 补齐 recorder correlation、lock wait、snapshot cost、WS reconnect 和 mouse mode。
4. 加入 1/8/32/64 pane 压测、隐藏/恢复、断网、SSH 刷屏、context loss 测试矩阵。

### 中期（P3/架构）

1. 引入 per-session actor/mailbox，减少共享 mutex。
2. 统一 Memento snapshot 和 source-span replay，删除 raw marker 反推路径。
3. 用基准数据决定 WebGL attach 上限、DOM fallback 窗口和后台 pane 的刷新策略。

## WebGL 是否已经根治？

结论：**没有足够证据称根治。** 当前代码已经覆盖“检测软件/Wayland -> 选择 DOM”“context loss -> dispose/loseContext -> refresh”“atlas change -> 通知共享 pane”三条防线，这是比单纯禁用 WebGL 更完整的恢复机制。但它仍有以下未证明项：

- 多 pane 共享 atlas 变化与 visibility reveal 的顺序是否始终正确；
- snapshot/replay 与 renderer generation 是否会交叉覆盖；
- WebGL context 是否在快速切换后真正从 Chromium 活动集合释放；
- 黑屏/旧字形/无法滚动是否都能在 JSONL 中关联到同一个 pane/session/generation；
- Windows WebView2、Linux X11/Wayland、软件渲染和高 DPR 的长期现场数据是否一致。

只有在这些场景下完成压力测试，并看到 `context_loss -> fallback -> replay -> visible paint` 的完整事件链和稳定恢复耗时，才能把结论提升为“已根治”。

## 最终审阅意见

本版本最可能的卡顿主因是**跨层背压不完整 + daemon 粗粒度锁 + 同步 polling + replay 无全局预算**的叠加，而不是单一 WebGL 开关。建议先按 P0/P1 路线收敛传输和生命周期，再用已有 recorder 补 correlation 和现场证据；否则继续单点调 xterm 参数只能改变症状，不能证明后台 pane、长对话和大量窗口在资源边界内稳定运行。

## 第二轮补充审阅

这一轮补查了 React 订阅、输入队列、恢复算法、SQLite 启动降级、Web 安全和消息大小边界。它们不改变前面的 P0 判断，但会在“窗口很多、后台时间长、异常重启或远程访问”场景中放大卡顿和数据风险。

### P1-9 WebSocket 接收路径直接执行同步 backend 调用

**证据：** `cc-panes-web/src/ws_handler.rs:183-203` 的 WS 主接收循环调用 `handle_client_message`；`:227-241` 内部直接执行 `terminal_backend.write` 和 `terminal_backend.resize`，二进制输入路径 `:191-198` 也直接调用同步 `write`。该 backend 下层可进入 `DaemonTerminalClient` 的同步 TCP（`cc-panes-core/src/services/daemon_client.rs:753-770`）。

**风险：** 每个按键、resize 或远程输入都可能在 Tokio task 上等待连接/写入/daemon 响应；一个慢 daemon 会让 WS 接收循环停住，随后心跳、关闭和其他消息也无法及时处理。这是前面 P1-2 之外的另一条阻塞入口。

**建议：** WS 层只做校验和入队，使用 per-session bounded input mailbox；由受控 `spawn_blocking` worker 或异步 client 消费。输入队列必须有最大字节数、超时、取消和明确的 overflow 错误。

**验证：** 注入 2 秒 backend write 延迟，发送连续键盘输入和 resize，测 WS ping/pong、输入确认延迟、Tokio worker 占用和队列峰值。

### P1-10 输入队列没有容量上限

**证据：** `web/services/terminalService.ts:243-270` 将每次输入追加到 `queue.pending`，没有 byte/chunk 上限；`:282-317` 只有前一批 flush 完成后才继续发送，且每个 source run 依次 `await writeTerminalInputNow`。

**风险：** daemon/网络卡住时，键盘、粘贴、IME 或系统回写会持续生成字符串和 Promise。输入不是 PTY 输出主路径，但它能在几秒内积累大量内存，并在恢复时一次性突发写入，造成交互雪崩。

**建议：** 设置 per-session `maxPendingBytes`、`maxPendingChunks` 和最大单项长度；普通键盘可合并，粘贴超过上限应拒绝或分片；超时后清空并通知 UI，不保留永远 pending 的 Promise。

### P1-11 磁盘数据库失败会无 UI 提示切换内存数据库

**证据：** `src-tauri/src/lib.rs:1607-1622` 在 `Database::new` 失败后记录错误并创建 `Database::new_fallback()`；`cc-panes-core/src/repository/db.rs:1154-1168` 的 fallback 是纯内存 SQLite。日志有 `error!`，不是完全无痕。

**风险：** 目录权限、磁盘满、锁文件损坏或数据库迁移失败时，应用仍启动但项目、任务、session provenance、设置索引等写入只存在于内存，重启后消失。用户看不到 `PersistenceDegraded`，可能把后续失败当成“终端卡住/恢复失败”。

**建议：** 生产模式不要无提示降级。进入显式 `PersistenceDegraded` 状态，禁止会改变持久数据的操作或提供明确只读模式；把原始错误、数据库路径和磁盘剩余空间显示给用户，并提供重试/导出恢复入口。内存数据库只允许测试和明确的 ephemeral 模式。

**验证：** 对数据库目录注入只读、磁盘满、损坏 WAL、迁移失败四种故障，要求 UI/日志明确显示 degraded，且不能声称保存成功。

### P2-7 Panel 对全局树状态订阅过宽

**证据：** `web/components/panes/Panel.tsx:53-58` 每个 Panel 都订阅 `rootPane`、`allPanels`、`layouts`、`currentLayoutId` 等全局对象；`:108-115` 还会基于整棵 `rootPane` 重新计算 paneCount 和 tabNumbers。即使某个 pane 未变，只要其他 pane 修改导致这些引用变化，它也会重新执行。

**风险：** pane 数量增长时，切 tab、拖拽、后台 session 状态同步会让 N 个 Panel 重渲染并重复遍历整棵树；TerminalView 虽然尽量保持实例不重建，但 React 主线程仍会被布局计算和子树 diff 占用。

**建议：** 父级一次计算全局 tab number/pane count，再按 pane id 传稳定 primitive；Panel 只订阅自己的 pane slice 和 active 标记。对布局树使用结构共享或 per-layout selector，禁止在每个 Panel 内扫描全树。

### P2-8 hidden session 上报每次全量扫描全部布局

**证据：** `web/hooks/useHiddenSessionReporter.ts:121-126` 订阅整个 `usePanesStore`；`:76-95` 每次去抖触发都遍历所有 layout、tab 和 saved session，并排序整个 hidden 集合；随后 `terminalService.ts:232-241` 对所有旧/新 hidden session 重新计算 priority。

**风险：** 任何 pane store 小变更都会触发 O(布局树 + session) 扫描。窗口多、拖拽频繁或 orchestrator 事件密集时，隐藏治理本身会争抢主线程；还可能在 100ms 去抖窗口内反复覆盖 priority。

**建议：** 维护增量 visibility index（owner -> session ids），只在 owner/visibility 边沿更新；`setHiddenTerminalOutputSessions` 先比较集合 hash，完全不变时不遍历；将大集合按 session diff 发送。

### P2-9 恢复候选匹配是 O(leaves × saved)

**证据：** `web/hooks/useTerminalSessionRestore.ts:211-217` 一次加载全部 saved records；`:234-241` 对每个 leaf 调用 `saved.filter(...)`，随后逐 leaf 写多条 restore log（`:125-151`、`:228-232`）。

**风险：** 终端数量和历史记录同时增长时，恢复阶段会在 UI 启动关键路径做二次扫描和大量日志序列化，导致“重启后几十个 pane 卡在恢复”。现有共享 status cache 解决了 IPC 扇出，但没有消除本地 O(N²)。

**建议：** 预先建立 `Map<anchorKey, SavedSession[]>`、`Map<sessionId, provenance>`；日志按批次提交并限制候选 ID 数量；恢复过程分批让出主线程，并在 UI 上显示阶段进度。

<details>
<summary>P2-10 单一 SQLite Mutex 把无关服务串行化 — 对证无效（已隐藏）</summary>

对证：主库确实是 `Mutex<Connection>` + `busy_timeout=5000`。`history_file_repo` 用的是每项目 `history.db`，**不是**那把锁。原文把历史扫描和 session restore 写成同一把锁争用，按该表述无效。主库串行化可以另开一条，不沿用本条证据。

**原证据：** `cc-panes-core/src/repository/db.rs:1104-1107` 用一个 `Mutex<Connection>` 保存整库连接，`connection()` `:1375-1381` 返回整把连接锁；history repo 等多个仓库在 `history_file_repo.rs:159,185,350,401,423` 等处直接持锁执行查询/事务。数据库初始化还设置 `busy_timeout=5000`（`db.rs:1139-1143`）。

**原风险：** 历史扫描、媒体事务、任务队列和 session restore 共享同一连接锁；任何慢查询或事务都能让其他服务等待最多数秒，表现为 UI IPC 卡顿。WAL 只能改善 SQLite 读写策略，不能消除应用层单 Mutex。

**原建议：** 按读/写场景使用连接池或至少读连接与写连接分离；长查询移到 blocking worker；记录 mutex wait 和 SQL duration；对历史扫描设置单独预算和取消。

</details>

### P2-11 WebSocket 消息大小依赖框架默认值

**证据：** `cc-panes-web/src/ws_handler.rs:28-37` 和 `:45-50` 创建 WebSocket upgrade 时未显式设置 `max_message_size`/`max_frame_size`；输入消息在 `:211-241` 直接把整段文本解析为 `serde_json::Value`。

**风险：** 行为依赖 axum/tungstenite 版本默认值，升级依赖后上限可能变化；恶意或误粘贴的大消息会在 JSON parse、UTF-8 转换和 backend write 前产生大分配。

**建议：** 显式设置帧/消息上限，按 input、resize、media 分别限制；超过上限发送结构化错误并关闭连接，避免将整个 payload 放入日志。

### P2-12 Web API 使用 permissive CORS

**证据：** `cc-panes-web/src/routes/mod.rs:856-861` 对包含 API、terminal WS 和 media WS 的总 Router 使用 `CorsLayer::permissive()`。认证中间件位于 `:842-854`，安全依赖 cookie/token 和远程只读策略。

**风险：** permissive CORS 扩大了任意网页发起请求的能力；即使浏览器凭证策略当前阻止部分 cookie，未来启用 credentials、token header 或本地开发代理时，跨源调用面会扩大。

**建议：** 按配置生成 allow-origin 白名单，默认只允许本机 UI origin；认证 cookie 明确 `Secure/HttpOnly/SameSite`，WS 额外校验 Origin；把本地桌面 API 与远程 Web API 分成不同 router policy。

## 第二轮新增验证矩阵

| 场景 | 负载 | 关键指标 | 通过条件 |
|---|---|---|---|
| 多 pane React | 64 pane，交替拖拽/切 tab/改布局 | commit 次数、长任务、每次更新扫描节点数 | 非受影响 pane 不产生渲染；长任务不持续超过 50ms |
| 输入背压 | backend write 延迟 2s，连续粘贴/IME | pending bytes、pending chunks、输入延迟 | 队列有硬上限，超限可见失败，不 OOM |
| 恢复算法 | 1k leaves + 10k saved records | restore wall time、主线程 long task、候选扫描次数 | 使用索引近似 O(N+M)，主线程可响应 |
| 数据库争用 | ~~历史扫描 + 任务写入 + session restore 并发~~（混库证据无效） | — | — |
| 持久化降级 | 只读目录/满盘/损坏 WAL | degraded 状态、写入结果、重启后数据 | 不静默成功，不丢失地提示恢复路径 |
| WS 安全 | 超大 frame、跨源 Origin、错误 token | 返回码、内存峰值、日志泄漏 | 显式拒绝，内存有上限，日志不含 token/payload |

## 第二轮结论

新增证据表明，卡顿并不只发生在 xterm 写入：**React 全局订阅、隐藏会话全量扫描、同步 WS 输入、无界输入队列**也可能在主线程或 IPC 线程形成独立的排队链。严格审阅的下一步应把这些排队点统一纳入同一个 `queue_wait -> service_wait -> render_wait` 时间线，而不是分别调单个组件参数。

## 第三轮：构建环境、协议放大与发布可靠性

<details>
<summary>P2-13 WSL 构建缓存本身已达到 14.92 GiB — 对证无效（已隐藏）</summary>

对证：这是某台机器的构建缓存快照，不是产品缺陷。真实 `target-dir` 在 `../cc-book-target`（`.cargo/config.toml` + `scripts/cargo-target-dir.cjs`），不是 `src-tauri/target`。`Cargo.toml:18` 承认 debug 膨胀仍然成立，不按本条 14.92 GiB / vmmem 因果跟踪。

**原现场证据：** 当前 `src-tauri/target` 有 12,920 个文件，按文件大小求和约 14.92 GiB；`src-tauri/target/debug/deps/cc_panes_lib.lib` 和对应顶层 `.lib` 各约 834 MiB，另有多个 300–650 MiB 的 rlib/PDB。`Cargo.toml:18` 已承认默认 debug 信息会使 `target/debug/deps` 膨胀，`scripts/cargo-target-dir.cjs:6-59` 负责选择缓存目录。

**原风险：** 这不是运行时 heap，但会造成 WSL VHD 增长、文件 page cache 和编译时磁盘争用，能直接推高 `vmmemWSL` 的提交量并拖慢 xterm/daemon 的 IO。用户看到的“释放缓存后仍有大内存”可能是构建树和 page cache，而不是终端进程。

**原建议：** 把 dev/release target 分到独立、可定期淘汰的缓存卷；记录 `target_bytes`、`target_file_count` 和最近访问时间；无人构建时再执行受控 `cargo clean` 或按 profile/架构清理，不要在运行中的构建期间删除。CI 只保留最近成功 artifact，禁止把 debug target 当持久运行时数据目录。

</details>

### P2-14 两个 Cargo.lock 造成发布依据不唯一

**证据：** 根 `Cargo.lock` 有 921 个 `name` 条目，根包 `cc-panes` 是 `0.12.16`；`src-tauri/Cargo.lock` 只有 527 个条目，里面 `cc-panes` 仍是 `0.1.0`。`cargo metadata --manifest-path src-tauri/Cargo.toml` 当前解析到根 workspace，但手工进入 `src-tauri`、脚本或外部发布工具可能读取嵌套锁。

**风险：** 审阅者、CI 或打包脚本可能使用不同依赖图；漏洞扫描、checksum 审计和 release hash 也可能对不上。更严重的是，用户以为验证了 0.12.16，实际构建了旧锁对应的依赖集合。

**建议：** 明确 workspace 唯一 lockfile；若保留嵌套锁，必须由 CI 校验其 package/version 与根锁一致并说明唯一使用者。release 脚本固定 `--manifest-path` 和 `CARGO_TARGET_DIR`，构建前打印 lockfile 路径、HEAD、包版本和依赖图摘要。

### P2-15 VT 查询回写没有放大保护

**证据：** `web/components/panes/terminal/terminalParserHandlers.ts:37-57` 对 CPR 查询调用 `terminalService.write`（`source: "system"`）；`:59-99` 对 OSC 颜色查询回写；`:101-131` 对 DA/Kitty 查询回写。共 7 个 parser handler 绕过键盘聚合，但仍进入同一输入队列（`terminalService.ts:243-317`）。缺的是速率限制，不是完全绕开队列。

**风险：** 一个异常或恶意 TUI 可以高频发 CPR/OSC 查询，形成“PTY 输出 -> 前端解析 -> IPC 输入 -> PTY 输出”的反馈放大，消耗主线程、IPC 和输入队列。当前只有日志和 Promise rejection，没有 per-session 查询速率或字节预算。

**建议：** 按查询类型设置 token bucket；对同一 session 的重复 CPR/DA/OSC 在短窗口合并或缓存；system reply 也计入 input budget，并在超限时记录 `reply_throttled` 而不是静默堆积。

### P3-1 依赖/平台验证矩阵仍不完整

当前 `package.json` 使用 `@xterm/xterm 6.0.0`、`@xterm/addon-webgl 0.19.0`、React 19、Vite 7；Rust workspace 同时包含 Tauri、axum、tokio、portable-pty、SSH 和 WSL 分支。静态代码没有证明以下组合都可用：Windows WebView2 + ConPTY、Linux X11/Wayland + WebGL、WSL daemon + Windows desktop、SSH + hidden flow control、macOS WKWebView + native menu。发布门槛应按组合建立 CI/主机矩阵，而不是只跑单一 Linux workspace check。

### P2-16 关键模块远超约定上限，形成结构性审阅盲区

**规模证据：** `src-tauri/src/services/orchestrator_service.rs` 18,792 行；`cc-panes-core/src/services/terminal_service.rs` 8,847 行；`cc-panes-daemon/src/server.rs` 3,139 行；`src-tauri/src/lib.rs` 3,647 行；`cc-cli-adapters/src/lib.rs` 2,591 行；`cc-panes-core/src/repository/db.rs` 2,003 行。项目规范要求模块尽量小于 800 行。

**风险：** 生命周期、协议、持久化、测试桩和平台分支混在同一文件中，导致修改一个边界时难以知道所有调用方；增量编译和代码审阅范围也会扩大。`terminal_service.rs` 同时承担 PTY、replay、状态推断、输入、WSL/SSH、MCP 清理和恢复逻辑，是卡顿/崩溃问题最容易交叉污染的中心。

**建议：** 按稳定边界拆成 `pty_runtime`、`output_replay`、`session_state`、`input_router`、`ssh_backend`、`wsl_backend`、`persistence_bridge` 等 crate/module；先只移动代码并保持接口，再逐步收窄可见性。将测试桩和生产实现分离，避免进一步增长。

## 第三轮验证建议

```text
环境资源：~~target bytes / VHD / 14.92 GiB 构建树~~（现场快照，不按产品缺陷跟踪）
锁文件：cargo metadata root + src-tauri / package versions / lockfile path
协议放大：PTY query rate -> parser replies -> input queue bytes -> backend writes
发布矩阵：Windows WebView2/ConPTY、Linux X11/Wayland、WSL、SSH、macOS WKWebView
```

到这里，静态代码审阅能继续发现的主要是边界和证据缺口；再往下必须运行故障注入、长时间压力和 Windows 主机验证，单靠阅读源码不能可靠判断“是否卡死”或“是否根治”。
