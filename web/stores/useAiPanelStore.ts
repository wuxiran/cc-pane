import { create } from "zustand";
import type { AiPanel } from "@/types/aiPanel";

interface AiPanelState {
  panels: AiPanel[];
  activePanelId: string | null;
  unreadPanelIds: string[];
  hydrate: (panels: AiPanel[]) => void;
  receive: (panel: AiPanel, markUnread: boolean) => void;
  remove: (panelId: string) => void;
  selectPanel: (panelId: string) => void;
  markActiveRead: () => void;
}

function withoutPanel(ids: string[], panelId: string): string[] {
  return ids.filter((id) => id !== panelId);
}

export const useAiPanelStore = create<AiPanelState>((set) => ({
  panels: [],
  activePanelId: null,
  unreadPanelIds: [],

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

  selectPanel: (panelId) => set((state) => ({
    activePanelId: panelId,
    unreadPanelIds: withoutPanel(state.unreadPanelIds, panelId),
  })),

  markActiveRead: () => set((state) => ({
    unreadPanelIds: state.activePanelId
      ? withoutPanel(state.unreadPanelIds, state.activePanelId)
      : state.unreadPanelIds,
  })),
}));
