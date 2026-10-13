/**
 * 停泊（docs/107 P1）：隐藏 30 s 后（或隐藏数超上限时按 LRU）直接释放 xterm
 * 实例与 WebGL 租约，**不序列化**。Tauri 模式下隐藏会话收不到任何字节（daemon
 * 源头切断、前端闩 desync），休眠容器几乎必然已作废，序列化只是白花 CPU。
 *
 * 实现复用休眠交接：构造 `base:""` 且立即 desync 的 HibernatedTerminalState →
 * hibernatedStateRef → epoch 自增；init effect 的 cleanup 完整销毁 xterm/renderer
 * （WebGL 租约随 renderer dispose 归还），新一轮 effect 走轻量分支。唤醒与休眠同路：
 * `replayHibernationWake` 见 wakeData() 为 null 即走 `replayFromSnapshot`
 * （checkpoint + delta，带几何）。进度 / 等待输入 / 完成信号由后端解析，不受影响。
 */
import type { Terminal } from "@xterm/xterm";
import {
  inputBlocksHibernation,
  useTerminalInputActivityStore,
} from "@/stores/useTerminalInputActivityStore";
import {
  createHibernatedTerminalState,
  type HibernatedTerminalState,
} from "./terminalHibernation";
import { createTerminalParkingRegistry } from "./terminalParkingRegistry";
import { getParkedTerminalLimit } from "./terminalParkingSettings";

interface RefValue<T> {
  current: T;
}
type ParkingLogger = (event: string, payload?: Record<string, unknown>) => void;

export interface CreateParkedTerminalStateOptions {
  sessionId: string;
  cols: number;
  rows: number;
}

/** 停泊容器：空基底 + 立即作废，唤醒必走后端 snapshot；保留 cols/rows 供重放几何。 */
export function createParkedTerminalState({
  sessionId,
  cols,
  rows,
}: CreateParkedTerminalStateOptions): HibernatedTerminalState {
  const state = createHibernatedTerminalState({ sessionId, base: "", cols, rows });
  state.markDesynced();
  return state;
}

export interface ParkTerminalContext {
  terminalInstanceRef: RefValue<Pick<Terminal, "cols" | "rows"> | null>;
  currentSessionIdRef: RefValue<string | null>;
  hibernatedStateRef: RefValue<HibernatedTerminalState | null>;
  isReconnectingRef: RefValue<boolean>;
  isDisconnectedRef: RefValue<boolean>;
  debugLog: ParkingLogger;
  bumpInstanceEpoch: () => void;
  reason: "park-timer" | "park-evict";
}

/**
 * 执行停泊。返回 true 表示该视图已不再持有 xterm（本次停泊成功或此前已休眠/停泊）；
 * false 表示守卫拦下（重连中 / 已断开 / 近期输入草稿），由调用方下轮再试。
 */
export function parkTerminal({
  terminalInstanceRef,
  currentSessionIdRef,
  hibernatedStateRef,
  isReconnectingRef,
  isDisconnectedRef,
  debugLog,
  bumpInstanceEpoch,
  reason,
}: ParkTerminalContext): boolean {
  if (hibernatedStateRef.current) return true;
  const term = terminalInstanceRef.current;
  const sessionId = currentSessionIdRef.current;
  if (!term || !sessionId) return false;
  // 与休眠同口径的守卫（见 useTerminalHibernation.hibernateNow）。
  if (isReconnectingRef.current || isDisconnectedRef.current) return false;
  const inputEntry = useTerminalInputActivityStore.getState().getEntry(sessionId);
  if (inputBlocksHibernation(inputEntry)) {
    debugLog("park.skipped.input-active", { sessionId, reason });
    return false;
  }
  hibernatedStateRef.current = createParkedTerminalState({
    sessionId,
    cols: term.cols,
    rows: term.rows,
  });
  debugLog("park.begin", { parkSessionId: sessionId, reason, cols: term.cols, rows: term.rows });
  bumpInstanceEpoch();
  return true;
}

/** 全 WebView 单例：上限随设置惰性读取（`settings.performance.parkedTerminalLimit`）。 */
export const terminalParkingRegistry = createTerminalParkingRegistry({
  limit: getParkedTerminalLimit,
});
