import { create } from "zustand";
import { providerService } from "@/services/providerService";
import * as workspaceService from "@/services/workspaceService";
import type { Provider } from "@/types/provider";
import { handleErrorSilent } from "@/utils";

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
      handleErrorSilent(e, "load providers");
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
        if (ws.providerId === id) {
          await workspaceService.updateWorkspaceProvider(ws.name, null);
        }
      }
    } catch (e) {
      handleErrorSilent(e, "clean up workspace provider references");
    }
  },

  setDefault: async (id) => {
    await providerService.setDefaultProvider(id);
    await get().loadProviders();
  },
}));
