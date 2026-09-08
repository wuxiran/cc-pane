// 拍照与上传（M3b-2，.claude/plan-m3b-design.md §M3b-2）。
//
// 统一守卫由 anchorCandidate 承担：失效 / in-flight / 无 epoch 全部返回 null。
// **M3b-2 阶段前端拿不到 epoch**（epoch 随 M3b-3 的恢复读返回），所以
// anchorCandidate 恒 null、上传链路全 dormant——这是设计内的绞杀者顺序：
// 写侧先行落地，读侧（M3b-3 reanchor）接通后自动激活。测试用 reanchorSeq
// 手动喂 epoch 激活。
//
// 三个触发点（接线见 useTerminalHibernation 与 terminalSessionBinding）：
// ① 休眠 Tier2（serialize 已在手，经 snapshotAnsi 复用，避免二次全量序列化）；
// ② 隐藏 1s 边沿（Tier1，xterm 还活着）；
// ③ daemon 补拍请求（terminal-checkpoint-request）。
import type { TerminalCheckpointUpload } from "@/types";
import { devDebugLog } from "@/utils/devLogger";
import { uploadCheckpoint } from "@/services/terminalCheckpoint";
import { registerSessionScopedResource } from "@/lib/tabLifecycle/sessionScopedResources";
import { anchorCandidate, invalidateSeq } from "./terminalOutputSeqTracker";
import { noteCheckpointResult } from "@/services/performanceRecoveryMetrics";

/** 每会话上传去抖：18 个标签同时过隐藏边沿也只各打一次（M3b 风险表）。 */
export const CHECKPOINT_UPLOAD_DEBOUNCE_MS = 60_000;

const lastAttemptAtMs = new Map<string, number>();
const inFlight = new Map<string, { done: Promise<void>; finish: () => void }>();
const acceptedAnchors = new Map<string, { epoch: string; seq: number }>();

/** xterm Terminal 的结构子集（测试可注入假实现）。 */
export interface CheckpointTerminal {
  cols: number;
  rows: number;
  buffer: { active: { type: "normal" | "alternate" } };
}

export interface CheckpointSerializer {
  serialize(): string;
}

export interface CaptureCheckpointOptions {
  canCapture?: () => boolean;
  /** 触发来源，只进 debug 日志。 */
  reason: string;
  /** 已在手的 serialize 产物（休眠路径复用）；缺省时现场 serialize。 */
  snapshotAnsi?: string;
  /** 测试注入时钟。 */
  nowMs?: number;
}

export type CaptureCheckpointResult =
  | "skipped-no-terminal"
  | "skipped-no-anchor"
  | "skipped-debounce"
  | "skipped-capability"
  | "serialize-failed"
  | "uploaded"
  | "rejected"
  | "failed";

/**
 * 取锚点候选 → serialize → 上传。fire-and-forget 安全（绝不抛异常）。
 *
 * 结果语义：
 * - 409 拒收是结果不是错误：STALE/GAP/FUTURE 无害（debug log 即可，幂等重传
 *   或窗口前移的正常竞态）；EPOCH_MISMATCH = 本端 seq 记账整体过期 →
 *   invalidateSeq（禁拍直到统一恢复 reanchor）。
 * - capability 关断（旧 daemon）由 uploadCheckpoint 返回 null 表达。
 */
export async function captureAndUploadCheckpoint(
  sessionId: string,
  term: CheckpointTerminal | null,
  serializeAddon: CheckpointSerializer | null,
  options: CaptureCheckpointOptions,
): Promise<CaptureCheckpointResult> {
  const { reason } = options;
  const done = (result: CaptureCheckpointResult, detail: string = result): CaptureCheckpointResult => {
    noteCheckpointResult(sessionId, detail); return result;
  };
  // 休眠中无 xterm / 实例未建：跳过本次（daemon 补拍会周期重发）。
  if (!term || options.canCapture?.() === false || (options.snapshotAnsi === undefined && !serializeAddon)) {
    return done("skipped-no-terminal");
  }
  const candidate = anchorCandidate(sessionId);
  if (!candidate) {
    devDebugLog("terminal-checkpoint", "skip: no anchor candidate", { sessionId, reason });
    return done("skipped-no-anchor");
  }
  const now = options.nowMs ?? Date.now();
  const last = lastAttemptAtMs.get(sessionId);
  const accepted = acceptedAnchors.get(sessionId);
  const pending = inFlight.get(sessionId);
  if (pending) {
    if (reason !== "recovery.complete") return done("skipped-debounce", "skipped-in-flight");
    await pending.done;
    return captureAndUploadCheckpoint(sessionId, term, serializeAddon, options);
  }
  if (accepted?.epoch === candidate.checkpointEpoch && accepted.seq === candidate.anchorSeq) {
    return done("skipped-debounce", "skipped-unchanged");
  }
  // A newly recovered screen must replace an invalidated/full raw window now;
  // the periodic sixty-second debounce must not force another giant replay.
  if (reason !== "recovery.complete" && last !== undefined && now - last < CHECKPOINT_UPLOAD_DEBOUNCE_MS) {
    return done("skipped-debounce");
  }
  // 去抖在尝试时点落账（同步，先于任何 await）：上传失败也不进重试风暴，
  // 多视图同帧触发时第二个视图直接被挡。
  lastAttemptAtMs.set(sessionId, now);

  let snapshotAnsi: string;
  try {
    snapshotAnsi = options.snapshotAnsi ?? serializeAddon!.serialize();
  } catch (error) {
    devDebugLog("terminal-checkpoint", "serialize failed", {
      sessionId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    return done("serialize-failed");
  }

  const checkpoint: TerminalCheckpointUpload = {
    checkpointEpoch: candidate.checkpointEpoch,
    anchorSeq: candidate.anchorSeq,
    snapshotAnsi,
    bufferMode: term.buffer.active.type === "alternate" ? "alternate" : "normal",
    cols: term.cols,
    rows: term.rows,
    checkpointedAtMs: now,
  };

  let finish = () => {};
  const upload = { done: new Promise<void>(resolve => { finish = resolve; }), finish: () => finish() };
  inFlight.set(sessionId, upload);
  try {
    const outcome = await uploadCheckpoint(sessionId, checkpoint);
    if (outcome === null) return done("skipped-capability");
    if (outcome.kind === "accepted") {
      if (inFlight.get(sessionId) === upload) acceptedAnchors.set(sessionId, { epoch: candidate.checkpointEpoch, seq: candidate.anchorSeq });
      devDebugLog("terminal-checkpoint", "accepted", {
        sessionId,
        reason,
        anchorSeq: outcome.anchorSeq,
        snapshotChars: snapshotAnsi.length,
      });
      return done("uploaded");
    }
    if (outcome.kind === "rejectedEpochMismatch") {
      // epoch 不等 = daemon/会话世代已变，本端 seq 记账全体作废。
      invalidateSeq(sessionId);
    }
    devDebugLog("terminal-checkpoint", "rejected", { sessionId, reason, kind: outcome.kind });
    return done("rejected", outcome.kind);
  } catch (error) {
    devDebugLog("terminal-checkpoint", "upload failed", {
      sessionId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    return done("failed");
  } finally {
    if (inFlight.get(sessionId) === upload) inFlight.delete(sessionId);
    upload.finish();
  }
}

/** 测试用：清空去抖记账。 */
export function _resetCheckpointUploadStateForTest(): void {
  lastAttemptAtMs.clear();
  for (const upload of inFlight.values()) upload.finish();
  inFlight.clear();
  acceptedAnchors.clear();
}

// 去抖时间戳是会话键卫星态：随会话销毁清理（disposeTerminalSessionResources
// → disposeSessionScopedResources 统一入口）。
registerSessionScopedResource({
  name: "terminalCheckpointDebounce",
  dispose: (sessionId) => {
    lastAttemptAtMs.delete(sessionId);
    inFlight.get(sessionId)?.finish();
    inFlight.delete(sessionId);
    acceptedAnchors.delete(sessionId);
  },
});
