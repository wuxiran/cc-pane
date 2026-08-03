import type { TerminalReplaySnapshot } from "@/services/terminalService";

/**
 * 从后端 ReplayBuffer 快照整体重同步终端画面。
 *
 * 两个触发场景（共享本实现）：
 * 1. daemon desync 契约——输出镜像流溢出跳段，中段 VT 流永久缺失，继续
 *    增量写必然花屏；
 * 2. 后台休眠期间积压超上限——休眠字符串已不完整，唤醒时无法无损回放。
 *
 * 语义：`reset()` 丢弃现有画面（含 scrollback）→ 全量写入快照。快照是会话
 * 起点开始的 8MB 窗口（终端存活期），超窗历史丢失——严格优于花屏。
 *
 * 竞态说明：快照请求在途期间新到的 chunk 可能既包含在快照里、又经实时链路
 * 写入（一次性视觉重复；TUI 全屏重绘自愈）。调用方若能暂停实时写入
 * （如休眠唤醒路径），应在 resync 完成后再放行积压。
 */

interface RefValue<T> {
  current: T;
}

interface ResyncTerminal {
  reset: () => void;
  buffer: {
    active: {
      type: "normal" | "alternate";
    };
  };
}
type ResyncLogger = (event: string, payload?: Record<string, unknown>) => void;

interface ResyncFromReplaySnapshotOptions {
  term: ResyncTerminal;
  sessionId: string;
  reason: string;
  getReplaySnapshot: (sessionId: string) => Promise<TerminalReplaySnapshot | null>;
  /** 必须走 renderTerminalData 管道（alt-screen 剥离等），不可直写 xterm。 */
  writeData: (data: string) => Promise<void>;
  syncTrackedBufferType: (reason: string) => void;
  debugLog: ResyncLogger;
}

export async function resyncFromReplaySnapshot({
  term,
  sessionId,
  reason,
  getReplaySnapshot,
  writeData,
  syncTrackedBufferType,
  debugLog,
}: ResyncFromReplaySnapshotOptions): Promise<boolean> {
  let snapshot: TerminalReplaySnapshot | null = null;
  try {
    snapshot = await getReplaySnapshot(sessionId);
  } catch (error) {
    debugLog("terminal.resync.snapshot-failed", {
      sessionId,
      reason,
      error: String(error),
    });
    return false;
  }

  if (!snapshot) {
    // 拿不到快照时保持现有画面：残缺画面 + 后续输出至少还有信息量，
    // reset 后没有内容可补反而更糟。
    debugLog("terminal.resync.skip", { sessionId, reason, cause: "missing-snapshot" });
    return false;
  }

  debugLog("terminal.resync.begin", {
    sessionId,
    reason,
    bufferMode: snapshot.bufferMode,
    dataLength: snapshot.data?.length ?? 0,
  });

  term.reset();
  if (snapshot.data) {
    await writeData(snapshot.data);
  }
  syncTrackedBufferType(`terminal.resync.${reason}`);

  debugLog("terminal.resync.end", {
    sessionId,
    reason,
    bufferAfter: term.buffer.active.type,
  });
  return true;
}

interface CreateTerminalDesyncHandlerOptions {
  sessionId: string;
  terminalRef: RefValue<ResyncTerminal | null>;
  hiddenWriteBufferRef: RefValue<{ reset(): void } | null>;
  getReplaySnapshot: ResyncFromReplaySnapshotOptions["getReplaySnapshot"];
  writeData: ResyncFromReplaySnapshotOptions["writeData"];
  syncTrackedBufferType: (reason: string) => void;
  /**
   * 重同步闸门：置真期间实时输出必须改走积压（不得直写 xterm）。
   * 否则「快照抓取之后到达、reset 之前写入」的输出会被 reset 抹掉且不在快照里
   * ——真丢失，而非可自愈的重复。
   */
  setResyncActive: (active: boolean) => void;
  /** 重同步结束（无论成败）后的收尾：flush 闸门期积压 + 补排版。 */
  onResyncSettled: (resynced: boolean) => void;
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
 */
export function createTerminalDesyncHandler({
  sessionId,
  terminalRef,
  hiddenWriteBufferRef,
  getReplaySnapshot,
  writeData,
  syncTrackedBufferType,
  setResyncActive,
  onResyncSettled,
  debugLog,
}: CreateTerminalDesyncHandlerOptions): () => void {
  return () => {
    const term = terminalRef.current;
    if (!term) return;
    setResyncActive(true);
    // 丢弃 desync 前的不完整积压（缺口在它中间），闸门保证之后的新输出进积压。
    hiddenWriteBufferRef.current?.reset();
    void resyncFromReplaySnapshot({
      term,
      sessionId,
      reason: "daemon-desync",
      getReplaySnapshot,
      writeData,
      syncTrackedBufferType,
      debugLog,
    })
      .then(
        (resynced) => resynced,
        () => false,
      )
      .then((resynced) => {
        setResyncActive(false);
        onResyncSettled(resynced);
      });
  };
}
