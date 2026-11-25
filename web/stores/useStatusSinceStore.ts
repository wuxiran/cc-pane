// 会话「当前状态从何时开始」的时间戳（任务视图显示「运行 9m / 等待 2m」用）。
//
// TerminalStatusInfo.updatedAt 是最近一次状态推送时间，工具切换、轮询都会刷新它，
// 不能当「进入该状态的时刻」。这里只在状态**跃迁**时记一笔，由 useTabAttentionWiring
// （App 级常驻）写入，任务视图只读——视图晚挂载也不丢历史。
import { create } from "zustand";

interface StatusSinceState {
  /** sessionId → 进入当前状态的时刻（ms）。忙碌态之间互相切换（thinking ↔ toolRunning）不重置。 */
  since: Record<string, number>;
  setSince: (sessionId: string, at: number) => void;
  remove: (sessionIds: string[]) => void;
}

export const useStatusSinceStore = create<StatusSinceState>((set) => ({
  since: {},
  setSince: (sessionId, at) =>
    set((state) => (state.since[sessionId] === at ? state : { since: { ...state.since, [sessionId]: at } })),
  remove: (sessionIds) =>
    set((state) => {
      if (!sessionIds.some((id) => id in state.since)) return state;
      const since = { ...state.since };
      for (const id of sessionIds) delete since[id];
      return { since };
    }),
}));
