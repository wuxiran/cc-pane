// 无订阅者期间的输出暂存策略（docs/71 §3.2 缺口 B-2）。
//
// 旧行为是"丢最旧一半"（`buf.splice(0, buf.length - MAX/2)`）。它会把 VT 转义
// 序列**拦腰切断**——而 VT 是有状态流，半截序列进 xterm 就是花屏。这正是
// §3.1 desync 契约明令禁止的事（"绝不掐 VT 流中段"，
// cc-panes-daemon/src/ws_emitter.rs:24-28）：同一个仓库里，daemon 镜像流溢出走
// "整段跳过 + snapshot 重放"，前端暂存溢出却走"切断"，两条路径对同一风险采取
// 了相反策略。本模块把前端这条对齐到 desync 契约。
//
// 上限改用**字符数**而非 chunk 数：1000 个 chunk 可能是 256B 也可能是 1GB，
// 条数不能预测内存（docs/71 §3.3 差异 1「量纲」）。
//
// 闩锁的必要性：溢出发生时**按定义没有输出订阅者**（有的话就直接分发了），
// 此时 desync 回调多半也还没注册（binding 里 registerOutput 先于 registerDesync，
// terminalSessionBinding.ts:234-289）。所以溢出只能先闩住，等 registerDesync
// 到达时补投——直接广播会静默丢掉这次通知，前端带着缺口画面继续跑。

/** 暂存上限。UTF-16 code unit 计数，与 terminalHiddenWriteBuffer 的口径一致。 */
export const PENDING_BUFFER_MAX_CHARS = 2 * 1024 * 1024;

/**
 * killswitch：置 false 回退旧的"按 chunk 数丢最旧一半"行为。
 *
 * 显式标注 `boolean` 而非让 TS 推成字面量 `true`——否则 `!DESYNC_ON_PENDING_OVERFLOW`
 * 会被窄化成恒假，回退分支变成死代码，翻开关时才发现它早被摇树摇掉了。
 */
export const DESYNC_ON_PENDING_OVERFLOW: boolean = true;

/** killswitch 关闭时沿用的旧上限。 */
export const LEGACY_MAX_PENDING_CHUNKS = 1000;

export interface PendingChunk {
  data: string;
  /** daemon raw 字节空间的 chunk 末尾 seq；轮询降级路径无此值。 */
  endSeq?: number;
}

interface PendingBufferState {
  chunks: PendingChunk[];
  chars: number;
  /** 已溢出：内容整体作废，后续 chunk 一并丢弃，直到订阅者到达并走 snapshot 重放。 */
  overflowed: boolean;
}

export type AppendPendingOutcome =
  /** 正常入队。 */
  | "buffered"
  /** **本次**越界：内容整体作废，调用方应触发一次 desync 路径。 */
  | "overflowed"
  /** 此前已溢出，本 chunk 直接丢弃。调用方**不要**重复广播 desync（见下）。 */
  | "discarded"
  /** killswitch 关闭时的旧行为：丢掉了最旧的一批 chunk。 */
  | "trimmed-oldest";

const buffers = new Map<string, PendingBufferState>();
/** 溢出闩锁：等待被 registerDesync 消费的会话。 */
const latchedDesync = new Set<string>();

function stateOf(sessionId: string): PendingBufferState {
  let state = buffers.get(sessionId);
  if (!state) {
    state = { chunks: [], chars: 0, overflowed: false };
    buffers.set(sessionId, state);
  }
  return state;
}

/**
 * 暂存一个无人接收的 chunk。
 *
 * 返回 `"overflowed"` 时调用方**必须**走 desync 路径（作废 seq 记账 + 广播），
 * 本模块已同时闩住该会话，供稍后到达的 registerDesync 补投。
 */
export function appendPendingOutput(
  sessionId: string,
  data: string,
  endSeq?: number,
): AppendPendingOutcome {
  const state = stateOf(sessionId);

  if (!DESYNC_ON_PENDING_OVERFLOW) {
    state.chunks.push({ data, endSeq });
    if (state.chunks.length > LEGACY_MAX_PENDING_CHUNKS) {
      state.chunks.splice(0, state.chunks.length - LEGACY_MAX_PENDING_CHUNKS / 2);
      return "trimmed-oldest";
    }
    return "buffered";
  }

  // 已溢出：内容整体作废，继续攒新 chunk 没有意义——前端终究要从 snapshot 重建，
  // 攒下的这些既补不齐缺口，又是纯内存开销。
  //
  // 只在**越界那一次**返回 "overflowed"：洪流下这里每 chunk 都会命中，逐次广播
  // 会变成 desync 风暴。resync 在途时 createTerminalDesyncHandler 会去重
  // （terminalResync.ts:148），但一轮结束后的下一次仍会重新触发整屏重建。
  // 闩锁保证迟到的订阅者照样收得到，不靠重复广播兜底。
  if (state.overflowed) return "discarded";

  state.chunks.push({ data, endSeq });
  state.chars += data.length;
  if (state.chars <= PENDING_BUFFER_MAX_CHARS) return "buffered";

  state.chunks = [];
  state.chars = 0;
  state.overflowed = true;
  latchedDesync.add(sessionId);
  return "overflowed";
}

/**
 * 取走暂存内容并清空（首个订阅者 flush 用）。
 *
 * 溢出过的会话返回空数组——那批内容中段有缺口，重放它只会花屏；正确的补救是
 * 闩锁触发的 snapshot 重建。
 */
export function takePendingOutput(sessionId: string): PendingChunk[] {
  const state = buffers.get(sessionId);
  if (!state) return [];
  buffers.delete(sessionId);
  return state.overflowed ? [] : state.chunks;
}

/** 消费溢出闩锁（一次性）。registerDesync 用它给迟到的订阅者补投 desync。 */
export function consumeLatchedDesync(sessionId: string): boolean {
  return latchedDesync.delete(sessionId);
}

/** 诊断日志用。 */
export function pendingChunkCount(sessionId: string): number {
  return buffers.get(sessionId)?.chunks.length ?? 0;
}

/** 会话销毁清理。 */
export function clearPendingOutput(sessionId: string): void {
  buffers.delete(sessionId);
  latchedDesync.delete(sessionId);
}

/** 全量清理（HMR dispose / 监听器重置 / 测试）。 */
export function clearAllPendingOutput(): void {
  buffers.clear();
  latchedDesync.clear();
}
