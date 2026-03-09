import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { handleErrorSilent } from "@/utils";

interface BorderlessState {
  isBorderless: boolean;
  toggleBorderless: () => Promise<void>;
  exitBorderless: () => Promise<void>;
}

export const useBorderlessStore = create<BorderlessState>((set, get) => ({
  isBorderless: false,

  toggleBorderless: async () => {
    const next = !get().isBorderless;
    try {
      await invoke("set_decorations", { decorations: !next });
      set({ isBorderless: next });
    } catch (e) {
      handleErrorSilent(e, "toggle borderless");
    }
  },

  exitBorderless: async () => {
    if (!get().isBorderless) return;
    try {
      await invoke("set_decorations", { decorations: true });
      set({ isBorderless: false });
    } catch (e) {
      handleErrorSilent(e, "exit borderless");
    }
  },
}));
