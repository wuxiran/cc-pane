import type { TerminalRecoverySnapshot } from "@/types";
import { reanchorAfterRecovery } from "./terminalReplay";
import { noteTerminalPerformanceResync } from "@/services/performanceMetrics";
import { writeTerminalReplay } from "./terminalReplayChunks";
import { restoreReplayBufferMode } from "./terminalReplayBufferMode";
import { withTerminalReplayPresentation, type ReplayPresentationTerminal } from "./terminalReplayPresentation";
import { checkpointRecoveredTerminal } from "./terminalRecoveryCheckpoint";

/**
 * 从后端恢复快照（checkpoint+delta）整体重同步终端画面。
 *
 * 两个触发场景（共享本实现）：
 * 1. daemon desync 契约——输出镜像流溢出跳段，中段 VT 流永久缺失，继续
 *    增量写必然花屏；
 * 2. 后台休眠期间积压超上限——休眠字符串已不完整，唤醒时无法无损回放。
 *
 * 语义：`reset()` 丢弃现有画面（含 scrollback）→ photo 直写 → delta 渲染写
 * （裁决 B 双管道）。无照片时 delta 是末尾最多 8MiB 的原始输出窗口，
 * 起始屏幕模式需要从切换序列或后台元数据补回；超窗的旧画面无法恢复。
 *
 * 竞态说明：快照请求在途期间新到的 chunk 可能既包含在快照里、又经实时链路
 * 写入（一次性视觉重复；TUI 全屏重绘自愈）。调用方若能暂停实时写入
 * （如休眠唤醒路径），应在 resync 完成后再放行积压。
 */

/**
 * 字节 gap 之后的接地序列（照 Orca 的 `RESET_AFTER_BYTE_GAP`）。
 *
 * 用 `\x18`(CAN) 而不是裸 ESC：xterm 派发 OSC/DCS/APC 的判据是
 * `success = code !== 0x18 && code !== 0x1a`，ESC 只是让解析器归位、却会**提交**
 * 被 gap 截断的那一段——半个 OSC 0 会改窗口标题，OSC 52 会直接写剪贴板。
 * CAN 才是"丢弃"。
 *
 * 后半的 `\x1b[0m` 清 pen：关掉粗体/颜色的那条 SGR 可能正落在丢失的那一段里，
 * 不清的话后续所有输出都会带着它（Orca 的原话是 the pen is left bold）。
 *
 * 只做 parser + pen，**不做更宽的重置**：会话还活着，charset、边距、鼠标模式
 * 归它自己管；DECSTR 软重置还会抹掉 agent 只在启动时协商一次的 kitty flags。
 */
const GROUND_AFTER_BYTE_GAP = "\x18\x1b[0m";

interface RefValue<T> {
  current: T;
}

interface ResyncTerminal extends ReplayPresentationTerminal {
  reset: () => void;
}
type ResyncLogger = (event: string, payload?: Record<string, unknown>) => void;

interface ResyncFromReplaySnapshotOptions {
  canWrite?: () => boolean;
  term: ResyncTerminal;
  sessionId: string;
  reason: string;
  getRecoverySnapshot: (sessionId: string) => Promise<TerminalRecoverySnapshot | null>;
  /** delta 管道：必须走 renderTerminalData（alt-screen 剥离等），不可直写 xterm。 */
  writeData: (data: string) => Promise<void>;
  /** photo 管道：SerializeAddon 成品 VT，直写——二次渲染会坏（裁决 B）。 */
  writeCheckpointData: (data: string) => Promise<void>;
  syncTrackedBufferType: (reason: string) => void;
  debugLog: ResyncLogger;
}

export function resyncFromReplaySnapshot(options: ResyncFromReplaySnapshotOptions): Promise<boolean> {
  return withTerminalReplayPresentation(options.term, () => restoreSnapshot(options));
}

async function restoreSnapshot({
  canWrite,
  term,
  sessionId,
  reason,
  getRecoverySnapshot,
  writeData,
  writeCheckpointData,
  syncTrackedBufferType,
  debugLog,
}: ResyncFromReplaySnapshotOptions): Promise<boolean> {
  // 放弃路径的接地：不重画，但必须消掉 gap 卡住的解析器状态与 pen。
  // 走 checkpoint 管道（无状态，非透明模式下就是直写）——delta 管道那个 renderer
  // 是**有状态**的，desync 时它自己可能正扣着半个序列，接地序列进去会被拼上。
  // 时序要紧：这里写完才 return false，调用方的 onResyncSettled 随后才 flush 积压
  // 与写失败提示，两者因此都落在干净的 pen 上（Orca #14241 的
  // "clears the SGR pen before draining abandoned chunks"）。
  const groundAfterGap = async () => {
    if (canWrite && !canWrite()) return;
    try {
      await writeCheckpointData(GROUND_AFTER_BYTE_GAP);
    } catch (error) {
      // 接地失败不改变返回值：调用方要看到的是原本的失败原因，不是这一条。
      debugLog("terminal.resync.ground-failed", {
        sessionId,
        reason,
        error: String(error),
      });
    }
  };

  let snapshot: TerminalRecoverySnapshot | null = null;
  try {
    snapshot = await getRecoverySnapshot(sessionId);
  } catch (error) {
    debugLog("terminal.resync.snapshot-failed", {
      sessionId,
      reason,
      error: String(error),
    });
    await groundAfterGap();
    return false;
  }

  if (!snapshot) {
    // 拿不到快照时保持现有画面：残缺画面 + 后续输出至少还有信息量，
    // reset 后没有内容可补反而更糟。但画面留着不等于状态也留着——gap 吃掉的
    // 那段里可能有关粗体/复位颜色的 SGR，不接地的话后续输出全被它染上。
    debugLog("terminal.resync.skip", { sessionId, reason, cause: "missing-snapshot" });
    await groundAfterGap();
    return false;
  }

  debugLog("terminal.resync.begin", {
    sessionId,
    reason,
    bufferMode: snapshot.bufferMode,
    checkpointChars: snapshot.checkpoint?.snapshotAnsi.length ?? 0,
    deltaLength: snapshot.delta.length,
  });

  // 序 = reset → photo 直写（无 photo 时补屏幕模式）→ delta 渲染写 → sync → reanchor。
  if (canWrite && !canWrite()) return false;
  noteTerminalPerformanceResync(sessionId, snapshot.delta.length + (snapshot.checkpoint?.snapshotAnsi.length ?? 0));
  term.reset();
  if (snapshot.checkpoint) {
    await writeTerminalReplay(snapshot.checkpoint.snapshotAnsi, writeCheckpointData, { canWrite });
  } else {
    await restoreReplayBufferMode(snapshot, term, writeData, canWrite);
  }
  if (snapshot.delta) {
    await writeTerminalReplay(snapshot.delta, writeData, { canWrite });
  }
  syncTrackedBufferType(`terminal.resync.${reason}`);
  reanchorAfterRecovery(sessionId, snapshot);
  checkpointRecoveredTerminal(term, sessionId);

  debugLog("terminal.resync.end", {
    sessionId,
    reason,
    bufferAfter: term.buffer.active.type,
  });
  return true;
}

interface CreateTerminalDesyncHandlerOptions {
  isRenderVisible?: () => boolean;
  sessionId: string;
  terminalRef: RefValue<ResyncTerminal | null>;
  hiddenWriteBufferRef: RefValue<{ reset(): void } | null>;
  getRecoverySnapshot: ResyncFromReplaySnapshotOptions["getRecoverySnapshot"];
  writeData: ResyncFromReplaySnapshotOptions["writeData"];
  writeCheckpointData: ResyncFromReplaySnapshotOptions["writeCheckpointData"];
  syncTrackedBufferType: (reason: string) => void;
  /**
   * 重同步闸门：置真期间实时输出必须改走积压（不得直写 xterm）。
   * 否则「快照抓取之后到达、reset 之前写入」的输出会被 reset 抹掉且不在快照里
   * ——真丢失，而非可自愈的重复。
   */
  setResyncActive: (active: boolean) => void;
  /** 重同步结束（无论成败）后的收尾：flush 闸门期积压 + 补排版。 */
  onResyncSettled: (resynced: boolean) => unknown | Promise<unknown>;
  debugLog: ResyncLogger;
}

/**
 * `terminalService.registerDesync` 的标准回调：desync = 中段输出永久缺失，
 * 积压的隐藏缓冲同样不完整，一并丢弃后整体走 snapshot 重放
 * （比带缺口继续增量写的必然花屏严格更好）。
 *
 * 时序契约：先落闸门再发快照请求，闸门期新输出全部积压；快照写入完成后由
 * `onResyncSettled` 统一放行。闸门期积压与快照尾部可能重叠（一次性视觉重复，
 * TUI 全屏重绘自愈），但绝不丢失。
 *
 * 返回值 = 本轮是否成功用快照重建了画面。desync 订阅方忽略它；手动「重置
 * 终端缓冲区」路径靠它决定要不要回退成裸 reset——inline CLI（如 grok）收到
 * 重绘信号只补画活动区，历史全靠快照，重建失败时才允许破坏性清空。
 */
export function createTerminalDesyncHandler({
  isRenderVisible = () => true,
  sessionId,
  terminalRef,
  hiddenWriteBufferRef,
  getRecoverySnapshot,
  writeData,
  writeCheckpointData,
  syncTrackedBufferType,
  setResyncActive,
  onResyncSettled,
  debugLog,
}: CreateTerminalDesyncHandlerOptions): (() => Promise<boolean>) & { dispose: () => void } {
  let activeResync: Promise<boolean> | null = null;
  let coreResyncActive = false;
  let disposed = false;

  const handler = () => {
    if (disposed) return Promise.resolve(false);
    if (coreResyncActive && activeResync) return activeResync;
    const term = terminalRef.current;
    if (!term) return Promise.resolve(false);
    if (!isRenderVisible()) {
      // Keep output behind the recovery gate until the visible-edge flusher calls us.
      setResyncActive(true);
      hiddenWriteBufferRef.current?.reset();
      return Promise.resolve(false);
    }
    const canWrite = () => !disposed && terminalRef.current === term;
    // Freeze may wait one WebGL render; close the output gate before that await.
    coreResyncActive = true;
    setResyncActive(true);

    const run = async (): Promise<boolean> => {
      // 丢弃 desync 前的不完整积压（缺口在它中间），闸门保证之后的新输出进积压。
      hiddenWriteBufferRef.current?.reset();
      const resynced = await resyncFromReplaySnapshot({
        canWrite,
        term,
        sessionId,
        reason: "daemon-desync",
        getRecoverySnapshot,
        writeData,
        writeCheckpointData,
        syncTrackedBufferType,
        debugLog,
      }).then(
        (recovered) => recovered,
        () => false,
      );
      coreResyncActive = false;
      if (!canWrite()) return false;
      setResyncActive(false);
      await onResyncSettled(resynced);
      return resynced;
    };
    const completion = withTerminalReplayPresentation(term, run)
      .catch((error) => {
        debugLog("terminal.resync.settled.failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      })
      .finally(() => {
        if (activeResync === completion) activeResync = null;
      });
    activeResync = completion;
    return completion;
  };
  handler.dispose = () => { if (disposed) return; disposed = true; setResyncActive(false); };
  return handler;
}
