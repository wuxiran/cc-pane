import { create } from "zustand";
import { providerService } from "@/services/providerService";
import * as workspaceService from "@/services/workspaceService";
import type { Provider } from "@/types/provider";

interface ProvidersState {
  providers: Provider[];
  defaultProvider: () => Provider | null;
  loadProviders: () => Promise<void>;
  addProvider: (provider: Provider) => Promise<void>;
  updateProvider: (provider: Provider) => Promise<void>;
  removeProvider: (id: string) => Promise<void>;
  setDefault: (id: string) => Promise<void>;
}

export const useProvidersStore = create<ProvidersState>((set, get) => ({
  providers: [],

  defaultProvider: () => {
    const { providers } = get();
    return providers.find((p) => p.isDefault) || providers[0] || null;
  },

  loadProviders: async () => {
    try {
      const providers = await providerService.listProviders();
      set({ providers });
    } catch (e) {
      console.error("Failed to load providers:", e);
    }
  },

  addProvider: async (provider) => {
    await providerService.addProvider(provider);
    await get().loadProviders();
  },

  updateProvider: async (provider) => {
    await providerService.updateProvider(provider);
    await get().loadProviders();
  },

  removeProvider: async (id) => {
    await providerService.removeProvider(id);
    await get().loadProviders();

    // 清理关联此 Provider 的 Workspace 的悬空引用
    try {
      const workspaces = await workspaceService.listWorkspaces();
      for (const ws of workspaces) {
        if (ws.provider_id === id) {
          await workspaceService.updateWorkspaceProvider(ws.name, null);
        }
      }
    } catch (e) {
      console.error("Failed to clean up workspace provider references:", e);
    }
  },

  setDefault: async (id) => {
    await providerService.setDefaultProvider(id);
    await get().loadProviders();
  },
}));
