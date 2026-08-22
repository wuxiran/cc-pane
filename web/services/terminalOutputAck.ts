// 输出投递回执（docs/71 §9.2 缺口 B-5）。
//
// 把"前端已经消化到哪个 endSeq"报回 Rust，让上游第一次看得见下游的消费速度。
// Stage 2 只记账不设闸门——先让数据说话，闸门在 Stage 3（生产者暂停）接上。
//
// ## 为什么不复用 terminalOutputSeqTracker
//
// 那本账是给 checkpoint 锚点用的，**故意保守**：xterm 不在、数据进隐藏积压、写
// 失败，三处都会 invalidateSeq（terminalOutputHandler.ts:129/154/173）。对拍照而
// 言"禁拍"是安全的；对流控而言是致命的——后台标签的每个 chunk 都会 invalidate，
// ACK 永不推进 → 信用窗口永久关闭 → 生产者永久暂停 → 终端彻底卡死。
//
// 流控的规则相反：chunk 被解析**或被任何丢弃路径丢弃**都要归还信用
// （Orca `pane-terminal-output-scheduler.ts:40`）。两本账语义冲突，必须并存分离。
//
// ## 记账形式
//
// 累计值 + max-merge（照 Orca `src/main/ipc/pty.ts:3044-3074`）：天然幂等、容忍
// 乱序、丢一条自愈。增量 ACK 会让每次丢包变成永久债务。
import { invokeIfTauri } from "./runtime";

/** killswitch：置 false 完全停止上报（Rust 侧随之看不到 ACK，闸门须自行降级）。 */
export const OUTPUT_ACK_ENABLED: boolean = true;

/** 累计到这么多字节就立刻上报。Orca 用 192KB，但那是跨主机链路；对齐我们自己 16KB/16ms 的节奏即可。 */
export const ACK_BATCH_CHARS = 64 * 1024;
/** 攒够时间也上报，覆盖低吞吐场景。 */
export const ACK_FLUSH_MS = 50;

interface AckState {
  /** 已消化的最大 endSeq（单调）。 */
  processedEndSeq: number;
  /** 距上次上报新增的字符数，用于触发按量刷出。 */
  charsSinceReport: number;
  /** 已上报过的值，避免无变化时的空转上报。 */
  reportedEndSeq: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const states = new Map<string, AckState>();

/** 可注入的上报通道，测试用。 */
let reporter: (sessionId: string, processedEndSeq: number) => void = (sessionId, processedEndSeq) => {
  void invokeIfTauri("ack_terminal_output", { sessionId, processedEndSeq }).catch(() => {
    // 吞掉：ACK 是骑在数据路径上的优化，上报失败绝不能破坏渲染或退出处理
    // （照 Orca safePause/safeResume 的理由）。丢掉的 ACK 由累计语义在下一次自愈。
  });
};

function stateOf(sessionId: string): AckState {
  let state = states.get(sessionId);
  if (!state) {
    state = { processedEndSeq: 0, charsSinceReport: 0, reportedEndSeq: 0, timer: null };
    states.set(sessionId, state);
  }
  return state;
}

function clearTimer(state: AckState): void {
  if (!state.timer) return;
  clearTimeout(state.timer);
  state.timer = null;
}

function flush(sessionId: string): void {
  const state = states.get(sessionId);
  if (!state) return;
  clearTimer(state);
  state.charsSinceReport = 0;
  if (state.processedEndSeq <= state.reportedEndSeq) return;
  state.reportedEndSeq = state.processedEndSeq;
  reporter(sessionId, state.processedEndSeq);
}

/**
 * 记录一个 chunk 已被消化——**解析完成或被丢弃都算**。
 *
 * `endSeq` 缺失的 chunk 直接忽略：Rust 侧只在附了 endSeq 时才计 in-flight
 * （轮询降级路径 end_seq: None，terminal_daemon_event_bridge.rs:396-398），
 * 两边天然对齐，无需特判。
 */
export function noteOutputConsumed(sessionId: string, endSeq: number | undefined, chars: number): void {
  if (!OUTPUT_ACK_ENABLED || typeof endSeq !== "number") return;
  const state = stateOf(sessionId);
  // max-merge：多视图（主标签 + 星标镜像）各写各的 xterm，完成顺序不定；
  // 滞后视图的迟到确认不能把游标拽回去。
  if (endSeq > state.processedEndSeq) state.processedEndSeq = endSeq;
  state.charsSinceReport += chars;

  if (state.charsSinceReport >= ACK_BATCH_CHARS) {
    flush(sessionId);
    return;
  }
  if (!state.timer) {
    state.timer = setTimeout(() => flush(sessionId), ACK_FLUSH_MS);
  }
}

/** 立即上报（会话销毁 / 页面卸载 / resync 收尾）。 */
export function flushOutputAck(sessionId: string): void {
  if (!OUTPUT_ACK_ENABLED) return;
  flush(sessionId);
}

/** 会话销毁：补发最后一次 ACK 再清账，免得上游把这批字节永远算作在途。 */
export function clearOutputAck(sessionId: string): void {
  flush(sessionId);
  const state = states.get(sessionId);
  if (state) clearTimer(state);
  states.delete(sessionId);
}

/** 诊断用：前端认为自己已消化到哪。 */
export function processedEndSeqFor(sessionId: string): number {
  return states.get(sessionId)?.processedEndSeq ?? 0;
}

/** 测试用：替换上报通道。 */
export function _setOutputAckReporterForTest(
  next: (sessionId: string, processedEndSeq: number) => void,
): void {
  reporter = next;
}

/** 测试用。 */
export function _resetOutputAckForTest(): void {
  for (const state of states.values()) clearTimer(state);
  states.clear();
}
