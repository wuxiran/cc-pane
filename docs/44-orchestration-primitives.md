# 编排原语三件套实施计划：wait / bracketed-paste 投递 / send_to_worker

> 来源：竞品原语能力对照经三道滤网（自身工作流疼点 / 哲学契合 / 人力性价比）过滤后的落地清单。
> 状态：**计划待评审**——按惯例先交 WSL Codex 只读交叉评审，再动手。
> **rev.2（2026-07-24 重审）**：①排序改从统一优先级排序——**paste 第一波（现役 bug），wait+send 第二波** ②wait 的 exited 语义对齐 docs/44-clear-sessionend-exit-bug 的 reason 过滤修复 ③waitFor 状态名对齐真实 TerminalStatusType ④send_to_worker 底层按"会话通用消息基座"建模，为画布(docs/47)临时通信边预留 ⑤新增消费者：docs/47 画布 Phase C 依赖本文原语 1/3。

---

## 排序与依赖（rev.2，与统一优先级排序一致）

| 波次 | 原语 | 解决什么 | 预估 |
|---|---|---|---|
| **第一波** | bracketed-paste 投递 | 修 launch_task/submit 多行 prompt 截断痼疾——**每天派工都在踩的现役 bug**；send_to_worker 前置 | Phase A 半天 + Phase B 1 天 |
| **第二波** | `wait_for_session` | 退役所有 skill 里手搓的"轮询 get_session_status + 软超时"；画布等待光圈语义 | 1.5~2 天 |
| **第二波** | `send_to_worker` | leader→worker 标准下行，替代裸 submit_to_session；底层消息基座供画布复用 | 1~1.5 天 |

依赖关系：paste 完全独立先行；send_to_worker 复用 paste 的投递路径。三项都是纯后端 + MCP 面，无 UI 改动，不走 7 步全流程。

---

## 原语 1：`wait_for_session`

### 目标

新 MCP 工具：阻塞直到指定会话进入目标状态或超时，事件驱动，无忙轮询。

```
wait_for_session({
  sessionId | launchId,          // 二选一
  waitFor: ["idle","exited"],    // 目标状态集，任一命中即返回
                                 // 合法值 = 真实 TerminalStatusType 成员：
                                 // initializing/thinking/toolRunning/compacting/
                                 // waitingInput/idle/active(legacy)/error/exited
  timeoutMs?: 180000             // 默认 3 分钟，上限 570000
}) → {
  satisfied: bool,
  finalStatus: string,           // 命中/超时时的状态
  blockedReason?: string,        // 见下
  waitedMs: number,
  turnSeq: number
}
```

**blocked 语义**：等 `idle` 时若会话进入 `WaitingInput` 或 `Error`——这两个状态不等人干预永远到不了 idle——立即返回 `satisfied:false, blockedReason:"waiting-input"|"error"`，让调用方决定是注入回答还是升级。不困在死等里。

### 接线点

- **状态源**：`cc-panes-core/src/services/session_state_machine.rs`——现有 8 态（Initializing/Thinking/ToolRunning/Idle/Compacting/WaitingInput/Error/Exited），`apply_event`（:202 转移表）+ `snapshot()`（:343）。
- **新增订阅通道**：state machine 加一个 `tokio::sync::broadcast::Sender<StatusChange>`（`{pty_session_id, status, turn_seq}`），`apply_event` 状态实际变化时 publish。容量给 256，lagged 接收者直接重查 snapshot 补偿（广播丢消息无害——等待方收到任何信号后都重新对照 snapshot 判定，不依赖逐条送达）。
- **wait 实现**（orchestrator_service 新 MCP 工具）：①先 `snapshot()` 快路径——已满足直接返回；②否则 `subscribe()` 后**再查一次 snapshot**（防订阅前瞬间的竞态漏事件），然后 `tokio::time::timeout` 包住接收循环，每收到本会话信号即对照 waitFor 判定。
- **daemon 模式**：state machine 活在 Tauri 进程，daemon 会话状态经 hook 双写 + `TerminalDaemonEventBridge.poll_status` 冒泡（docs/18 Fix 2 已铺好）——wait 天然两模式通用，最坏延迟 = bridge 轮询间隔，可接受。
- **Exited 覆盖核查（rev.2 更新语义）**：确认 `kill_session` / PTY 进程自然退出两条路径都会把 `SessionEnd` 打进 state machine（若 kill 路径只清 PTY 不喂事件，需补一行 apply）。**关键前置事实**（docs/44-clear-sessionend-exit-bug 已修）：Claude 的 SessionEnd hook 带 reason，`/clear` 触发 `SessionEnd(reason="clear")` **不是进程退出**——hook 层已按 reason 过滤（HTTP 与 OSC 双通道），daemon 桥也不再对 clear 发合成 `terminal-exit(-1)`。wait 直接消费状态机即可获得正确语义，但**测试必须加用例：会话内 `/clear` 不得满足 `waitFor:["exited"]`**；另注意合成退出码 `-1` 历史语义（非真实进程退出），wait 返回的 finalStatus 携带 exitCode 时须透传该区分。

### 边界与坑

- **MCP 长调用**：默认 180s——MCP over HTTP 的工具调用不宜挂太久；超时返回 `satisfied:false, finalStatus` 让 agent **重新调用续等**（无状态可续，snapshot 快路径保证重调零成本）。工具 description 里写明这个续等模式。
- 会话不存在/已 Exited：快路径直接返回（waitFor 含 exited 则 satisfied:true），不报错。
- launchId 解析走现有 `find_session_id_by_launch_id`（daemon 模式已修好，docs/18 #2）。

### 测试

- state machine 单测：广播发布、状态未变不发布。
- wait 单测（`terminal_service_for_test` 范式）：快路径命中；事件唤醒；超时路径；WaitingInput blocked 返回；订阅-快照竞态（先 apply 后 subscribe 仍正确）。
- 集成：daemon 模式下 wait 一个真实会话到 idle。

### 收尾（后续独立提交）

plantocodex / planreview / plantocc / parallel 系 skill 把"轮询 + 软超时"段落改写为 `wait_for_session` 调用；软超时保留为 wait 超时后的降级分支。

---

## 原语 2：bracketed-paste 投递

### 目标

PTY 注入文本用终端标准粘贴协议包裹，让多行 prompt 安全整段送达；就绪判定从"按长度睡觉"改为"看终端控制序列"。

### Phase A（半天，先行止血）

- 新共享函数（cc-panes-core，terminal_service 或 utils）：

```rust
fn wrap_bracketed_paste(text: &str) -> String {
    // \x1b[200~ + sanitize(text) + \x1b[201~
    // sanitize：剥除 text 内嵌的 \x1b[201~，防提前终止粘贴块（注入逃逸）
}
```

- `submit_to_session` 路径（orchestrator_service :4405 语义 → terminal_service 实际写入处）：文本先 wrap 再写，**现有长度启发式延迟和单独发 CR 的时序暂时保持不变**（CR 不是 LF——Known Gotcha 不动）。
- 仅这一步就修复多行截断：换行进了粘贴块，ink/Codex TUI 视为字面换行不触发提交。
- launch_task 的 prompt 注入维持 CLI 位置参数不动（它没坏）；长 prompt 文件外部化降级为超长兜底，中等长度多行可改走 paste 路径——**这一步放 Phase B 一起做**，A 阶段只动 submit。

### Phase B（1 天）

- **就绪信号**：在 PTY 输出处理管线（`osc_state_detect.rs` 同位置）识别 `\x1b[?2004h`（DECSET 2004，TUI 挂载输入框时开启 bracketed paste 的宣告），per-session 记 `paste_ready` 标志（TUI 退出/alt-buffer 切换时复位——与 docs/32 alt buffer stripper 的接线互查）。
- `submit_to_session`：`paste_ready` 时延迟缩到固定小值（200ms 量级，Codex/Claude 需要一个渲染回合再收 CR——实测结论）；未就绪回退现有长度启发式。
- launch_task 中等长度多行 prompt 改走"等 paste_ready → paste → submit"路径。

### 验证（按 verify skill 驱动真实流程）

- Windows 本地 Claude Code：submit_to_session 发 3 行 prompt，确认输入框收到完整 3 行、一次提交。
- WSL Codex 同验。
- 回归：单行 prompt、slash command（`/plan`）、控制键路径（write_to_session 不 wrap——控制键绝不能进粘贴块）。
- 落地后更新记忆条目 `launch-task-prompt-truncation`（解法已变）。

---

## 原语 3：`send_to_worker`

### 目标

leader→worker 的标准下行，与 `report_to_leader` 对称：格式化指令行 + busy 门控排队 + 空闲边沿补投 + 协作日志留痕。

```
send_to_worker({
  workerSessionId | planId,      // planId = 广播给该 plan 全部 worker
  message,
  submit?: true                  // false 则只放入输入框不回车（草稿模式）
}) → { delivered: [...], queued: [...] }
```

### 设计前瞻（rev.2）：底层做成"会话通用消息基座"，leader→worker 只是 v1 授权外壳

画布（docs/47）Phase C 需要**任意两个会话**之间拖线开双向通道——不限于 leader/worker 对。因此本原语的存储与唤醒层按 **sessionId 通用**建模（消息表键控收发双方 sessionId + 可选 role 标签；队列/空闲边沿补投机制与角色无关），v1 的 MCP 工具面只暴露 `send_to_worker`（授权规则=调用方必须是该 plan 注册 leader），**画布接入时复用同一基座只新增授权规则**（画线双方即互授通道），零重构。

### 接线点

- **投递格式**：`[leader-directive] <message>`——与 worker 端 `[worker-report]` 对称，worker 侧 skill（plantocodex/plantocc 的 worker 指引）同步教它识别这个前缀。
- **busy 门控复用**：worker 忙（Thinking/ToolRunning/Compacting）时入队，空闲边沿补投——直接复用 2026-07-04 落地的"leader busy 排队 + 空闲边沿自动补投"机制（orchestrator_service `enqueue_and_recheck` :7612 一带），方向反过来，队列按 worker sessionId 键控。
- **投递动作**：走原语 2 的 bracketed-paste 路径（这就是 3 依赖 2 的原因）。
- **留痕**：写入 plan collaboration 存储，`get_plan_collaboration` 可见（leader 事后可审计"我给谁下过什么指令"）。
- **身份校验**：调用方必须是该 plan 注册的 leader（register_plan_leader 已有的注册制身份——用现成的）。

### 测试

- worker 空闲：立即投递 + 留痕。
- worker 忙：入队 → 状态机转 Idle 边沿补投（可借 wait 原语的广播通道做边沿触发，一举两用）。
- planId 广播：多 worker fan-out，各自独立排队。
- 非 leader 调用被拒。

---

## 实施流程

1. **本文档交 WSL Codex 只读评审**（惯例：重大修复计划先交叉评审）——重点审：wait 的订阅-快照竞态处理、广播 lagged 补偿、Phase B 就绪信号与 alt-buffer 的交互、send_to_worker 队列与现有 leader 队列的共存
2. 评审意见回写本文档后，按 1 → 2A → 2B → 3 顺序实施，**每项独立提交独立验证**（worker 过程禁跑测试，每项收尾一次最小范围）
3. 每项验收：`cargo test --workspace` + `clippy -D warnings` + `fmt --check` + 该项的真实流程验证
4. 全部落地后：skill 改写（wait 替换轮询、send_to_worker 替换裸注入）单独一批提交；内部研究档 P0 条目标记完成

## 不做清单（过滤掉的，留档防反复）

decision gate、消息 thread/群发/@all、todo DAG deps + 自动推进、确定性 coordinator、匿名信箱制——当前 plan 级人在回路的协作规模不疼；参考对照已在内部研究档留档，规模上去疼了再取。
