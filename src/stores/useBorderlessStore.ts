import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

interface BorderlessState {
  isBorderless: boolean;
  toggleBorderless: () => Promise<void>;
  exitBorderless: () => Promise<void>;
}

export const useBorderlessStore = create<BorderlessState>((set, get) => ({
  isBorderless: true,

  toggleBorderless: async () => {
    const next = !get().isBorderless;
    try {
      await invoke("set_decorations", { decorations: !next });
      set({ isBorderless: next });
    } catch (e) {
      console.error("Failed to toggle borderless:", e);
    }
  },

  exitBorderless: async () => {
    if (!get().isBorderless) return;
    try {
      await invoke("set_decorations", { decorations: true });
      set({ isBorderless: false });
    } catch (e) {
      console.error("Failed to exit borderless:", e);
    }
  },
}));
