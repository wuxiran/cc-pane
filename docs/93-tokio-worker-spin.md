# 93 · Tokio worker 100% 单核空转调查

> 调查日期：2026-08-25。范围是当前 `cc-book` 工作树；只新增本报告，没有修改
> leader 的在途 Rust 文件，也没有启动 Tauri dev。方向 B 静态审查已经足以闭合根因，
> 因而没有对正在使用的 Windows release 实例做方向 A 重编或方向 C 配置二分。

## 结论

**根因已定位：output ACK control-link 分支制造了永久自唤醒。**

根因链位于 `src-tauri/src/services/terminal_daemon_control_link.rs`：

1. `output_ack_channel()`（当前工作树 :141-149）是一个静态 `watch` 通道。前端
   `ack_terminal_output` 在 daemon 模式下（`src-tauri/src/commands/terminal_commands.rs:994-1006`）
   调用 `report_output_ack`（control link :155-162），用 `Sender::send_modify` 把累计水位放入
   map。
2. control WS 建立后，`run_control_link` 在 :340-362 等待 `output_ack_rx.changed()`。收到一次
   ACK 后先 `mark_unchanged()`（:342），再调用 `drain_output_acks()`。
3. `drain_output_acks()`（:165-171）用另一个 `send_modify` 执行
   `std::mem::take(pending)`。即使 map 已经为空，`send_modify` 仍是**无条件通知**：Tokio
   1.49.0 的 API 文档明确写的是 “Modifies ... unconditionally ... notifying all receivers”。
4. 因此 drain 自己又把 `output_ack_rx.changed()` 标为 ready；下一轮进入同一分支，先标记已读，
   再对空 map `send_modify`，再次通知。这个 future 从此不再回到 Pending。分支没有待发 ACK
   时不执行 WS `send`，但 `continue` 会持续重选同一个 ready 分支。

这不是“业务 `loop {}`”或 syscall 风暴，而是一个 Tokio task 的 `watch::changed()` 自唤醒环：

```text
前端 ACK
  -> report_output_ack: send_modify (通知)
  -> output_ack_rx.changed() ready
  -> drain_output_acks: send_modify(empty) (仍通知)
  -> changed() ready -> drain(empty) -> ...
```

这解释了计划 §1 的全部活体证据：任务持续被调度，Tokio worker 在任务让出/重新唤醒时反复
进出 IOCP 的 `ZwRemoveIoCompletionEx` 与 park/unpark 的 `ZwWaitForAlertByThreadId`；没有大量真实
I/O，所以每秒只有约 92 次 I/O 仍可出现 99.5% 单核。worker 只在 Tokio 调度器层耗 CPU，主 UI
线程可以继续处于 `Wait/UserRequest`。

时间线也吻合：这段 output ACK 代码由提交 `c5323f89a`（2026-08-23）首次引入；计划记录的
8/23 release 构建在启动约 1.1 秒后稳定出现自旋。仅有 ACK 到达时才进入闭环，因此没有终端
输出/ACK 的启动实例不会触发该故障。

## 判据与证据

### 已确证的运行时证据

以下采样事实来自 leader，直接采用，不重复采样（见 `.claude/plans/tokio-worker-spin.md` §1）：

- `tokio-runtime-worker` 线程启动约 1.1 秒后出现，10 秒 CPU 增量 9.95 秒（99.5% 单核）。
- 30 次 RIP 中 16 次为 `ZwWaitForAlertByThreadId`、12 次为 `ZwRemoveIoCompletionEx`，栈指针在
  4 个值之间循环跳变；这是反复 park/unpark，不是挂死。
- I/O 计数约 92 次/秒，排除了“完成包/系统调用数量本身足以烧满 CPU”。
- 日志 8 秒零增长，主线程仍响应；`browser_evaluate` 超时是被饿死的定时器/oneshot，
  不是 `browser_service.rs` 自身的循环。

### 静态闭环证据

- `terminal_daemon_control_link.rs:340-362`：`changed()` 分支在收到通知后无条件继续；
  `mark_unchanged()` 的位置早于 drain。
- `terminal_daemon_control_link.rs:165-171`：drain 对同一个 `watch::Sender` 无条件
  `send_modify`，空 map 也通知接收者。
- Tokio 1.49.0 `watch::Sender::send_modify` 文档/实现：内部把闭包包装成返回 `true` 的
  `send_if_modified`，所以每次调用都发布变更；“map 为空”不会抑制通知。
- `terminal_commands.rs:994-1006`：只有 daemon backend 才把前端 ACK 送入该 control-link，
  与故障只在共享 daemon/桌面链路启用时出现相符。

### 其它七个重点嫌疑的排除

- `cc-panes-core/src/services/pi_rpc_service/transport.rs:16-45` 的 stdout/stderr 是
  `read_until(...).await`；`:52-68` 的 `try_wait` 轮询每次 `sleep(25ms).await`，不是忙转。
- `src-tauri/src/services/terminal_daemon_event_bridge.rs:238-276` 是 `ws.next()` 与状态
  interval 的 `select!`；`:347-373` 每轮先 `interval.tick().await`；`:536-553` 用
  `timeout_at(..., ws.next())`，没有无等待 continue 路径。
- `src-tauri/src/services/web_access_lifecycle.rs:217-235` 是同步 `stop()`，循环内
  `std::thread::sleep(50ms)`；不在 Tokio worker 上。
- `src-tauri/src/services/pi_rpc_event_bridge.rs:121-153` 只在终态有限地 `try_recv` 排空，
  正常路径为 `receiver.recv().await`；没有 `wake_by_ref`。
- `src-tauri/src/services/orchestrator_service.rs:1166-1220` 的等待循环包含 transition、
  recheck interval 和 deadline；绑定重试也在 `wait_for_bind_retry(...).await`。`:9883` 的
  `std::thread::sleep(250ms)` 位于同步 UI 辅助函数，`:9971-9974` 明确另起线程。
- `cc-panes-core/src/services/daemon_client.rs:808-824` 是同步 `std::net::TcpStream` 读，
  `cc-panes-core/src/services/ssh_terminal_service.rs:96-219` 是阻塞 PTY 接口并带 8ms sleep；
  两者都不注册 Tokio IOCP。
- 全仓静态搜索未发现自定义 `fn poll`、`AsyncFd` 或无条件 `wake_by_ref`。其余常驻 loop
  都有 `.await`、定时器或明确运行在独立线程/测试中。

## 最小修复方案

只需修 output ACK 的 drain 通知条件，保持累计 ACK、max-merge 和断线合并语义不变：

```rust
fn drain_output_acks() -> HashMap<String, u64> {
    let mut taken = HashMap::new();
    output_ack_channel().0.send_if_modified(|pending| {
        if pending.is_empty() {
            return false; // 空队列不产生 changed 通知
        }
        taken = std::mem::take(pending);
        true
    });
    taken
}
```

保留当前分支中 `mark_unchanged()` 在 drain 前的位置。第一次 drain 非空时会产生一次额外
`changed`，下一轮 drain 看到空 map 返回 `false`，因此最多多 poll 一次而不会形成永久环；
同时避免把 `mark_unchanged()` 移到 drain 后造成并发 ACK 被错误标记为已读。更彻底的替代是
用 `mpsc` 传递 ACK 并在 control task 内合并，但超出本 bug 的最小修复范围。

建议随修复补两类测试：

1. 单元测试抽出的 drain helper：非空 map 可取走；连续第二次 drain 不应让
   `Receiver::changed()` 在 `timeout(10ms, ...)` 内再次 ready。
2. control-link 集成测试：注入一笔 ACK，断言发送一条 `outputAck` 后 100ms 内 branch 计数
   停止增长；断开 WS 时仍保留下一次 ACK 的累计值。

本 worker 未修改禁写文件；`Cargo.toml` 未加入临时 release debug 符号配置，因此不需要跑
代码验收命令。实现应由持有 `terminal_daemon_control_link.rs` 所有权的 leader 完成后，再按
仓库约定串行执行 check/clippy/fmt。

## 同类风险清单

- `watch::Sender::send_modify` 适合“值确实变化”的路径；消费/清空队列必须使用
  `send_if_modified`，否则空值写回会把 `changed()` 变成自唤醒源。
- `tokio::select!` 中对 `watch::Receiver::changed()` 的 `Err` 不能只 `continue`；通道关闭后
  `changed()` 会立即返回错误，必须 `return`/`break`，否则会出现另一种永久 ready 环。当前
  `terminal_daemon_control_link.rs:300-362` 的 hidden/shared/output 分支都应在后续修复中显式
  处理关闭状态（这些静态 OnceLock sender 正常生命周期内不会关闭，但代码形态有风险）。
- 任何“收到通知后清空同一个 watch sender”的实现，都要检查清空操作是否再次发布通知；
  review 判据应同时看发送 API（`send`/`send_replace`/`send_modify`/`send_if_modified`）和
  接收端的 `changed`/`mark_unchanged` 顺序。
- 轮询类 `loop {}` 只有在每条路径都可能无 await/无阻塞时才是 spin 罪证；本仓库的 Pi、WS、
  interval、SSH 与同步 stop 循环分别属于 await、定时器或独立线程，不能仅凭 `loop` 列罪。

## 排障速查（三步）

1. **先定线程与时间线。** Process Explorer/自有采样记录线程描述、10 秒 CPU 增量和创建
   时间；确认是 `tokio-runtime-worker` 而不是 UI 线程。同步保存日志增长、主线程响应和总进程
   CPU，避免把 WebView 超时误当根因。
2. **做活体 RIP/RSP 采样。** 不用 WinDbg 6.12 无头模式：PowerShell 以
   `OpenThread(0x004A)` + `SuspendThread`/`GetThreadContext`/`ResumeThread` 采 30 次、间隔
   60ms；AMD64 `CONTEXT.ContextFlags` 在 `0x30` 写 `0x100001`，从 `0xF8` 读 RIP、`0x98`
   读 RSP。若大多数命中 `ZwRemoveIoCompletionEx`/`ZwWaitForAlertByThreadId` 且 RSP 在少数值
   间循环，同时 I/O 计数很低，转查 Tokio task 的自唤醒，不要继续追 syscall 风暴。
3. **沿 ready source 反查。** 全仓搜索 `changed().await`、`poll`、`wake_by_ref`、
   `send_modify`；对每个 `select!` 分支确认：收到/清空操作是否再次通知同一 receiver、空值
   是否抑制通知、关闭错误是否退出。临时给分支和发送 API 加计数（不要打印业务数据），应能
   看到“单笔 ACK 后 branch 计数无限增长”；修复后 branch 应在发送一次 ACK 后回到 Pending，
   worker CPU 回落且 IOCP wait 恢复真正休眠。

## 验证边界

本报告的根因是源码契约级证明，并与 leader 已完成的 Windows 活体采样和 8/23 提交时间线
一致；本 worker 没有再次启动 release 应用，也没有执行方向 A 的带符号 Windows 复现或方向 C
功能开关二分。因此“函数名级 dump 复核”和“关闭 ACK/daemon 后 CPU 立即回落”仍是实现后建议
的验收证据，不把未执行的实验写成已完成。
