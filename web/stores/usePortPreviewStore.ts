import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { portPreviewService, type PortPreviewTunnel } from "@/services/portPreviewService";

interface PortPreviewState {
  tunnels: PortPreviewTunnel[];
  refresh(): Promise<void>;
  close(id: string): Promise<void>;
}

export const usePortPreviewStore = create<PortPreviewState>()(
  immer((set, get) => ({
    tunnels: [],
    refresh: async () => {
      const tunnels = await portPreviewService.list();
      set((state) => {
        state.tunnels = Array.isArray(tunnels) ? tunnels : [];
      });
    },
    close: async (id) => {
      await portPreviewService.close(id);
      set((state) => {
        state.tunnels = state.tunnels.filter((tunnel) => tunnel.id !== id);
      });
      await get().refresh();
    },
  })),
);
