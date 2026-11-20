// 快照回放与实时流的对账。
//
// 恢复快照带 endSeq（daemon raw 字节空间里它覆盖到哪）。实时流里 endSeq 不超过它的
// 部分快照已经包含，再写一遍就是重复：普通文本多出几行，相对光标移动会在错误的行上
// 重画，表现为重叠、残影、错行。
//
// seq 的单位：后端 ReplayBuffer 每 push 一个 chunk 累加 `data.len()`（UTF-8 字节数），
// 下发的字符串就是那些 chunk 的拼接，所以「一帧的 UTF-8 字节数」精确等于它占的 seq
// 跨度，快照 endSeq 也必落在 chunk 边界上（不会切在字符中间）。
//
// 前端的输出调度器会把超过 16K 码元的一帧拆成几片逐片投递，**只有最后一片带 endSeq**
// （terminalOutputScheduler.ts）。所以对账的单位是「帧」不是「片」：没带 endSeq 的片
// 要先攒着，等带 endSeq 的那片到了才知道这一帧落在快照的哪一侧。拆片按 UTF-16 下标
// 进行，可能切开代理对——拼回整帧再按字节裁就没有这个问题。
//
// 重复的来源有三处，都走这里：
// 1. 重同步闸门期暂存的输出（快照请求在途时到达）；
// 2. 快照已包含、但闸门放开之后才送到视图的迟到帧（卡在后端批处理/事件桥/调度队列里）；
// 3. 先回放、后注册回调的路径上，订阅前暂存的输出。

export interface SeqChunk {
  data: string;
  endSeq?: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 攒着的片最多等这么久还没等到帧尾，就原样放行（不去重好过永远不显示）。 */
export const RECONCILE_HOLD_TIMEOUT_MS = 250;
/**
 * 对账状态最多保留这么久。迟到帧毫秒级就会到；保留太久的话，daemon / PTY 重建后
 * seq 从头计，新流的开头会被陈旧的下限误判成「已包含」。
 */
export const RECONCILE_ARMED_TTL_MS = 15_000;

export interface SnapshotReconciler {
  /** 成功恢复后调用：此后 endSeq 不超过 `floorSeq` 的帧视为快照已包含。 */
  arm(floorSeq: number): void;
  /** 是否还在对账。为假时调用方应直接走正常写入路径。 */
  active(): boolean;
  /**
   * 收下一片，返回现在可以写的内容（可能为空：被丢弃，或在等帧尾）。
   * 一帧越过下限后对账结束，之后 `active()` 为假。
   */
  accept(data: string, endSeq?: number): SeqChunk[];
  /** 取走还攒着的片并结束对账（解绑、重同步开始时调用）。 */
  disarm(): SeqChunk[];
}

interface SnapshotReconcilerOptions {
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** 攒着的片超时放行时调用，参数就是这些片拼成的内容。 */
  onHoldTimeout?: (chunk: SeqChunk) => void;
}

export function createSnapshotReconciler(options: SnapshotReconcilerOptions = {}): SnapshotReconciler {
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let floorSeq: number | null = null;
  let armedAt = 0;
  let held: string[] = [];
  let holdTimer: unknown = null;

  const stopHoldTimer = () => {
    if (holdTimer === null) return;
    clearTimer(holdTimer);
    holdTimer = null;
  };
  const takeHeld = (): SeqChunk[] => {
    stopHoldTimer();
    if (held.length === 0) return [];
    const data = held.join("");
    held = [];
    return [{ data }];
  };
  const finish = (): SeqChunk[] => {
    floorSeq = null;
    return takeHeld();
  };

  return {
    arm(nextFloor) {
      // 重新武装（又一轮恢复）：上一轮攒着的片属于被替换掉的画面，丢弃。
      stopHoldTimer();
      held = [];
      floorSeq = nextFloor;
      armedAt = now();
    },
    active: () => floorSeq !== null,
    accept(data, endSeq) {
      if (floorSeq === null) return data ? [{ data, endSeq }] : [];
      if (now() - armedAt > RECONCILE_ARMED_TTL_MS) {
        return [...finish(), ...(data ? [{ data, endSeq }] : [])];
      }
      if (endSeq === undefined) {
        if (!data) return [];
        held.push(data);
        if (holdTimer === null) {
          holdTimer = setTimer(() => {
            holdTimer = null;
            for (const chunk of finish()) options.onHoldTimeout?.(chunk);
          }, RECONCILE_HOLD_TIMEOUT_MS);
        }
        return [];
      }
      // 帧尾到了：攒着的片 + 这一片 = 一整帧（或它的后半段），终点是 endSeq。
      stopHoldTimer();
      const frame = held.join("") + data;
      held = [];
      if (endSeq <= floorSeq) return [];
      const boundary = floorSeq;
      floorSeq = null;
      const bytes = encoder.encode(frame);
      const overlap = boundary - (endSeq - bytes.length);
      if (overlap <= 0) return [{ data: frame, endSeq }];
      return [{ data: decoder.decode(bytes.subarray(overlap)), endSeq }];
    },
    disarm: finish,
  };
}

/** 重同步闸门期的实时输出暂存：存原始数据和 endSeq，不提前过渲染变换。 */
export interface ResyncGateBacklog {
  push(data: string, endSeq?: number): void;
  /** 取出全部并清空。`overflowed` 为真时内容不完整。 */
  take(): { chunks: SeqChunk[]; overflowed: boolean };
  /** 暂存是否已溢出（中段缺失）。 */
  overflowed(): boolean;
  /** 当前暂存了几片。 */
  count(): number;
  reset(): void;
  pendingLength(): number;
}

const DEFAULT_GATE_BACKLOG_CHARS = 512 * 1024;

export function createResyncGateBacklog(maxChars = DEFAULT_GATE_BACKLOG_CHARS): ResyncGateBacklog {
  let chunks: SeqChunk[] = [];
  let length = 0;
  let overflowed = false;
  const clear = () => {
    chunks = [];
    length = 0;
    overflowed = false;
  };
  return {
    push(data, endSeq) {
      if (!data || overflowed) return;
      if (length + data.length > maxChars) {
        // 带缺口的积压写出来必然花屏：整段作废，交给下一轮快照。
        chunks = [];
        length = 0;
        overflowed = true;
        return;
      }
      chunks.push({ data, endSeq });
      length += data.length;
    },
    take() {
      const result = { chunks, overflowed };
      clear();
      return result;
    },
    overflowed: () => overflowed,
    count: () => chunks.length,
    reset: clear,
    pendingLength: () => length,
  };
}
