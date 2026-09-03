//! 终端输出投递记账（docs/71 §9.2 缺口 B-5）。
//!
//! 记录"已 emit 但前端尚未消化"的字节数，让上游第一次看得见下游的消费速度。
//!
//! # 为什么不能用合批 channel 的深度当水位
//!
//! `TauriEmitter::emit`（src-tauri/src/emitter.rs:22-27）序列化后投递即返回，
//! **不阻塞**；`WsEmitter::emit` 满时 `try_send` 失败即丢，也不阻塞。两条路径下
//! 合批线程都能持续排空，channel 深度恒为 ~0——WebView 卡住时积压全在 Tauri IPC
//! 队列里，对我们完全不可见。所以水位只能是"已 emit 未 ACK 的字节数"。
//!
//! # 记账形式
//!
//! 累计值 + max-merge（照 Orca `src/main/ipc/pty.ts:3044-3074`）：天然幂等、容忍
//! 乱序、丢一条自愈。增量 ACK 会让每次丢包变成永久债务。
//!
//! seq 与 `ReplayBuffer::pushed_seq` 同源（terminal_service.rs:803），单位是会话
//! 起点以来的累计 **raw UTF-8 字节**，且保证落 chunk 边界。
//!
//! # 生产者暂停（Stage 3）
//!
//! 水位超过 HIGH 时 reader 线程停止调 `read()`：PTY 内核缓冲填满后，刷屏的子进程
//! 阻塞在自己的 `write()` 上——刷屏的程序被自己的输出限速，正是想要的结果。不这么
//! 做就只剩「无界内存」或「丢数据」两条路，都更差。
//!
//! 三个配套细节缺一个就是永久卡死（Orca 源码注释逐条写明）：
//!
//! - **宽滞回** HIGH/LOW 差 8 倍（`pty-producer-flow-control.ts:8-9`）：deliberate，
//!   防止排空中的队列每个 flush 切片 flap 一次 pause/resume。
//! - **失效重断言** 5s（`session-producer-pause.ts:5`）：park 到点自动放行，仍高于
//!   HIGH 才重新 park。没有它，一条丢失的 ACK 就是永久静默的终端。
//! - **拆除释放**：kill/exit 必须唤醒 park 中的 reader，否则留在 paused 的本地 PTY
//!   会永远卡住（`PtyProducerFlowController::release` 注释）。
//!
//! SSH **不 park**：同主机多终端共享一个 ssh2 Session（`ssh_terminal_service.rs:29`），
//! libssh2 把 channel 复用在一条传输上，停读一个会阻塞共享传输拖垮其他终端；且
//! keepalive 只在 `read()` 的 WouldBlock 分支里发（`:156-158`，15s），park 超时即掉线。
//! SSH 走 `OutputFlowGate::disabled()`，只记账、不 park，超水位靠有界通道整段丢弃。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

/// killswitch：置 false 全局停用生产者暂停（记账与有界通道不受影响）。
///
/// 照 Orca `src/main/ipc/pty.ts:311` 的 `PRODUCER_FLOW_CONTROL_ENABLED`——终端流控
/// 出问题的表现是花屏/卡死/静默，都是用户强感知，翻常量重编比回滚整版安全。
pub const PRODUCER_FLOW_CONTROL_ENABLED: bool = true;

/// 超过此水位暂停读取 PTY。
pub const PRODUCER_FLOW_HIGH_WATERMARK_BYTES: u64 = 256 * 1024;
/// 跌破此水位恢复读取。与 HIGH 差 8 倍是刻意的滞回，见模块注释。
pub const PRODUCER_FLOW_LOW_WATERMARK_BYTES: u64 = 32 * 1024;
/// park 的单次上限：到点无条件放行一轮，仍超 HIGH 会重新 park。
pub const PRODUCER_PAUSE_FAILSAFE: Duration = Duration::from_secs(5);
/// 连续这么多次失效超时后判定回执链路已死，发 desync 让前端整屏重建（Stage 4）。
///
/// 2 × 5s = 10s 静默才动手，与 Orca 的 `PTY_DELIVERY_HEAL_MIN_ACK_SILENCE_MS`
/// （`src/main/ipc/pty.ts:2679`）同量级。偶发一次超时是洪流下的正常抖动，不该
/// 惊动用户；连续多次才是"没人在消费"。
pub const FAILSAFE_TIMEOUTS_BEFORE_DESYNC: u64 = 2;

/// 交互窗口：距上次键盘输入这么久之内的输出算"回显"。
///
/// 照 Orca `src/main/ipc/pty.ts:2681-2682`。**不动全局 16ms 合批窗口**——那是防
/// WKWebView 主线程死锁的（Orca 跑 Chromium 没有这个约束），加一条快路比调全局
/// 参数安全得多。
pub const INTERACTIVE_OUTPUT_WINDOW: Duration = Duration::from_millis(100);
/// 单批不超过这么多**字节**才走快路。超过就是程序在刷屏，不是回显。
///
/// 用字节而非字符：这是启发式阈值，不值得为它每批做一次 O(n) 的 UTF-8 扫描。
/// 多字节文本会让实际字符阈值偏小——偏保守的方向，正合适。
pub const INTERACTIVE_OUTPUT_MAX_BYTES: usize = 1024;

/// 一次 `park_if_paused` 的结局。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParkOutcome {
    /// 本来就没暂停（含 SSH 的 disabled gate）。
    NotParked,
    /// 被 ACK 排空或拆除释放唤醒——正常路径。
    Resumed,
    /// 失效超时到点放行一轮，但还没到判定链路死亡的程度。
    TimedOut,
    /// 连续多轮超时：回执链路已死，调用方应发 desync 让前端从快照重建。
    Stalled,
}

/// 单会话的投递记账。
pub struct OutputFlowGate {
    /// 最后一次 emit 出去的 chunk 末尾 seq。
    sent_seq: AtomicU64,
    /// 前端确认已消化（解析完**或**被丢弃）到的 seq。
    acked_seq: AtomicU64,
    /// 是否收到过任何 ACK。
    ///
    /// Stage 3 的闸门必须靠它降级：web 模式没有 ACK 通道、旧版前端不认这条命令，
    /// 这些客户端一个 ACK 都不会发。若照样按 in-flight 判定，窗口会立刻关死并把
    /// 生产者永久暂停——同 Orca 的 dispatcher-ready 看门狗
    /// （`src/main/ipc/pty.ts:2671-2672`：握手没到就强制放行，免得丢失的握手变成永久 hold）。
    ever_acked: AtomicBool,
    /// 最近一次 ACK 时刻，供 Stage 4 的卡死看门狗判静默时长。
    last_ack_at: Mutex<Option<Instant>>,
    /// 本会话是否参与生产者暂停。SSH 恒 false（见模块注释）。
    park_enabled: bool,
    /// reader 线程的 park 闸门。`true` = 应当暂停读取。
    ///
    /// 用 Condvar 而非轮询：ACK 到达时要立刻唤醒，睡固定间隔会给每次恢复凭空加
    /// 一截延迟。锁里只放一个 bool，临界区短到不值得担心争用。
    parked: Mutex<bool>,
    park_signal: Condvar,
    /// 观测计数：park 过多少次。诊断 flap 用（滞回失效会让它飙升）。
    pause_count: AtomicU64,
    /// 单次 park 的上限。生产恒为 `PRODUCER_PAUSE_FAILSAFE`，测试可缩短。
    failsafe: Duration,
    /// 连续失效超时次数。任何一次正常唤醒都清零——只有"持续没人消费"才累加。
    consecutive_failsafe_timeouts: AtomicU64,
    /// 最近一次键盘输入时刻，供交互快路判定"这批输出是不是回显"。
    last_input_at: Mutex<Option<Instant>>,
}

impl Default for OutputFlowGate {
    fn default() -> Self {
        Self::new()
    }
}

impl OutputFlowGate {
    /// 本地 / WSL：参与生产者暂停。
    pub fn new() -> Self {
        Self::with_park(PRODUCER_FLOW_CONTROL_ENABLED)
    }

    /// SSH：只记账，永不 park（见模块注释）。
    pub fn disabled() -> Self {
        Self::with_park(false)
    }

    fn with_park(park_enabled: bool) -> Self {
        Self::with_failsafe(park_enabled, PRODUCER_PAUSE_FAILSAFE)
    }

    /// 失效超时可注入：验证"到点放行 + 重断言"不该靠置 `cancelled` 取巧
    /// （那走的是另一条分支），也不该让测试真睡 5 秒。
    #[cfg(test)]
    fn with_test_failsafe(failsafe: Duration) -> Self {
        Self::with_failsafe(true, failsafe)
    }

    fn with_failsafe(park_enabled: bool, failsafe: Duration) -> Self {
        Self {
            failsafe,
            sent_seq: AtomicU64::new(0),
            acked_seq: AtomicU64::new(0),
            ever_acked: AtomicBool::new(false),
            last_ack_at: Mutex::new(None),
            park_enabled,
            parked: Mutex::new(false),
            park_signal: Condvar::new(),
            pause_count: AtomicU64::new(0),
            consecutive_failsafe_timeouts: AtomicU64::new(0),
            last_input_at: Mutex::new(None),
        }
    }

    /// 用户按键时调用。合批线程据此把紧随其后的小批输出判为回显走快路。
    pub fn note_input(&self) {
        if let Ok(mut slot) = self.last_input_at.lock() {
            *slot = Some(Instant::now());
        }
    }

    /// 这批输出是否该绕过合批窗口立即刷出。
    ///
    /// 判据两条同时成立：紧跟在一次按键之后（100ms 内）**且**足够小（≤1KB）。
    /// 大批量即便紧跟按键也不算——那是程序被按键触发后开始刷屏，合批才是对的。
    pub fn is_interactive_echo(&self, batch_bytes: usize) -> bool {
        if batch_bytes == 0 || batch_bytes > INTERACTIVE_OUTPUT_MAX_BYTES {
            return false;
        }
        self.last_input_at
            .lock()
            .ok()
            .and_then(|slot| *slot)
            .is_some_and(|at| at.elapsed() <= INTERACTIVE_OUTPUT_WINDOW)
    }

    /// 合批线程 emit 之后调用。`None` 表示该批没有 seq 坐标（ReplayBuffer 锁失败、
    /// 或轮询降级路径），这类字节不计 in-flight，前端也就不需要为它们回执。
    pub fn note_sent(&self, end_seq: Option<u64>) {
        let Some(end_seq) = end_seq else { return };
        // fetch_max：合批线程是唯一写者，但用 max 语义可防 seq 回绕/重放把游标拽回去。
        self.sent_seq.fetch_max(end_seq, Ordering::AcqRel);
        self.reevaluate_park();
    }

    /// 收到前端回执。返回本次新确认的字节数（0 = 重复或过期的 ACK）。
    pub fn note_acked(&self, processed_end_seq: u64) -> u64 {
        self.ever_acked.store(true, Ordering::Release);
        if let Ok(mut slot) = self.last_ack_at.lock() {
            *slot = Some(Instant::now());
        }
        // 夹到 sent_seq：损坏或超前的 payload 不能把 in-flight 拖成负数
        // （Orca `pty.ts:3050-3053` 同款钳制）。
        let sent = self.sent_seq.load(Ordering::Acquire);
        let capped = processed_end_seq.min(sent);
        let previous = self.acked_seq.fetch_max(capped, Ordering::AcqRel);
        self.reevaluate_park();
        capped.saturating_sub(previous)
    }

    /// 按当前水位更新 park 状态。**滞回**：只在越过 HIGH 时 park、跌破 LOW 时放行，
    /// 中间区带保持原状——否则排空过程中每个 flush 切片都会 flap 一次。
    fn reevaluate_park(&self) {
        if !self.park_enabled {
            return;
        }
        // 从未收到过 ACK = 对端没有回执能力（web 模式 / 旧前端）。此时 in_flight
        // 只会单调涨，按它判定会把窗口一开局就关死、生产者永久暂停。同 Orca 的
        // dispatcher-ready 看门狗：握手没到就强制放行。
        if !self.ever_acked.load(Ordering::Acquire) {
            return;
        }
        let in_flight = self.in_flight();
        let Ok(mut parked) = self.parked.lock() else {
            return;
        };
        if *parked {
            if in_flight < PRODUCER_FLOW_LOW_WATERMARK_BYTES {
                *parked = false;
                self.park_signal.notify_all();
            }
        } else if in_flight > PRODUCER_FLOW_HIGH_WATERMARK_BYTES {
            *parked = true;
            self.pause_count.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// reader 线程在每次 `read()` 之前调用：若处于暂停态则阻塞在此。
    ///
    /// 返回时保证以下之一成立：未暂停、水位已跌破 LOW、失效超时到点、或
    /// `cancelled` 已置位。**超时后无条件返回一轮**——即便水位仍高：一条丢失的
    /// ACK 不能变成永久静默的终端；若确实仍在洪流中，下一轮会重新 park。
    ///
    /// 返回值是**本次 park 的结局**，供 reader 判定是否需要发 desync 自愈
    /// （Stage 4 看门狗）。
    pub fn park_if_paused(&self, cancelled: &AtomicBool) -> ParkOutcome {
        if !self.park_enabled {
            return ParkOutcome::NotParked;
        }
        let Ok(mut parked) = self.parked.lock() else {
            return ParkOutcome::NotParked;
        };
        if !*parked || cancelled.load(Ordering::Relaxed) {
            return ParkOutcome::NotParked;
        }
        let deadline = Instant::now() + self.failsafe;
        let mut timed_out_waiting = false;
        while *parked && !cancelled.load(Ordering::Relaxed) {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                timed_out_waiting = true;
                break;
            };
            if remaining.is_zero() {
                timed_out_waiting = true;
                break;
            }
            let Ok((next, timeout)) = self.park_signal.wait_timeout(parked, remaining) else {
                return ParkOutcome::NotParked;
            };
            parked = next;
            if timeout.timed_out() {
                timed_out_waiting = true;
                break;
            }
        }
        // 放行一轮。水位仍高的话，下一次 note_sent 会重新 park（= 失效重断言）。
        *parked = false;
        drop(parked);

        if !timed_out_waiting {
            // 被 ACK 排空或 release 唤醒——正常路径。
            self.consecutive_failsafe_timeouts
                .store(0, Ordering::Release);
            return ParkOutcome::Resumed;
        }
        // 超时 = 这一整个失效窗口里没等到足够的 ACK。偶发一次是洪流下的正常抖动；
        // 连续多次说明回执链路已经断了（前端崩了 / 消息丢了 / WebView 卡死），
        // 此时只靠失效超时会变成"每 5 秒放一小口"的龟速终端，必须让前端整屏重建。
        let streak = self
            .consecutive_failsafe_timeouts
            .fetch_add(1, Ordering::AcqRel)
            + 1;
        if streak >= FAILSAFE_TIMEOUTS_BEFORE_DESYNC {
            self.consecutive_failsafe_timeouts
                .store(0, Ordering::Release);
            ParkOutcome::Stalled
        } else {
            ParkOutcome::TimedOut
        }
    }

    /// 拆除释放：kill / exit / 会话销毁必须调用，否则 park 中的 reader 永不醒来。
    ///
    /// 调用方**先置 `cancelled` 再调本函数**，这样被唤醒的 reader 立刻看到取消位
    /// 并退出循环，而不是回头又去 `read()` 一个正在拆的 PTY。
    pub fn release(&self) {
        if let Ok(mut parked) = self.parked.lock() {
            *parked = false;
        }
        self.park_signal.notify_all();
    }

    /// 当前是否处于暂停态（测试与诊断用）。
    pub fn is_parked(&self) -> bool {
        self.parked.lock().map(|parked| *parked).unwrap_or(false)
    }

    /// 累计 park 次数。稳态下应远小于 emit 次数；飙升说明滞回没起作用。
    pub fn pause_count(&self) -> u64 {
        self.pause_count.load(Ordering::Relaxed)
    }

    /// 已 emit 但前端尚未确认的字节数。这就是 Stage 3 的水位输入。
    pub fn in_flight(&self) -> u64 {
        let sent = self.sent_seq.load(Ordering::Acquire);
        let acked = self.acked_seq.load(Ordering::Acquire);
        sent.saturating_sub(acked)
    }

    pub fn sent_seq(&self) -> u64 {
        self.sent_seq.load(Ordering::Acquire)
    }

    pub fn acked_seq(&self) -> u64 {
        self.acked_seq.load(Ordering::Acquire)
    }

    /// 是否收到过 ACK。false 表示对端不支持回执，闸门必须降级放行。
    pub fn ever_acked(&self) -> bool {
        self.ever_acked.load(Ordering::Acquire)
    }

    /// 距上次 ACK 的时长；从未收到过 ACK 时返回 `None`。
    pub fn ack_silence(&self) -> Option<Duration> {
        self.last_ack_at
            .lock()
            .ok()
            .and_then(|slot| slot.map(|at| at.elapsed()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn in_flight_tracks_sent_minus_acked() {
        let gate = OutputFlowGate::new();
        gate.note_sent(Some(1000));
        assert_eq!(gate.in_flight(), 1000);

        assert_eq!(gate.note_acked(400), 400);
        assert_eq!(gate.in_flight(), 600);
    }

    #[test]
    fn ack_is_idempotent_and_tolerates_reordering() {
        // 累计语义的全部意义：重复投递不重复计费，乱序到达不倒退。
        let gate = OutputFlowGate::new();
        gate.note_sent(Some(1000));

        assert_eq!(gate.note_acked(600), 600);
        assert_eq!(gate.note_acked(600), 0, "重复 ACK 不应再次计费");
        assert_eq!(gate.note_acked(200), 0, "迟到的小 seq 不应让游标倒退");
        assert_eq!(gate.acked_seq(), 600);
        assert_eq!(gate.in_flight(), 400);
    }

    #[test]
    fn a_lost_ack_self_heals_on_the_next_one() {
        // 增量 ACK 会让每次丢包变成永久债务；累计值下一次就把账补齐。
        let gate = OutputFlowGate::new();
        gate.note_sent(Some(3000));
        // 假设 1000 那条 ACK 丢了，直接来 3000
        assert_eq!(gate.note_acked(3000), 3000);
        assert_eq!(gate.in_flight(), 0);
    }

    #[test]
    fn ack_is_clamped_to_sent_so_in_flight_never_goes_negative() {
        let gate = OutputFlowGate::new();
        gate.note_sent(Some(100));
        // 损坏或超前的 payload
        assert_eq!(gate.note_acked(u64::MAX), 100);
        assert_eq!(gate.in_flight(), 0);
        assert_eq!(gate.acked_seq(), 100);

        // 之后正常推进 sent 仍然自洽
        gate.note_sent(Some(500));
        assert_eq!(gate.in_flight(), 400);
    }

    #[test]
    fn chunks_without_seq_are_not_counted_in_flight() {
        // 轮询降级路径 end_seq: None（terminal_daemon_event_bridge.rs:396-398）：
        // 上游不计账、前端不回执，两边天然对齐，无需特判。
        let gate = OutputFlowGate::new();
        gate.note_sent(None);
        gate.note_sent(None);
        assert_eq!(gate.in_flight(), 0);
    }

    #[test]
    fn sent_seq_never_moves_backwards() {
        let gate = OutputFlowGate::new();
        gate.note_sent(Some(500));
        gate.note_sent(Some(200));
        assert_eq!(gate.sent_seq(), 500);
    }

    // --- Stage 3：生产者暂停 ---

    /// `armed_gate` 已消化掉的字节。后续算超水位值时要带上它，否则
    /// `HIGH + 1 - ARMED_BASELINE` 恰好等于 HIGH，不满足严格大于。
    const ARMED_BASELINE: u64 = 1;

    /// 让 gate 进入"对端有回执能力"状态，否则闸门会一直降级放行。
    fn armed_gate() -> OutputFlowGate {
        let gate = OutputFlowGate::new();
        gate.note_sent(Some(ARMED_BASELINE));
        gate.note_acked(ARMED_BASELINE);
        gate
    }

    #[test]
    fn parks_above_high_watermark_and_resumes_below_low() {
        let gate = armed_gate();
        gate.note_sent(Some(
            PRODUCER_FLOW_HIGH_WATERMARK_BYTES + 1 + ARMED_BASELINE,
        ));
        assert!(gate.is_parked());

        // 排空到 LOW 以下才放行
        gate.note_acked(PRODUCER_FLOW_HIGH_WATERMARK_BYTES + 1 + ARMED_BASELINE);
        assert!(!gate.is_parked());
    }

    #[test]
    fn hysteresis_prevents_flapping_between_watermarks() {
        // 这条钉住"HIGH/LOW 差 8 倍是刻意的"：排空过程中每个 flush 切片都会调一次
        // note_acked，若按单一阈值判定就会 pause/resume 抖动一整轮。
        //
        // 注意 sent/acked 都是**累计值**，只增不减；in_flight 是二者之差。
        // 模拟排空 = 抬 acked 往 sent 靠。
        let gate = armed_gate();
        let mut sent = PRODUCER_FLOW_HIGH_WATERMARK_BYTES + 1 + ARMED_BASELINE;
        gate.note_sent(Some(sent));
        assert!(gate.is_parked());
        let pauses_after_first = gate.pause_count();

        // 让 in_flight 停在 HIGH 与 LOW 之间反复摆动：始终保持 parked，pause 计数不涨
        for step in 0..20u64 {
            // 排空到略低于 HIGH（仍远高于 LOW）
            let mid = PRODUCER_FLOW_HIGH_WATERMARK_BYTES - 1_000 - step;
            gate.note_acked(sent - mid);
            assert!(gate.in_flight() > PRODUCER_FLOW_LOW_WATERMARK_BYTES);
            assert!(gate.in_flight() < PRODUCER_FLOW_HIGH_WATERMARK_BYTES);
            assert!(gate.is_parked(), "中间区带不应放行");

            // 再灌一点回到 HIGH 之上
            sent += 5_000;
            gate.note_sent(Some(sent));
            assert!(gate.is_parked());
        }
        assert_eq!(
            gate.pause_count(),
            pauses_after_first,
            "滞回区内不应重复 park"
        );
    }

    #[test]
    fn park_returns_immediately_when_cancelled() {
        // 拆除释放的核心：kill 时 reader 必须立刻醒来退出，否则终端永远卡住。
        let gate = armed_gate();
        gate.note_sent(Some(
            PRODUCER_FLOW_HIGH_WATERMARK_BYTES + 1 + ARMED_BASELINE,
        ));
        assert!(gate.is_parked());

        let cancelled = AtomicBool::new(true);
        let started = Instant::now();
        gate.park_if_paused(&cancelled);
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "取消位已置时 park 必须立即返回，实际耗时 {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn release_wakes_a_parked_reader() {
        let gate = Arc::new(armed_gate());
        gate.note_sent(Some(
            PRODUCER_FLOW_HIGH_WATERMARK_BYTES + 1 + ARMED_BASELINE,
        ));
        assert!(gate.is_parked());

        let reader_gate = Arc::clone(&gate);
        let handle = std::thread::spawn(move || {
            let cancelled = AtomicBool::new(false);
            let started = Instant::now();
            reader_gate.park_if_paused(&cancelled);
            started.elapsed()
        });

        // 给 reader 一点时间真正睡进去，再释放
        std::thread::sleep(Duration::from_millis(50));
        gate.release();

        let elapsed = handle.join().expect("reader thread panicked");
        assert!(
            elapsed < PRODUCER_PAUSE_FAILSAFE,
            "release 应当在失效超时之前唤醒 reader，实际 {elapsed:?}"
        );
    }

    #[test]
    fn ack_below_low_watermark_wakes_a_parked_reader() {
        let gate = Arc::new(armed_gate());
        gate.note_sent(Some(
            PRODUCER_FLOW_HIGH_WATERMARK_BYTES + 1 + ARMED_BASELINE,
        ));

        let reader_gate = Arc::clone(&gate);
        let handle = std::thread::spawn(move || {
            let cancelled = AtomicBool::new(false);
            let started = Instant::now();
            reader_gate.park_if_paused(&cancelled);
            started.elapsed()
        });

        std::thread::sleep(Duration::from_millis(50));
        // 正常路径：前端消化完毕，水位跌破 LOW
        gate.note_acked(PRODUCER_FLOW_HIGH_WATERMARK_BYTES + 1 + ARMED_BASELINE);

        let elapsed = handle.join().expect("reader thread panicked");
        assert!(
            elapsed < PRODUCER_PAUSE_FAILSAFE,
            "ACK 排空后应立刻唤醒，而不是等失效超时，实际 {elapsed:?}"
        );
    }

    #[test]
    fn failsafe_timeout_releases_the_reader_even_while_still_flooded() {
        // 整套机制里最危险的一条：ACK 永远不来（前端崩了 / 消息丢了 / 对端卡死）时，
        // park 必须自己到点醒来。没有它，一条丢失的 ACK 就是永久静默的终端。
        // 用注入的短超时验证真实超时路径——置 cancelled 走的是另一条分支，测不到这里。
        let gate = OutputFlowGate::with_test_failsafe(Duration::from_millis(80));
        gate.note_sent(Some(ARMED_BASELINE));
        gate.note_acked(ARMED_BASELINE);
        gate.note_sent(Some(
            PRODUCER_FLOW_HIGH_WATERMARK_BYTES + 1 + ARMED_BASELINE,
        ));
        assert!(gate.is_parked());

        let cancelled = AtomicBool::new(false);
        let started = Instant::now();
        gate.park_if_paused(&cancelled); // 无人来 ACK，只能靠超时
        let elapsed = started.elapsed();

        assert!(
            elapsed >= Duration::from_millis(60),
            "应当真的等过一轮失效窗口，实际 {elapsed:?}"
        );
        assert!(
            elapsed < Duration::from_secs(2),
            "不应等到生产超时，实际 {elapsed:?}"
        );
        assert!(!gate.is_parked(), "超时后必须放行一轮");

        // 失效重断言：水位依旧超标，下一批 emit 再次 park——否则持续洪流会在
        // 第一次超时之后跑脱缰（Orca PRODUCER_PAUSE_REASSERT_INTERVAL_MS 的理由）。
        gate.note_sent(Some(PRODUCER_FLOW_HIGH_WATERMARK_BYTES * 4));
        assert!(gate.is_parked());
        assert_eq!(gate.pause_count(), 2);
    }

    // --- Stage 5：交互快路 ---

    #[test]
    fn echo_right_after_a_keystroke_takes_the_fast_path() {
        let gate = OutputFlowGate::new();
        // 没有按键过 → 一律走合批
        assert!(!gate.is_interactive_echo(10));

        gate.note_input();
        assert!(gate.is_interactive_echo(10));
    }

    #[test]
    fn bulk_output_never_takes_the_fast_path_even_right_after_a_keystroke() {
        // 按下回车后程序开始刷屏——那是刷屏不是回显，合批才是对的。
        let gate = OutputFlowGate::new();
        gate.note_input();
        assert!(!gate.is_interactive_echo(INTERACTIVE_OUTPUT_MAX_BYTES + 1));
        // 边界值本身仍算回显
        assert!(gate.is_interactive_echo(INTERACTIVE_OUTPUT_MAX_BYTES));
    }

    #[test]
    fn empty_batches_never_take_the_fast_path() {
        let gate = OutputFlowGate::new();
        gate.note_input();
        assert!(!gate.is_interactive_echo(0));
    }

    #[test]
    fn the_fast_path_closes_after_the_interactive_window() {
        // 窗口之外的小批输出是程序自发的（心跳、进度条），不该逐条 emit
        // 把 IPC 频率抬回优化之前。
        let gate = OutputFlowGate::new();
        gate.note_input();
        std::thread::sleep(INTERACTIVE_OUTPUT_WINDOW + Duration::from_millis(30));
        assert!(!gate.is_interactive_echo(10));
    }

    // --- Stage 4：投递卡死看门狗 ---

    /// 把 gate 顶到超水位并 park 住，返回它。
    fn flooded_gate(failsafe: Duration) -> OutputFlowGate {
        let gate = OutputFlowGate::with_test_failsafe(failsafe);
        gate.note_sent(Some(ARMED_BASELINE));
        gate.note_acked(ARMED_BASELINE);
        gate.note_sent(Some(
            PRODUCER_FLOW_HIGH_WATERMARK_BYTES + 1 + ARMED_BASELINE,
        ));
        assert!(gate.is_parked());
        gate
    }

    #[test]
    fn consecutive_failsafe_timeouts_escalate_to_stalled() {
        // 一次超时是洪流下的正常抖动，不该惊动用户；连续多次才是"没人在消费"。
        let gate = flooded_gate(Duration::from_millis(40));
        let cancelled = AtomicBool::new(false);

        for round in 1..FAILSAFE_TIMEOUTS_BEFORE_DESYNC {
            assert_eq!(
                gate.park_if_paused(&cancelled),
                ParkOutcome::TimedOut,
                "第 {round} 轮不该升级"
            );
            gate.note_sent(Some(PRODUCER_FLOW_HIGH_WATERMARK_BYTES * (round + 4)));
        }
        assert_eq!(gate.park_if_paused(&cancelled), ParkOutcome::Stalled);
    }

    #[test]
    fn a_normal_wakeup_resets_the_stall_streak() {
        // 最容易写错的一条：若连击计数只增不清，偶发抖动累积起来早晚误判成卡死，
        // 于是好端端的终端每隔一阵就整屏重建一次。
        // failsafe 必须明显长于 ACK 线程的调度延迟——CI macOS runner 上 10ms vs 40ms
        // 会让第二次 park 先超时，streak 升到 2 误报 Stalled。
        let gate = Arc::new(flooded_gate(Duration::from_millis(800)));
        let cancelled = AtomicBool::new(false);

        // 先攒够一次超时
        assert_eq!(gate.park_if_paused(&cancelled), ParkOutcome::TimedOut);

        // 然后来一次正常唤醒：前端消化完毕
        gate.note_sent(Some(PRODUCER_FLOW_HIGH_WATERMARK_BYTES * 8));
        let waker = Arc::clone(&gate);
        let handle = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            waker.note_acked(PRODUCER_FLOW_HIGH_WATERMARK_BYTES * 8);
        });
        assert_eq!(gate.park_if_paused(&cancelled), ParkOutcome::Resumed);
        handle.join().expect("waker thread panicked");

        // 计数已清零：下一次超时应当只是 TimedOut，不该直接判死
        gate.note_sent(Some(PRODUCER_FLOW_HIGH_WATERMARK_BYTES * 16));
        assert_eq!(gate.park_if_paused(&cancelled), ParkOutcome::TimedOut);
    }

    #[test]
    fn stalled_resets_so_the_next_episode_starts_clean() {
        // 判死一次后计数归零：否则此后每一次超时都会立刻再判死，desync 刷屏。
        let gate = flooded_gate(Duration::from_millis(40));
        let cancelled = AtomicBool::new(false);

        for _ in 0..FAILSAFE_TIMEOUTS_BEFORE_DESYNC.saturating_sub(1) {
            assert_eq!(gate.park_if_paused(&cancelled), ParkOutcome::TimedOut);
            gate.note_sent(Some(PRODUCER_FLOW_HIGH_WATERMARK_BYTES * 8));
        }
        assert_eq!(gate.park_if_paused(&cancelled), ParkOutcome::Stalled);

        gate.note_sent(Some(PRODUCER_FLOW_HIGH_WATERMARK_BYTES * 16));
        assert_eq!(
            gate.park_if_paused(&cancelled),
            ParkOutcome::TimedOut,
            "判死后应从头累计，而不是每次都判死"
        );
    }

    #[test]
    fn cancelled_and_unparked_paths_report_not_parked() {
        // 拆除路径不该被误记成卡死——kill 一个刷屏会话是正常操作，不是故障。
        let gate = flooded_gate(Duration::from_millis(40));
        let cancelled = AtomicBool::new(true);
        assert_eq!(gate.park_if_paused(&cancelled), ParkOutcome::NotParked);

        // SSH 的 disabled gate 同理
        let ssh = OutputFlowGate::disabled();
        assert_eq!(
            ssh.park_if_paused(&AtomicBool::new(false)),
            ParkOutcome::NotParked
        );
    }

    #[test]
    fn kill_sequence_wakes_a_parked_reader_which_then_sees_the_cancel_flag() {
        // 端到端复现 kill 路径的顺序契约：**先置 cancelled 再 release**。
        // 顺序反了的话，被唤醒的 reader 会先看到"未取消 + 未 parked"就回头
        // read() 一个正在拆的 PTY；漏掉 release 则它要空等一整个失效窗口。

        let gate = Arc::new(armed_gate());
        let cancelled = Arc::new(AtomicBool::new(false));
        gate.note_sent(Some(
            PRODUCER_FLOW_HIGH_WATERMARK_BYTES + 1 + ARMED_BASELINE,
        ));
        assert!(gate.is_parked());

        // 模拟 reader 循环：park → 醒来 → 检查取消位
        let reader_gate = Arc::clone(&gate);
        let reader_cancelled = Arc::clone(&cancelled);
        let handle = std::thread::spawn(move || {
            let started = Instant::now();
            reader_gate.park_if_paused(&reader_cancelled);
            let woke_cancelled = reader_cancelled.load(Ordering::Relaxed);
            (started.elapsed(), woke_cancelled)
        });

        std::thread::sleep(Duration::from_millis(50));
        // kill() 的顺序：cancelled 先，release 后（terminal_service.rs kill 路径）
        cancelled.store(true, Ordering::Relaxed);
        gate.release();

        let (elapsed, woke_cancelled) = handle.join().expect("reader thread panicked");
        assert!(
            elapsed < PRODUCER_PAUSE_FAILSAFE,
            "kill 必须立刻唤醒 reader，而不是等失效超时，实际 {elapsed:?}"
        );
        assert!(woke_cancelled, "reader 醒来时必须已经能看到取消位");
    }

    #[test]
    fn a_gate_that_never_got_an_ack_never_parks() {
        // web 模式无回执通道、旧前端不认这条命令：in_flight 只会单调涨，
        // 按它判定会把窗口一开局就关死。
        let gate = OutputFlowGate::new();
        gate.note_sent(Some(PRODUCER_FLOW_HIGH_WATERMARK_BYTES * 100));
        assert!(!gate.is_parked());
        assert_eq!(gate.pause_count(), 0);

        let cancelled = AtomicBool::new(false);
        let started = Instant::now();
        gate.park_if_paused(&cancelled); // 必须立即返回
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn ssh_gates_never_park() {
        // 同主机多终端共享一个 ssh2 Session：停读一个 channel 会阻塞共享传输，
        // 且 keepalive 只在 read() 内部发，park 超 15s 直接掉线。
        let gate = OutputFlowGate::disabled();
        gate.note_sent(Some(1));
        gate.note_acked(1);
        gate.note_sent(Some(PRODUCER_FLOW_HIGH_WATERMARK_BYTES * 100));
        assert!(!gate.is_parked());
        assert_eq!(gate.pause_count(), 0);

        // 记账照常工作（有界通道与看门狗仍然生效）
        assert!(gate.in_flight() > PRODUCER_FLOW_HIGH_WATERMARK_BYTES);
    }

    #[test]
    fn ever_acked_starts_false_so_the_gate_can_degrade() {
        // web 模式无 ACK 通道、旧前端不认这条命令——闸门必须靠这个标志放行，
        // 否则它们的窗口一开局就关死，生产者永久暂停。
        let gate = OutputFlowGate::new();
        assert!(!gate.ever_acked());
        assert!(gate.ack_silence().is_none());

        gate.note_sent(Some(10));
        gate.note_acked(10);
        assert!(gate.ever_acked());
        assert!(gate.ack_silence().is_some());
    }
}
