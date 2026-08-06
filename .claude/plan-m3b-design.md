# M3b「checkpoint+delta 恢复归一」实施设计（待 codex 评审）

> 设计产出：0.12.0 收官期 Plan agent（探索 + 接口核对后输出）。
> 实施批准后按 plan-lands-in-docs 纪律并入 docs/78 §4。
> 骨架版见 C:\Users\wuxiran\.claude\plans\0-12-0-resilient-journal.md 阶段 P4。

## 0. 两个贯穿全文的设计裁决

**裁决 A：配对身份 = 流内字节锚点（`anchorSeq`），不是独立计数器。**
约束①要求避开 `generation`（已被 `daemon_generation` = 进程 started_at 占用，
16 处）。比改名更深的问题：Orca 的 generation 配对成立是因为它的 daemon 自己
拍照、自己写流水，天然同点；我们的照片在前端拍、流水在 daemon 攒，**必须回答
「这张照片对应流水的哪个位置」**，否则 photo+delta 拼接要么重叠（重复画面）
要么有缝（丢字，违反 docs/71 不变式）。引入每会话单调字节计数 `output_seq`
（ReplayBuffer 维护 = 会话起点以来累计推入字节数），照片以 `anchorSeq`
（拍照时前端已确认写入 xterm 的最后字节 seq）配对。anchorSeq 单调递增，
天然兼任 checkpoint 身份——「错配拒绝回放」落为三种拒收：stale（≤ 现有锚点）、
gap（< 窗口起点，中段已被丢弃）、future（> 当前 output_seq）。
命名全面避开 generation：`outputSeq` / `endSeq` / `anchorSeq` / `checkpointedAtMs`。

**裁决 B：恢复响应必须结构化（photo 与 delta 分离），不能预拼接。**
照片是 SerializeAddon 产物 = 成品 VT 流（不可二次渲染，直写）；delta 是 PTY
原始字节（必须过 renderTerminalData，docs/71 不变式）。二者写入管道不同，
daemon 拼成一个字符串前端无从区分。新读契约
`{ checkpoint?, delta, bufferMode, endSeq }`，前端分两段写。旧端点保留拼接
语义服务旧前端（§5 降级矩阵）。

## 1. 分批（M3b-0 … M3b-5；依赖链 0→1→2→3→4，5 可选尾批）

绞杀者纪律：M3b-1..3 期间 ReplayBuffer 的 8MB「会话起点」窗口语义原样保留
（新旧双路并存），锚定裁剪到 M3b-4 才用开关翻转；每个前端消费者一个 commit。

### M3b-0 · 轮询降级路径先修（约束②，独立价值可先发）
- `terminal_daemon_event_bridge.rs:553` `replay_snapshot_delta` 失配分支从
  「整屏当增量重发」改「发 desync 走统一恢复」；`cc-panes-web/ws_handler.rs:193`
  同款同改。**先补测试锁现状再改行为**（该路径今天零测试）。
- 为什么先做：今天 8MB front-drop 已偶发触发这个无测试分支；checkpoint 锚定
  只是放大频率。先治病再放大。
- 验证：新增单测（失配→desync）；手工：会话产出超 8MB 后轮询模式画面不再
  整屏重复而是一次快照重放。回退：单 commit revert。

### M3b-1 · core 存储与 seq 记账（daemon 内部，对外不可见）
- ReplayBuffer（terminal_service.rs:495）增 `pushed_seq: u64` /
  `window_start_seq: u64`（front-drop 时前移）/ `checkpoint: Option<StoredCheckpoint>`；
  新方法：`store_checkpoint(cp) -> StoreCheckpointOutcome`（三态拒收；本批不
  裁剪 chunks）、`recovery_snapshot() -> TerminalRecoverySnapshot`（有效照片时
  photo + anchorSeq 之后保留字节；无效/无照片 checkpoint: None + delta=全窗口）、
  `shrink()` 复查锚点有效性（dead 转移裁剪可能推过锚点）。
- TerminalService 新公开方法 store_session_checkpoint / get_session_recovery_snapshot
  （活跃 + dead_buffers 双查，模式同 get_session_replay_snapshot）；
  TerminalBackend trait 加两方法带默认 Err 实现（mock 不破）。
- chunk 边界对齐：push() 以 PTY read-chunk 为单位，emit 批是整数个 read-chunk
  拼接，前端见到的任何 endSeq 必落 chunk 边界——store_checkpoint 与未来 trim
  都不需要切分 chunk，「丢弃只能整段」无痛保持。
- 验证：纯 cargo 单测 + property test（随机 chunk 序列 + 随机拍照/裁剪，
  photo 基准 + recovery.delta 重组恒等于参考流后缀）。

### M3b-2 · serialize 上传链路（约束③，最大批）
- daemon：`POST /api/sessions/{id}/checkpoint`（server.rs:532 路由表）——
  authorize + ensure_may_write 租约闸门（照片影响所有客户端恢复数据，防只读
  镜像端污染）+ **显式 DefaultBodyLimit::max(16MB)**（axum 默认 2MB 会静默
  413）。应答：200 {accepted, anchorSeq} / 409 {STALE_ANCHOR|ANCHOR_GAP} /
  404 = 旧 daemon（capability 探测点）。
- 补拍：daemon 30s 周期扫 `pushed_seq − anchorSeq > 4MB`（无照片不请求），
  经 WsEmitter::publish_control 发 `{"type":"checkpointRequest","sessionId"}`，
  每会话节流 ≥60s。不挂输出热路径。
- seq 贯通四层：TerminalOutput 加 `end_seq: Option<u64>`（旧端自然忽略）→
  reader 线程 (chunk, seq) 送批线程 → ws_emitter 透传 WS JSON → bridge
  DaemonStreamMessage::Output 可选字段 → 前端
  `terminalOutputSeqTracker.ts`（noteReceived / noteWritten（挂 writeTerminalData
  onWritten 回调——**锚点只认 xterm 已确认解析字节**，规避 write 队列异步导致
  照片缺尾）/ invalidate（desync/积压溢出）/ reanchor（统一恢复后用响应 endSeq））。
  web 模式 parseWebSocketOutput 同步。
- app/前端：新命令 upload_terminal_checkpoint；daemon_client 对应 POST；
  terminalService.uploadCheckpoint（invokeOrApi 双模式）+ per-daemon capability
  缓存（首个 404/unknown 后关断防探测风暴）+ registerCheckpointRequest
  （模式同 registerDesync）。
- 触发点：①休眠 Tier2（hibernateNow serialize 已在手，fire-and-forget）；
  ②隐藏 5min 边沿（terminalBackgroundLifecycle 加 onCheckpointEdge，xterm 还活）；
  ③daemon 补拍请求。统一守卫：resync 在途 / didOverflow / seq 无效（含轮询
  降级模式天然无 endSeq）/ 休眠中无 xterm → 跳过本次。
- 契约表军规同 commit：BOUNDARY_EVENTS 加 `checkpoint-request`
  （DedicatedApi / Control / 新 loss 变体 BestEffortWithResend——诚实建模
  「丢了 daemon 会周期重发」，不污染 output 独占的 droppable 断言）；
  INBOUND_CONTROL_MESSAGES 结构加 `channel: rest|control-ws` 字段并登记
  `checkpointUpload(rest)`；DaemonControlMessage 加 CheckpointRequest 变体
  （转 WebView 事件，新常量 EV::TERMINAL_CHECKPOINT_REQUEST）；TS 镜像两表 +
  EXPECTED_VARIANTS 同步。
- 验证：dev 观测 hibernate → daemon 日志 checkpoint accepted；契约守卫全绿；
  **验证首行写死**：cargo build -p cc-panes-daemon → 拷 debug\binaries\ →
  重启 daemon（二进制陈旧 gotcha）。
- 回退：前端触发点常量开关关掉即停产（daemon 存了照片无人消费，无害）。

### M3b-3 · 恢复归一（读路径 5→1）
- 新端点 `GET /api/sessions/{id}/recovery-snapshot` + 命令
  get_terminal_recovery_snapshot（**必须照抄旧命令两件副作用**：
  history_watch_manager.on_session_created + bridge.start_session_after_replay
  ——基线用 photo+delta 拼接串，与轮询坐标系一致）。
- terminalService.getRecoverySnapshot 内置降级：新命令/端点不可用 → 调旧
  getReplaySnapshot 包成 { checkpoint: null, delta: data, bufferMode }——
  **前端消费方从此只有一个形状**。
- 共享 helper 结构化改造：terminalReplay.replayAttachedSession 与
  terminalResync.resyncFromReplaySnapshot 拆 writeCheckpoint（直写）+
  writeDelta（过 renderTerminalData）双管道；resync 序 = reset → photo →
  delta → syncTrackedBufferType → tracker.reanchor(endSeq)。
- render_flavor 校验：photo 的 flavor（raw / alt-stripped，对应
  keepCliOutputInNormalBuffer）与本端不符 → 忽略 checkpoint 走 delta/legacy
  （多客户端设置分歧的诚实降级）。
- 消费者切换顺序（每个一 commit）：①attach 铺底/崩溃恢复（最冷路径先切；
  回归含 PR #55 冷恢复——本批不碰 leaf 恢复状态机）→ ②desync 重放+溢出恢复
  （resyncHandler 一次切换覆盖二者）→ ③休眠唤醒 snapshot 兜底分支（wakeData
  快路径不动）→ ④重连回放（机械上已折入 attach/desync，只跑回归不改码）。
- 512KB 积压快路径原样保留（军规）；溢出→invalidate seq→统一恢复。
- 验证：恢复路径实现数 5→1 的 grep 证据（getReplaySnapshot 直调点只剩
  service 内部 fallback）+ 逐字节一致用例（§7）。
- 回退：逐消费者 revert；service 层降级常量可一键强制 legacy。

### M3b-4 · 锚定开启（行为翻转最小 diff）
- store_checkpoint 接受照片后裁剪 anchorSeq 之前 chunks（window_start_seq
  前移）；模块级常量 CHECKPOINT_ANCHORING_ENABLED 守门（回退 = 翻常量重发版）。
- 旧端点兼容：锚定后 snapshot() 返回 photo+delta 拼接串（旧前端画面完整；
  两张照片之间拼接串仍前缀增长，photo rebase 时轮询路径一次 desync——M3b-0
  已修好并有测试；补一条 rebase→desync→基线重置集成测试）。
- delta 溢到 8MB（补拍没跟上）：front-drop 推过锚点 → checkpoint 判无效整体
  丢弃 → 回纯窗口语义（宁可截史不可花屏）。
- 验证：daemon 长会话 RSS 不再随历史线性涨 + 恢复历史深度突破 8MB 手工用例。

### M3b-5 · 落盘与收尾（可选尾批）
- session_output_store 两个既有时机（退出宽限 + 优雅关闭）顺带写
  `<id>.checkpoint.json`（write_session_output 同款 atomic write）。本批只写
  不读；冷恢复读回显式记 docs/78 §6 遗留。
- CLAUDE.md gotcha 增补（anchorSeq ≠ daemon_generation、锚定开关、
  render_flavor、body limit）；docs/78 批3 实施记录补账。

## 2. 数据模型（cc-panes-core/src/models/terminal.rs，紧邻 TerminalReplaySnapshot）

```rust
pub struct TerminalCheckpoint {
    pub anchor_seq: u64,           // 配对身份 + 流锚点；绝不叫 generation
    pub snapshot_ansi: String,     // SerializeAddon 产物（成品 VT）
    pub buffer_mode: TerminalBufferMode,
    pub cols: u16, pub rows: u16,  // 拍照时尺寸（信息性，重放端 fit 兜底）
    pub render_flavor: String,     // "raw" | "alt-stripped"（docs/73 多客户端诚实位）
    pub checkpointed_at_ms: u64,
}
pub struct TerminalRecoverySnapshot {
    pub checkpoint: Option<TerminalCheckpoint>,
    pub delta: String,             // anchor 之后原始 VT，必须过 renderTerminalData
    pub buffer_mode: TerminalBufferMode,
    pub end_seq: u64,              // 前端重锚点
}
```

存储：**内存，挂 ReplayBuffer 内部**——Arc 在会话退出时整体移入
DeadBufferEntry，**300 秒死会话保留策略零改动自动继承**（死会话恢复升级为
photo+delta）；唯一新义务是 shrink() 复查锚点。上限：photo ≤ 8MB 拒收；
每会话内存 = photo + delta 窗口 8MB（锚定后 delta 通常 <4MB）。

## 3. 上传链路选型：REST（结论明确）

大 payload（数百 KB–4MB）走 REST：独立连接不阻塞 control 单帧通道
（hiddenSessions/notifier 队头）；照片是离散提交需要应答（409 可感知、
404 = capability 探测），与 hiddenSessions 的 watch 全量覆盖语义相反
（照片不能被 coalesce）；复用 authorize + ensure_may_write 租约闸门
（write_session 同门先例）。control 只走反向小信号 checkpointRequest
（低频小载荷可丢可重发，正是 control 的设计用途）。

## 4. 轮询降级路径处置（约束②）：失配 = 不连续 = desync

三候选论证：(a) cursor API 按 seq 取增量——语义最净但为一条降级路径动 REST
契约不值；(b) 保持整屏重发——现状失配时整屏当增量 append 产生重复画面，
锚定后每次 photo rebase 必发，行为随 M3b 变差，否决；(c) **选定：失配改发
desync**（bridge 与 web 两份实现同改，前端 handler 齐备）。顺序纪律：先补
测试锁现状再改行为。两份重复实现本次不合并（依赖面不同），测试用例表复制
对齐、留注释互指。

## 5. 兼容矩阵

- 新前端 + 旧 daemon：新命令 unknown / REST 404 → 回落旧端点包成
  checkpoint: null 形状；capability 缓存防重复探测。
- 旧前端 + 新 daemon：只调旧端点；M3b-1..3 期间旧端点逐字节不变；M3b-4 后
  得到 photo+delta 拼接串（画面完整）。
- 旧 app 收 checkpointRequest：DaemonControlMessage::Unknown 静默忽略
  （既有 forward-compat 测试模式覆盖）。
- in-process 模式：TerminalBackend 默认实现走 checkpoint: None 纯 delta——
  前端单形状不感知后端差异。

## 6. 512KB 快路径边界

常量、语义、溢出即作废全部不动（永久兜底军规）。未溢出短隐藏：drain 直写
不触发恢复；溢出：didOverflow → 统一恢复 + seqTracker.invalidate（积压有
缺口 = 前端不再知道写到哪，禁上传直到重锚）；daemon 闸门生效时隐藏期积压
恒空，unhide 由 daemon desync（dropped_while_hidden 契约）驱动统一恢复。
两机制按「谁先断流谁负责发起恢复」正交组合，无双重重放（desync handler 先
hiddenWriteBuffer.reset()，既有逻辑）。

## 7. 测试清单（验收映射）

- 锚错配拒回放：ReplayBuffer stale/gap/future 三拒收单测 + shrink 推过锚点
  降纯 delta + 路由 409 测试。
- hidden 期间 delta 连续性：既有闸门测试保持绿 + property test（hidden 丢投
  期间 pushed_seq 照常前进，photo@隐藏前锚点 + delta 重组 == 参考全流）。
- unhide 必发 desync：既有两条测试保持绿。
- 断线重连同一路径：vitest spy 断言只调 getRecoverySnapshot；bridge 集成
  测试 WS 断→轮询→photo rebase→desync→基线重置。
- 旧 app 静默忽略：unknown 变体既有模式 + 404 回落 + 契约守卫全链。
- **逐字节一致**：devDependency 加 `@xterm/headless`（repo 现只有
  addon-serialize；无 DOM 依赖可跑 vitest）双实例法——T1 喂完整渲染流在锚点
  serialize 得 photo、继续喂完 serialize 得 S1；T2 直写 photo + 渲染写 delta
  → serialize 得 S2；断言 S1 === S2；覆盖 normal/alternate 两种 bufferMode。
- 另加：M3b-0 两份实现的对齐用例表；terminalOutputSeqTracker 纯函数测试。

## 8. 风险与工作量

| 风险 | 缓解 |
|---|---|
| seq 四层贯通错位 = 重复/丢字 | property test + onWritten 锚点 + endSeq 单调 dev 断言（缺口视同 desync） |
| 照片是客户端渲染态（alt-strip 分歧） | render_flavor 标记 + 不匹配即忽略照片走 legacy |
| xterm write 队列异步 vs serialize 时点 | 锚点=已确认写入 seq；有 in-flight 跳过本轮上传 |
| axum 2MB 默认 body limit 静默 413 | 路由显式 16MB + 413 路径测试 |
| 契约表漂移 | 既有 CI 守卫链强制同 commit |
| daemon 二进制陈旧误判「没生效」 | 每批验证首行写死重建+拷贝+重启 |
| M3b-4 翻转影响旧前端 | legacy 拼接串保画面完整；常量一键回退；发版间隔观察周期 |
| 冷恢复被 attach 改动波及 | M3b-3 不碰 leaf 恢复状态机；每消费者 commit 后跑冷恢复回归 |
| 上传风暴（18 标签同时边沿） | 每会话去抖 ≥60s + capability 关断 + 409 幂等 |

工作量（人日）：M3b-0：0.5–1；M3b-1：1–1.5；M3b-2：2.5–3（最大批）；
M3b-3：2–2.5；M3b-4：1；M3b-5：0.5–1。**合计 ≈7.5–10**，建议拆
M3b-0 / M3b-1+2 / M3b-3 / M3b-4+5 四个发版窗口。

## 关键文件

- cc-panes-core/src/services/terminal_service.rs（ReplayBuffer :496/:702/:731/:2782/:3007/:3601）
- cc-panes-daemon/src/server.rs（路由 :532、ControlInboundMessage :1328、补拍周期任务）
- src-tauri/src/services/terminal_daemon_event_bridge.rs（:553 失配→desync、endSeq 透传、基线重置）
- web/services/terminalService.ts（getRecoverySnapshot 降级壳 :571、uploadCheckpoint、registerCheckpointRequest）
- cc-panes-core/src/services/boundary_events.rs（军规首改点）
