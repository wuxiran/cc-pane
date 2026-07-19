# MCP kill_session 关不掉标签：daemon 桥接竞态 + 星标/pinned 盲区

> 状态：待实施 | 优先级：**高**（日常可感知）| 关联：`CHANGELOG.md:35`、修复提交 `134c912`

## ⚠️ 并发警告

**另有 worker 正在改** `src-tauri/src/services/orchestrator_service.rs`（MCP 端口稳定任务）。
**不要碰那个文件**（已确认它没动任何 kill 相关代码，两边无重叠，但别去改它）。

**只许碰**：

- `src-tauri/src/services/terminal_daemon_event_bridge.rs`
- `cc-panes-core/src/services/terminal_service.rs`（**仅** kill 路径的 emit 时序）
- `web/stores/usePanesStore.ts`（星标/pinned 两处）
- 对应测试

**不要碰**：`orchestrator_service.rs`、`cc-panes-daemon/`、`cc-panes-web/`、
`web/services/terminalService.ts`（前端分流逻辑本身是**正确的**，不要动）。
**禁止任何 git 写操作**（工作树里有十四个主题的未提交成果）。
**绝对不要杀用户进程**；`cargo test --workspace` 可能被 daemon 文件锁阻塞，
改分 crate 测试并说明哪些没跑到。

## 现象

MCP `kill_session` 后 PTY 进程确实被杀（终端显示 `Process exited with code -1`），
但**标签页不关**。`CHANGELOG.md:35` 明确记载 user/MCP kill 应当关标签。

## 根因：reason 不是被改错，是被整条丢掉

**MCP 传的 reason 全链路正确**（`orchestrator_service.rs:4477-4481` →
`backend.kill_with_reason(&sid, KillReason::Mcp)` → `daemon_client.rs:231-243` 拼
`?reason=mcp` → `cc-panes-daemon/src/server.rs:624` parse → `terminal_service.rs:2807-2810`
emit `session-killed { reason: "mcp" }`）。**没有任何一层把它改成回收类。**

**丢失点** `src-tauri/src/services/terminal_daemon_event_bridge.rs:134-161`：

```rust
tokio::select! {
    message = ws.next() => { ... handle_stream_message ... }
    _ = status_interval.tick() => {                       // 每 500ms
        if self.poll_status(&session_id, backend.clone()).await? == PollStatus::Done {
            return Ok(());                                // ← 退出，killed 消息被丢弃
        }
    }
}
```

`poll_status`（`:260-288`）在会话查不到时**只发 `terminal-exit(-1)` 就返回 `Done`，
从不发 `session-killed`**。桥接返回后 socket 被 drop，队列里的
`{"type":"killed","reason":"mcp"}` 永远读不到。

### 竞态窗口为何很大

`cc-panes-core/src/services/terminal_service.rs:2760-2811` 的顺序：

1. `:2768` `sessions.remove(session_id)` —— **此刻起 `get_session_status` 就查不到了**
   （`:2582-2583` 只查 `sessions`）
2. `:2773` `cleanup_session_mcp_configs(...)` —— 文件系统 I/O
3. `:2804` `session.process.kill()` —— Windows 上杀进程树，可能几十~几百 ms
4. `:2807` **才** emit `session-killed`

从"状态轮询不可见"到"事件入队"之间有可观空窗。500ms tick 落进去
（或 `poll_status` 的 HTTP 往返横跨该窗口——其 `.await` 期间 `ws.next()` 不被 poll）
即触发静默 -1 退出。

### `-1` 的正确解读（勿重蹈误判）

daemon 桥接有**四处**发 -1：`:139`（WS 流结束）、`:145`（close 帧）、
`:196`（`Killed` 分支，**只有这条同时发 `session-killed`**）、`:273`（poll 查不到）。
所以看到 -1 说明前端**没收到** `session-killed`，**不是**收到了回收类 reason。

### 已排除

- daemon WS emitter 转发完好（`cc-panes-daemon/src/ws_emitter.rs:94-109`，测试 `:161-180` 在）；
  `134c912` 的修复仍有效，这是**不同的洞**
- 无二次事件覆盖：`session_reaper.rs:156` 需 TTL 24h；
  前端对账 `useOrphanSessionReconciler.ts:155-158` 有 TOCTOU 复查会跳过
- `killedSessions` 去重集合（`terminalService.ts:623`）只在前端自己 kill 时写入，
  MCP kill 不命中

## 改动

### 1. 治本：提前 emit（`terminal_service.rs:2760-2811`）

把 `session-killed` 的 emit 移到 `sessions.remove` **之后立刻**、
`cleanup_session_mcp_configs` / `process.kill()` **之前**，消灭"状态已消失但事件未发"的空窗。

⚠️ 需确认提前 emit 不会让前端在进程真正结束前就关标签导致别的问题
（例如 output flush 竞态）。**若发现有，停下来汇报，不要硬改。**

### 2. 加固：退出前排干 WS（`terminal_daemon_event_bridge.rs:151-158`）

`poll_status` 返回 `Done` 后不要立即 `return`，先把 WS 中已就绪的消息排干
（`while let Ok(Some(msg)) = ws.next().now_or_never()`，或给一个短 drain 超时），
再决定是否发静默 -1。两层防线并存。

### 3. 星标布局的标签关不掉（`web/stores/usePanesStore.ts:417`）

`eachLayoutTree` **跳过 starred layout**，而 `closeTabBySessionId`（`:2697-2737`）依赖它
→ **星标布局里的标签永远关不掉**。`90c585e` 把星标标签升级成真实 PTY 镜像后风险上升。

修：让 `closeTabBySessionId` 能覆盖星标布局。
⚠️ `eachLayoutTree` 跳过 starred 可能是**别处有意为之**——先查清所有调用方，
**不要直接改 `eachLayoutTree` 的语义**，优先在 `closeTabBySessionId` 侧单独处理。

### 4. pinned 标签静默吞掉后端 kill（`usePanesStore.ts:598`）

`closeTabInTree` 对 `pinned` 标签静默 `return`，但 `closeTabBySessionId` 仍置
`handled = true` → 后端 kill 被静默吞掉，标签留着且无任何提示。

修：至少让调用方知道没关成（不要谎报 `handled`）。
**是否应该强制关闭 pinned 标签属于产品决策——不要擅自决定**，
先保证状态如实反映，并在汇报里给出你的建议。

## 明确不做（另案）

**浏览器端（cc-panes-web）完全没有 `session-killed` 通路**：
`web/services/terminalService.ts:311` 早退，`parseWebSocketOutput`（`:461-476`）
把 `type:"killed"` 当非输出丢弃，`socket.onclose` 只发 exit **0**。
即 cc-panes-web UI 下 MCP kill 永远关不了标签。**本次不做**，需新建事件通路。

## 顺带核实（不修，只报告）

`cc-panes-core/src/services/terminal_service.rs:2815` 有一行
`\ fix(H2) review: ...` 看着像被损坏的注释前缀（应为 `//`）。
**确认它是否真的能编译**——若是损坏字符请在汇报里指出，由 leader 决定是否修。

## 验收

- `cargo check --workspace`、`cargo clippy --workspace -- -D warnings`
- `cargo test -p cc-panes-core`（workspace 全量可能被 daemon 锁阻塞）
- `npx tsc --noEmit`、`npx vitest run web/stores/ --maxWorkers=2`
- 补测试：桥接在 poll 先于 killed 到达时仍能发出带 reason 的 `session-killed`；
  星标布局中的标签能被 `closeTabBySessionId` 关闭；pinned 标签不谎报 handled
- **手动验证不可省**：起 dev，用 MCP `kill_session` 杀一个会话，确认标签**真的消失**
