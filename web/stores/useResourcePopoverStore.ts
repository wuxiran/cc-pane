// 资源管理器弹层的打开状态（docs/107 W4）。
//
// 原本是 SystemResourceSegment 的局部 useState；标签上的琥珀点要能"点一下就打开弹层
// 并定位到那个会话"，开关得挪到 store 里让 TabBar 也够得着。
import { create } from "zustand";

interface ResourcePopoverState {
  open: boolean;
  /** 打开时要高亮/滚到的会话；弹层消费后清掉。 */
  highlightSessionId: string | null;
  setOpen: (open: boolean) => void;
  /** 从标签琥珀点进来：打开并定位。 */
  openForSession: (sessionId: string) => void;
  clearHighlight: () => void;
}

export const useResourcePopoverStore = create<ResourcePopoverState>((set) => ({
  open: false,
  highlightSessionId: null,
  setOpen: (open) => set(open ? { open } : { open, highlightSessionId: null }),
  openForSession: (sessionId) => set({ open: true, highlightSessionId: sessionId }),
  clearHighlight: () => set({ highlightSessionId: null }),
}));
