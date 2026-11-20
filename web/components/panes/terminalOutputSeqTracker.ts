// 输出流 seq 跟踪（M3b-2，.claude/plan-m3b-design.md 评审修订 1）。
//
// checkpoint 的配对身份是 daemon raw 字节空间里的 anchorSeq。前端写进 xterm
// 的是**渲染后**字节（alt-strip 过，长度不同），所以锚点绝不能数「前端写了
// 多少字节」——只能引用 daemon 随输出下发的 **chunk endSeq**：
// - noteReceived：收到带 endSeq 的 chunk（尚未写完）；
// - noteWritten：该 chunk 过完 render → write 回调（xterm 已确认解析）；
// - 锚点候选 = 已写完的最后 endSeq，且**无 in-flight**（received == written）
//   ——write 队列异步，带着未落屏的字节拍照会缺尾。
//
// 失效语义：desync / 积压溢出后前端不再知道自己写到哪（中段整段缺失），
// invalidate 置为无效并**禁拍**，直到统一恢复完成用响应的 endSeq reanchor。
// seq 非单调（缺口/回绕）视同失效——评审要求的 dev 断言方向。
import { devDebugLog } from "@/utils/devLogger";

export interface SeqAnchorCandidate {
  anchorSeq: number;
  checkpointEpoch: string;
}

interface SeqTrackerEntry {
  lastReceivedEndSeq: number | null;
  lastWrittenEndSeq: number | null;
  checkpointEpoch: string | null;
  valid: boolean;
  /**
   * 最近一次恢复覆盖到的 endSeq。恢复之后才送到的、seq 不超过它的帧是「快照已包含的
   * 迟到帧」（卡在后端批处理/事件桥/调度队列里），不是缺口——不能因此判失效。
   * 收到越过它的帧后清空。
   */
  recoveredThroughSeq: number | null;
}

const entries = new Map<string, SeqTrackerEntry>();

function entryOf(sessionId: string): SeqTrackerEntry {
  let entry = entries.get(sessionId);
  if (!entry) {
    entry = {
      lastReceivedEndSeq: null,
      lastWrittenEndSeq: null,
      checkpointEpoch: null,
      valid: true,
      recoveredThroughSeq: null,
    };
    entries.set(sessionId, entry);
  }
  return entry;
}

/** 收到带 endSeq 的输出 chunk（daemon 下发；轮询降级模式无 endSeq，不调本函数）。 */
export function noteReceived(sessionId: string, endSeq: number): void {
  const entry = entryOf(sessionId);
  if (entry.recoveredThroughSeq !== null) {
    if (endSeq <= entry.recoveredThroughSeq) return;
    entry.recoveredThroughSeq = null;
  }
  if (entry.lastReceivedEndSeq !== null && endSeq <= entry.lastReceivedEndSeq) {
    // 非单调 = 缺口或会话重建：前端已无法自证连续，视同 desync 失效禁拍
    devDebugLog("seq-tracker", "non-monotonic received seq; invalidating", {
      sessionId,
      endSeq,
      last: entry.lastReceivedEndSeq,
    });
    entry.valid = false;
  }
  entry.lastReceivedEndSeq = endSeq;
}

/**
 * 该 chunk 已完成 render → write（xterm 确认解析）。
 *
 * 同一 chunk 可能被多个视图（主标签 + 星标镜像 + 弹窗）各写一遍自己的 xterm，
 * 且各视图完成顺序不定——`endSeq ≤ 已确认` 是滞后视图的重复/迟到确认，不是
 * 回绕，直接忽略（锚点取最大已确认 seq）。真正的会话重建/缺口由 noteReceived
 * 的非单调判定负责失效（received 只在分发单点记一次，没有多视图重复问题）。
 */
export function noteWritten(sessionId: string, endSeq: number): void {
  const entry = entryOf(sessionId);
  if (entry.lastWrittenEndSeq !== null && endSeq <= entry.lastWrittenEndSeq) return;
  entry.lastWrittenEndSeq = endSeq;
}

/**
 * 重同步闸门期暂存的 chunk 在快照之后补写：把「已收到」推进到它，不做非单调判定。
 * 这批 chunk 当初分发时已经记过一次 received，随后被 reanchor 拉回了快照 endSeq；
 * 多视图各补写一遍时也会重复到同一个 seq——都不是缺口。
 */
export function noteBacklogReplayed(sessionId: string, endSeq: number): void {
  const entry = entryOf(sessionId);
  if (entry.lastReceivedEndSeq === null || endSeq > entry.lastReceivedEndSeq) {
    entry.lastReceivedEndSeq = endSeq;
  }
}

/** 这个会话已经分发到哪（不分视图）。副视图用它判断自己回放期间有没有漏收。 */
export function receivedThroughSeq(sessionId: string): number | null {
  return entries.get(sessionId)?.lastReceivedEndSeq ?? null;
}

/** desync 开始 / 积压溢出：中段缺失，禁拍直到 reanchor。 */
export function invalidateSeq(sessionId: string): void {
  const entry = entries.get(sessionId);
  if (!entry) return;
  entry.valid = false;
}

/** 统一恢复完成：用恢复响应的 endSeq/epoch 重锚，恢复可拍。 */
export function reanchorSeq(sessionId: string, endSeq: number, checkpointEpoch: string): void {
  entries.set(sessionId, {
    lastReceivedEndSeq: endSeq,
    lastWrittenEndSeq: endSeq,
    checkpointEpoch,
    valid: true,
    recoveredThroughSeq: endSeq,
  });
}

/** epoch 首次/更新登记（输出侧或恢复侧带来）。epoch 变化 = daemon/会话重建，旧 seq 作废。 */
export function noteEpoch(sessionId: string, checkpointEpoch: string): void {
  const entry = entryOf(sessionId);
  if (entry.checkpointEpoch !== null && entry.checkpointEpoch !== checkpointEpoch) {
    entry.valid = false;
    entry.lastReceivedEndSeq = null;
    entry.lastWrittenEndSeq = null;
    entry.recoveredThroughSeq = null;
  }
  entry.checkpointEpoch = checkpointEpoch;
}

/**
 * 锚点候选：可拍条件 = 未失效 && 有已写完的 seq && 无 in-flight
 * （received == written）&& 已知 epoch。任一不满足返回 null（跳过本轮拍照）。
 */
export function anchorCandidate(sessionId: string): SeqAnchorCandidate | null {
  const entry = entries.get(sessionId);
  if (!entry || !entry.valid) return null;
  if (entry.lastWrittenEndSeq === null || entry.checkpointEpoch === null) return null;
  if (entry.lastReceivedEndSeq !== entry.lastWrittenEndSeq) return null;
  return { anchorSeq: entry.lastWrittenEndSeq, checkpointEpoch: entry.checkpointEpoch };
}

/** 会话销毁清理（会话键卫星态：registry 的 terminal onClosed 统一调）。 */
export function clearSeqTracker(sessionId: string): void {
  entries.delete(sessionId);
}

/** 测试用。 */
export function _resetSeqTrackersForTest(): void {
  entries.clear();
}
