import { create } from "zustand";

export interface PaneEdgeDropPreview {
  paneId: string;
  edge: "right" | "bottom";
}

interface PaneEdgeDropState {
  /** 正在拖拽 tab：边缘落点条只在此期间渲染，避免与 tab 落点常驻竞争碰撞。 */
  draggingTab: boolean;
  /** 当前悬停的边缘落点预览（Panel 据此渲染半格高亮）。 */
  preview: PaneEdgeDropPreview | null;
  setDraggingTab: (dragging: boolean) => void;
  setPreview: (preview: PaneEdgeDropPreview | null) => void;
}

/** 拖拽落边分屏的瞬态 UI 状态（DndPaneProvider 写，Panel/PaneEdgeDropZones 读）。 */
export const usePaneEdgeDropStore = create<PaneEdgeDropState>((set) => ({
  draggingTab: false,
  preview: null,
  setDraggingTab: (draggingTab) => set({ draggingTab }),
  setPreview: (preview) => set({ preview }),
}));
