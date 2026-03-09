import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriReady } from "@/utils";

interface MiniModeState {
  isMiniMode: boolean;
  savedWidth: number;
  savedHeight: number;
  enterMiniMode: () => Promise<void>;
  exitMiniMode: () => Promise<void>;
  toggleMiniMode: () => void;
}

export const useMiniModeStore = create<MiniModeState>((set, get) => ({
  isMiniMode: false,
  savedWidth: 1200,
  savedHeight: 800,

  enterMiniMode: async () => {
    try {
      if (!isTauriReady()) return;
      const win = getCurrentWindow();
      const factor = await win.scaleFactor();
      const physicalSize = await win.innerSize();
      set({
        savedWidth: physicalSize.width / factor,
        savedHeight: physicalSize.height / factor,
      });

      await invoke("enter_mini_mode");
      set({ isMiniMode: true });
    } catch (e) {
      console.error("Failed to enter mini mode:", e);
    }
  },

  exitMiniMode: async () => {
    try {
      const { savedWidth, savedHeight } = get();
      await invoke("exit_mini_mode", {
        width: savedWidth,
        height: savedHeight,
      });
      set({ isMiniMode: false });
    } catch (e) {
      console.error("Failed to exit mini mode:", e);
    }
  },

  toggleMiniMode: () => {
    const { isMiniMode, enterMiniMode, exitMiniMode } = get();
    if (isMiniMode) {
      exitMiniMode();
    } else {
      enterMiniMode();
    }
  },
}));
