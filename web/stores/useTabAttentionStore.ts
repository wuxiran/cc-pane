// 后台标签的「请求注意」标记（docs/78）。
//
// 场景：一个 agent 会话在后台跑完了、出错了、或者停下来等你回答，而你正在
// 别的标签干活——现在完全没有提示，只能靠自己想起来去翻。
//
// 与通知系统的分工：通知是**打断**（系统级弹窗，有打扰闸门管着），这里是
// **不打断的标记**（标签上一个红点），用户扫一眼就知道哪个标签有事。
//
// 触发条件里的「不可见」判据走 useTabViewStateStore 的聚合——标签在前台时
// 用户自己看得见，标记纯属噪声。
import { create } from "zustand";

export type AttentionReason = "completed" | "error" | "waiting-input";

export interface AttentionEntry {
  reason: AttentionReason;
  at: number;
}

interface TabAttentionState {
  /** owner（通常是 tabId）→ 待处理的注意标记 */
  entries: Record<string, AttentionEntry>;
  /** 标记有事发生。已有标记时按优先级覆盖：error > waiting-input > completed。 */
  markAttention: (owner: string, reason: AttentionReason, at?: number) => void;
  /** 用户看到了（切到该标签）→ 清除。 */
  clearAttention: (owner: string) => void;
  hasAttention: (owner: string) => boolean;
  getAttention: (owner: string) => AttentionEntry | undefined;
}

const PRIORITY: Record<AttentionReason, number> = {
  error: 3,
  "waiting-input": 2,
  completed: 1,
};

export const useTabAttentionStore = create<TabAttentionState>((set, get) => ({
  entries: {},

  markAttention: (owner, reason, at = Date.now()) => {
    const current = get().entries[owner];
    // 高优先级不被低优先级覆盖：出错后又「完成」，红点该继续是出错。
    if (current && PRIORITY[current.reason] > PRIORITY[reason]) return;
    if (current && current.reason === reason) return;
    set((state) => ({ entries: { ...state.entries, [owner]: { reason, at } } }));
  },

  clearAttention: (owner) => {
    if (!get().entries[owner]) return;
    set((state) => {
      const entries = { ...state.entries };
      delete entries[owner];
      return { entries };
    });
  },

  hasAttention: (owner) => Boolean(get().entries[owner]),
  getAttention: (owner) => get().entries[owner],
}));
