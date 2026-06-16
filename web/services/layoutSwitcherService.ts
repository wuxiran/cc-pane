import { invoke } from "@tauri-apps/api/core";
import type { LayoutSwitcherSettings } from "@/types";

export interface LayoutSwitcherLayoutSnapshot {
  id: string;
  name: string;
  kind?: "normal" | "starred";
  paneSessionIds: string[][];
}

export interface LayoutSwitcherSnapshot {
  layouts: LayoutSwitcherLayoutSnapshot[];
  currentLayoutId: string;
}

export const layoutSwitcherService = {
  open: () => invoke<void>("open_layout_switcher_window"),

  getState: () => invoke<LayoutSwitcherSettings>("get_layout_switcher_state"),

  saveState: (state: LayoutSwitcherSettings) =>
    invoke<void>("save_layout_switcher_state", {
      x: state.windowX,
      y: state.windowY,
      pinned: state.pinned,
    }),
};
