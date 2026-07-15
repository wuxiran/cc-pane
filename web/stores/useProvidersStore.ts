import { create } from "zustand";
import { providerService } from "@/services/providerService";
import * as workspaceService from "@/services/workspaceService";
import { createSystemProvider, type Provider } from "@/types/provider";
import { handleErrorSilent } from "@/utils";

interface ProvidersState {
  providers: Provider[];
  /** cc-switch/宿主 Anthropic 凭证已检测：「系统环境变量」可作默认。 */
  systemActive: boolean;
  defaultProvider: () => Provider | null;
  loadProviders: () => Promise<void>;
  addProvider: (provider: Provider) => Promise<void>;
  updateProvider: (provider: Provider) => Promise<void>;
  removeProvider: (id: string) => Promise<void>;
  setDefault: (id: string) => Promise<void>;
}

export const useProvidersStore = create<ProvidersState>((set, get) => ({
  providers: [],
  systemActive: false,

  defaultProvider: () => {
    const { providers, systemActive } = get();
    const explicit = providers.find((p) => p.isDefault);
    if (explicit) return explicit;
    // 用户未显式设默认时，检测到 cc-switch 则默认「系统环境变量」（不注入、跟随系统）。
    if (systemActive) return createSystemProvider("System", true);
    return providers[0] || null;
  },

  loadProviders: async () => {
    try {
      const providers = await providerService.listProviders();
      let systemActive = false;
      try {
        systemActive = (await providerService.detectSystemProvider?.()) ?? false;
      } catch {
        /* 检测失败按未启用处理 */
      }
      set({ providers, systemActive });
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
