// 轴1「用户输入活跃」的记录（docs/78）。
//
// docs/78 三轴模型里，轴1 是「人的手在不在」——它与轴2「内容忙不忙」正交：
// agent 空闲但用户正在打字（草稿未提交），和 agent 在跑但用户已经走开，是完全
// 不同的两种状态，却都被现有的 status 单值糊成一团。
//
// 为什么不并进 useTerminalStatusStore：那里的 statusMap 由后端 terminal-status
// 事件**整条覆盖**（useTerminalStatusStore.ts:99-103），塞进去的输入侧字段会被
// 下一个事件抹掉。
//
// 现状对比：键盘输入此前唯一的记录点是 terminalService.write 里的
// usageStatsService.recordInputChars——只计字符数做用量统计，不落时间戳、
// 不进任何 store，所以「用户刚才有没有动过这个终端」根本无从判断。
import { create } from "zustand";

/** 输入活跃的判定窗口：最后一次击键后多久仍算「人在手边」。 */
export const INPUT_ACTIVE_WINDOW_MS = 60_000;

export interface InputActivityEntry {
  /** 最后一次用户键盘输入的时间戳 */
  lastInputAt: number;
  /**
   * 该次输入落在哪个会话状态段（输入归段，抄自 Orca 的
   * agent-hibernation-input-guard）。
   *
   * 用途：区分「working 段里打字」= 正在写草稿，不该休眠；
   * 与「waitingInput 段里打字」= 已经回答完权限确认，不构成休眠豁免。
   * 比单纯的冷却窗口精准——否则答过一次确认就永远不休眠。
   */
  segment: string;
}

interface TerminalInputActivityState {
  entries: Record<string, InputActivityEntry>;
  recordInput: (sessionId: string, segment: string, now?: number) => void;
  clearSession: (sessionId: string) => void;
  /** 该会话此刻是否算「人在手边」（窗口内有输入）。 */
  isInputActive: (sessionId: string, now?: number) => boolean;
  getEntry: (sessionId: string) => InputActivityEntry | undefined;
}

export const useTerminalInputActivityStore = create<TerminalInputActivityState>((set, get) => ({
  entries: {},

  recordInput: (sessionId, segment, now = Date.now()) => {
    set((state) => ({
      entries: { ...state.entries, [sessionId]: { lastInputAt: now, segment } },
    }));
  },

  clearSession: (sessionId) => {
    if (!get().entries[sessionId]) return;
    set((state) => {
      const entries = { ...state.entries };
      delete entries[sessionId];
      return { entries };
    });
  },

  isInputActive: (sessionId, now = Date.now()) => {
    const entry = get().entries[sessionId];
    if (!entry) return false;
    return now - entry.lastInputAt < INPUT_ACTIVE_WINDOW_MS;
  },

  getEntry: (sessionId) => get().entries[sessionId],
}));

/**
 * 输入是否构成「休眠豁免」。
 *
 * 归段判定的核心：只有落在**忙碌段**的输入才算草稿（用户正在写东西给一个
 * 正在干活的 agent）。落在 waitingInput 段的输入是「已经回答了那个问题」，
 * 答完就该允许休眠——否则确认过一次权限的会话永远不休眠。
 */
export function inputBlocksHibernation(
  entry: InputActivityEntry | undefined,
  now = Date.now(),
): boolean {
  if (!entry) return false;
  if (now - entry.lastInputAt >= INPUT_ACTIVE_WINDOW_MS) return false;
  return entry.segment !== "waitingInput";
}
