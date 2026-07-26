import { create } from "zustand";
import type { AiPanel, AiPanelSummary } from "@/types/aiPanel";

/** Dock 内的两级视图：按工作空间分组的历史列表 ↔ 单个面板详情。 */
export type AiPanelViewMode = "list" | "detail";

interface AiPanelState {
  /** 活跃面板：内容在内存里，可交互。 */
  panels: AiPanel[];
  /** 历史摘要（不含正文），后端已按工作空间排好序。 */
  history: AiPanelSummary[];
  historyLoading: boolean;
  activePanelId: string | null;
  unreadPanelIds: string[];
  view: AiPanelViewMode;
  hydrate: (panels: AiPanel[]) => void;
  receive: (panel: AiPanel, markUnread: boolean) => void;
  remove: (panelId: string) => void;
  selectPanel: (panelId: string) => void;
  markActiveRead: () => void;
  setHistory: (history: AiPanelSummary[]) => void;
  setHistoryLoading: (loading: boolean) => void;
  setView: (view: AiPanelViewMode) => void;
  /** 用户在历史里删掉一条：活跃集与历史都要清掉。 */
  forget: (panelId: string) => void;
}

function withoutPanel(ids: string[], panelId: string): string[] {
  return ids.filter((id) => id !== panelId);
}

export const useAiPanelStore = create<AiPanelState>((set) => ({
  panels: [],
  history: [],
  historyLoading: false,
  activePanelId: null,
  unreadPanelIds: [],
  view: "list",

  hydrate: (panels) => set((state) => ({
    panels,
    activePanelId: state.activePanelId && panels.some((panel) => panel.panelId === state.activePanelId)
      ? state.activePanelId
      : panels[0]?.panelId ?? null,
    unreadPanelIds: panels.map((panel) => panel.panelId),
  })),

  receive: (panel, markUnread) => set((state) => {
    const exists = state.panels.some((item) => item.panelId === panel.panelId);
    const panels = exists
      ? state.panels.map((item) => item.panelId === panel.panelId ? panel : item)
      : [...state.panels, panel];
    const unreadPanelIds = markUnread
      ? [...withoutPanel(state.unreadPanelIds, panel.panelId), panel.panelId]
      : withoutPanel(state.unreadPanelIds, panel.panelId);
    return {
      panels,
      activePanelId: state.activePanelId ?? panel.panelId,
      unreadPanelIds,
    };
  }),

  remove: (panelId) => set((state) => {
    const panels = state.panels.filter((panel) => panel.panelId !== panelId);
    return {
      panels,
      activePanelId: state.activePanelId === panelId
        ? panels[0]?.panelId ?? null
        : state.activePanelId,
      unreadPanelIds: withoutPanel(state.unreadPanelIds, panelId),
    };
  }),

  // 选中即进详情：无论来自用户点击历史，还是 AI 推送后自动聚焦
  selectPanel: (panelId) => set((state) => ({
    activePanelId: panelId,
    unreadPanelIds: withoutPanel(state.unreadPanelIds, panelId),
    view: "detail",
  })),

  markActiveRead: () => set((state) => ({
    unreadPanelIds: state.activePanelId
      ? withoutPanel(state.unreadPanelIds, state.activePanelId)
      : state.unreadPanelIds,
  })),

  setHistory: (history) => set({ history }),

  setHistoryLoading: (historyLoading) => set({ historyLoading }),

  setView: (view) => set({ view }),

  forget: (panelId) => set((state) => {
    const panels = state.panels.filter((panel) => panel.panelId !== panelId);
    const removedActive = state.activePanelId === panelId;
    return {
      panels,
      history: state.history.filter((entry) => entry.panelId !== panelId),
      unreadPanelIds: withoutPanel(state.unreadPanelIds, panelId),
      activePanelId: removedActive ? null : state.activePanelId,
      // 删掉的正是正在看的那个，就退回列表，别停在空详情上
      view: removedActive ? "list" : state.view,
    };
  }),
}));
