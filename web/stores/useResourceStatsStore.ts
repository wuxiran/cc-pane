import { create } from "zustand";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { ResourceStats } from "@/types";

interface ResourceStatsState {
  stats: ResourceStats | null;
  _unlisten: UnlistenFn | null;
  _initialized: boolean;
  init: () => Promise<void>;
  cleanup: () => void;
}

export const useResourceStatsStore = create<ResourceStatsState>((set, get) => ({
  stats: null,
  _unlisten: null,
  _initialized: false,

  init: async () => {
    if (get()._initialized) return;
    set({ _initialized: true });

    const unlistenFn = await getCurrentWebview().listen<ResourceStats>(
      "resource-stats",
      (event) => {
        set({ stats: event.payload });
      },
    );
    set({ _unlisten: unlistenFn });
  },

  cleanup: () => {
    const { _unlisten } = get();
    _unlisten?.();
    set({ stats: null, _unlisten: null, _initialized: false });
  },
}));
