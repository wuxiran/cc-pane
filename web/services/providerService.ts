import type { Provider, ConfigDirInfo } from "@/types/provider";
import { apiDelete, apiGet, apiJson, apiNoContent, invokeOrApi } from "./apiClient";

export const providerService = {
  async listProviders(): Promise<Provider[]> {
    return invokeOrApi<Provider[]>("list_providers", undefined, () =>
      apiGet<Provider[]>("/api/providers"),
    );
  },

  async getProvider(id: string): Promise<Provider | null> {
    return invokeOrApi<Provider | null>("get_provider", { id }, () =>
      apiGet<Provider | null>(`/api/providers/${encodeURIComponent(id)}`),
    );
  },

  async getDefaultProvider(): Promise<Provider | null> {
    return invokeOrApi<Provider | null>("get_default_provider", undefined, () =>
      apiGet<Provider | null>("/api/providers/default"),
    );
  },

  async addProvider(provider: Provider): Promise<void> {
    return invokeOrApi<void>("add_provider", { provider }, () =>
      apiJson<void>("/api/providers", "POST", provider),
    );
  },

  async updateProvider(provider: Provider): Promise<void> {
    return invokeOrApi<void>("update_provider", { provider }, () =>
      apiJson<void>(`/api/providers/${encodeURIComponent(provider.id)}`, "PUT", provider),
    );
  },

  async removeProvider(id: string): Promise<void> {
    return invokeOrApi<void>("remove_provider", { id }, () =>
      apiDelete(`/api/providers/${encodeURIComponent(id)}`),
    );
  },

  async setDefaultProvider(id: string): Promise<void> {
    return invokeOrApi<void>("set_default_provider", { id }, () =>
      apiNoContent("/api/providers/default", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      }),
    );
  },

  /**
   * 检测「系统环境变量」provider 是否应作为默认（cc-switch 已安装或宿主已设 Anthropic 凭证）。
   * Web/远程模式下无本地 cc-switch，回退为 false（不自动默认）。
   */
  async detectSystemProvider(): Promise<boolean> {
    return invokeOrApi<boolean>("detect_system_provider", undefined, async () => false);
  },

  async readConfigDirInfo(path: string): Promise<ConfigDirInfo> {
    return invokeOrApi<ConfigDirInfo>("read_config_dir_info", { path }, async () => ({
      path,
      hasSettings: false,
      hasCredentials: false,
      settingsSummary: null,
      files: [],
    }));
  },

  async openPathInExplorer(path: string): Promise<void> {
    return invokeOrApi<void>("open_path_in_explorer", { path }, async () => {
      throw new Error("Opening paths in Explorer is only available in the desktop app");
    });
  },
};
