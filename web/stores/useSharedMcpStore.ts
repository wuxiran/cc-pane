import { create } from "zustand";
import { sharedMcpService } from "@/services";
import type { SharedMcpServerInfo, SharedMcpConfig } from "@/types";

interface SharedMcpState {
  servers: SharedMcpServerInfo[];
  config: SharedMcpConfig | null;
  loading: boolean;

  fetchStatus: () => Promise<void>;
  fetchConfig: () => Promise<void>;
  startServer: (name: string) => Promise<void>;
  stopServer: (name: string) => Promise<void>;
  restartServer: (name: string) => Promise<void>;
  toggleShared: (name: string, shared: boolean) => Promise<void>;
  removeServer: (name: string) => Promise<void>;
  importFromClaude: () => Promise<string[]>;
}

export const useSharedMcpStore = create<SharedMcpState>((set, get) => ({
  servers: [],
  config: null,
  loading: false,

  async fetchStatus() {
    try {
      const servers = await sharedMcpService.getStatus();
      set({ servers });
    } catch (e) {
      console.error("[shared-mcp] fetchStatus failed:", e);
    }
  },

  async fetchConfig() {
    try {
      const config = await sharedMcpService.getConfig();
      set({ config });
    } catch (e) {
      console.error("[shared-mcp] fetchConfig failed:", e);
    }
  },

  async startServer(name: string) {
    await sharedMcpService.startServer(name);
    await get().fetchStatus();
  },

  async stopServer(name: string) {
    await sharedMcpService.stopServer(name);
    await get().fetchStatus();
  },

  async restartServer(name: string) {
    await sharedMcpService.restartServer(name);
    await get().fetchStatus();
  },

  async toggleShared(name: string, shared: boolean) {
    const server = get().servers.find((s) => s.name === name);
    if (!server) return;
    const updated = { ...server.config, shared };
    await sharedMcpService.upsertServer(name, updated);
    if (shared) {
      await sharedMcpService.startServer(name);
    } else {
      await sharedMcpService.stopServer(name);
    }
    await get().fetchStatus();
    await get().fetchConfig();
  },

  async removeServer(name: string) {
    await sharedMcpService.removeServer(name);
    await get().fetchStatus();
    await get().fetchConfig();
  },

  async importFromClaude() {
    const imported = await sharedMcpService.importFromClaude();
    await get().fetchStatus();
    await get().fetchConfig();
    return imported;
  },
}));
