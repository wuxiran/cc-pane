import { create } from "zustand";
import { providerService } from "@/services/providerService";
import * as workspaceService from "@/services/workspaceService";
import { createSystemProvider, type Provider } from "@/types/provider";
import { handleErrorSilent } from "@/utils";

interface ProvidersState {
  providers: Provider[];
  /** cc-switch/宿主 Anthropic 凭证已检测：「系统环境变量」可作默认。 */
  systemActive: boolean;
  /** 宿主探测命中的 Anthropic 环境变量名（不含值）。 */
  systemEnvKeys: string[];
  /** 探测到 cc-switch 配置库。 */
  systemCcSwitch: boolean;
  /** 用户已显式把「系统环境变量」设为默认凭证（后端持久化状态，非派生）。 */
  defaultIsSystem: boolean;
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
  systemEnvKeys: [],
  systemCcSwitch: false,
  defaultIsSystem: false,

  defaultProvider: () => {
    const { providers, systemActive, defaultIsSystem } = get();
    // 用户显式选定「系统环境变量」优先于任何 provider 的 isDefault。
    if (defaultIsSystem) return createSystemProvider("System", true);
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
      let systemEnvKeys: string[] = [];
      let systemCcSwitch = false;
      let defaultIsSystem = false;
      try {
        const info = await providerService.detectSystemProvider?.();
        if (info) {
          systemActive = info.active;
          systemEnvKeys = info.envKeys ?? [];
          systemCcSwitch = info.ccSwitch;
          defaultIsSystem = info.defaultIsSystem;
        }
      } catch (e) {
        // 探测失败按未启用处理，但不静默吞掉——否则「系统条目为何不显示」无从排查。
        handleErrorSilent(e, "detect system provider");
      }
      set({ providers, systemActive, systemEnvKeys, systemCcSwitch, defaultIsSystem });
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
