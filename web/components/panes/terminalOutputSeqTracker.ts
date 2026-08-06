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
  checkpointEpoch: number;
}

interface SeqTrackerEntry {
  lastReceivedEndSeq: number | null;
  lastWrittenEndSeq: number | null;
  checkpointEpoch: number | null;
  valid: boolean;
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
    };
    entries.set(sessionId, entry);
  }
  return entry;
}

/** 收到带 endSeq 的输出 chunk（daemon 下发；轮询降级模式无 endSeq，不调本函数）。 */
export function noteReceived(sessionId: string, endSeq: number): void {
  const entry = entryOf(sessionId);
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

/** 该 chunk 已完成 render → write（xterm 确认解析）。 */
export function noteWritten(sessionId: string, endSeq: number): void {
  const entry = entryOf(sessionId);
  if (entry.lastWrittenEndSeq !== null && endSeq <= entry.lastWrittenEndSeq) {
    devDebugLog("seq-tracker", "non-monotonic written seq; invalidating", {
      sessionId,
      endSeq,
      last: entry.lastWrittenEndSeq,
    });
    entry.valid = false;
  }
  entry.lastWrittenEndSeq = endSeq;
}

/** desync 开始 / 积压溢出：中段缺失，禁拍直到 reanchor。 */
export function invalidateSeq(sessionId: string): void {
  const entry = entries.get(sessionId);
  if (!entry) return;
  entry.valid = false;
}

/** 统一恢复完成：用恢复响应的 endSeq/epoch 重锚，恢复可拍。 */
export function reanchorSeq(sessionId: string, endSeq: number, checkpointEpoch: number): void {
  entries.set(sessionId, {
    lastReceivedEndSeq: endSeq,
    lastWrittenEndSeq: endSeq,
    checkpointEpoch,
    valid: true,
  });
}

/** epoch 首次/更新登记（输出侧或恢复侧带来）。epoch 变化 = daemon/会话重建，旧 seq 作废。 */
export function noteEpoch(sessionId: string, checkpointEpoch: number): void {
  const entry = entryOf(sessionId);
  if (entry.checkpointEpoch !== null && entry.checkpointEpoch !== checkpointEpoch) {
    entry.valid = false;
    entry.lastReceivedEndSeq = null;
    entry.lastWrittenEndSeq = null;
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
