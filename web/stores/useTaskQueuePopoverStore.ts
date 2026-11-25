// 任务队列面板的「打开请求」通道：入口在终端右键菜单，面板本体仍挂在状态栏（锚点）。
// mounted 记录哪些会话当前挂着面板——右键菜单据此决定是否显示「任务队列…」，
// 保证菜单项出现时一定有面板可开（设置关闭 / 非 CLI 会话 / 状态栏隐藏时都不挂）。
import { create } from "zustand";

interface TaskQueuePopoverState {
  mounted: Set<string>;
  requested: string | null;
  /** 面板挂载时登记，返回注销函数 */
  register: (sessionId: string) => () => void;
  request: (sessionId: string) => void;
  consume: () => void;
}

export const useTaskQueuePopoverStore = create<TaskQueuePopoverState>((set) => ({
  mounted: new Set(),
  requested: null,
  register: (sessionId) => {
    set((s) => ({ mounted: new Set(s.mounted).add(sessionId) }));
    return () =>
      set((s) => {
        const mounted = new Set(s.mounted);
        mounted.delete(sessionId);
        return { mounted };
      });
  },
  request: (sessionId) => set({ requested: sessionId }),
  consume: () => set({ requested: null }),
}));
