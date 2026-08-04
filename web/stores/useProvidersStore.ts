import { create } from "zustand";
import { providerService } from "@/services/providerService";
import * as workspaceService from "@/services/workspaceService";
import { createSystemProvider, SYSTEM_PROVIDER_ID, type Provider } from "@/types/provider";
import type { KnownCliTool } from "@/types/terminal";
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
  /** 每个 CLI 工具各自的持久化默认 Provider id。 */
  defaultProviderIds: Partial<Record<KnownCliTool, string>>;
  defaultProvider: (cliTool?: KnownCliTool) => Provider | null;
  loadProviders: () => Promise<void>;
  addProvider: (provider: Provider) => Promise<void>;
  updateProvider: (provider: Provider) => Promise<void>;
  removeProvider: (id: string) => Promise<void>;
  setDefault: (id: string, cliTool: KnownCliTool) => Promise<void>;
}

export const useProvidersStore = create<ProvidersState>((set, get) => ({
  providers: [],
  systemActive: false,
  systemEnvKeys: [],
  systemCcSwitch: false,
  defaultIsSystem: false,
  defaultProviderIds: {},

  defaultProvider: (cliTool = "claude") => {
    const { providers, systemActive, defaultProviderIds } = get();
    const defaultId = defaultProviderIds[cliTool];
    if (defaultId === SYSTEM_PROVIDER_ID) return createSystemProvider("System", true);
    const explicit = providers.find((provider) => provider.id === defaultId);
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
      let defaultProviderIds: Partial<Record<KnownCliTool, string>> = {};
      try {
        const info = await providerService.detectSystemProvider?.();
        if (info) {
          systemActive = info.active;
          systemEnvKeys = info.envKeys ?? [];
          systemCcSwitch = info.ccSwitch;
          defaultIsSystem = info.defaultIsSystem;
          defaultProviderIds = info.defaultProviderIds ?? {};
        }
      } catch (e) {
        // 探测失败按未启用处理，但不静默吞掉——否则「系统条目为何不显示」无从排查。
        handleErrorSilent(e, "detect system provider");
      }
      set({
        providers,
        systemActive,
        systemEnvKeys,
        systemCcSwitch,
        defaultIsSystem,
        defaultProviderIds,
      });
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

  setDefault: async (id, cliTool) => {
    await providerService.setDefaultProvider(id, cliTool);
    await get().loadProviders();
  },
}));
