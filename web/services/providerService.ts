import type {
  ConfigDirInfo,
  Provider,
  ProviderApiCredentials,
  ProviderEnvPreviewEntry,
  SystemProviderInfo,
} from "@/types/provider";
import type { KnownCliTool } from "@/types/terminal";
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

  async setDefaultProvider(id: string, cliTool: KnownCliTool): Promise<void> {
    return invokeOrApi<void>("set_default_provider", { id, cliTool }, () =>
      apiNoContent("/api/providers/default", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, cliTool }),
      }),
    );
  },

  /**
   * 探测「系统环境变量」条目：是否可用（cc-switch 已安装或宿主已设 Anthropic 凭证）、
   * 命中了哪些变量名，以及它是否已被设为默认凭证。
   * Web/远程模式下无本地宿主可探测，回退为「未检测到」。
   */
  async detectSystemProvider(): Promise<SystemProviderInfo> {
    return invokeOrApi<SystemProviderInfo>("detect_system_provider", undefined, async () => ({
      active: false,
      ccSwitch: false,
      envKeys: [],
      defaultIsSystem: false,
      defaultProviderIds: {},
    }));
  },

  async importCcSwitchProviders(): Promise<{
    imported: number;
    skippedDuplicate: number;
    skippedEmpty: number;
    skippedUnsupported: number;
  }> {
    return invokeOrApi("import_cc_switch_providers", undefined, async () => {
      throw new Error("Importing from cc-switch is only available in the desktop app");
    });
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

  /** 注入预览：选定账号和 CLI 后将要带给会话的环境变量，敏感值已打码。 */
  async previewProviderEnv(
    providerId: string,
    accountId?: string | null,
    cliTool?: string | null,
  ): Promise<ProviderEnvPreviewEntry[]> {
    const query = new URLSearchParams();
    if (accountId) query.set("accountId", accountId);
    if (cliTool) query.set("cliTool", cliTool);
    return invokeOrApi<ProviderEnvPreviewEntry[]>(
      "preview_provider_env",
      { providerId, accountId: accountId ?? null, cliTool: cliTool ?? null },
      () => apiGet<ProviderEnvPreviewEntry[]>(
        `/api/providers/${encodeURIComponent(providerId)}/env-preview?${query.toString()}`,
      ),
    );
  },

  /**
   * 读出某个账号的密钥与接口地址（测试连接 / 拉模型列表 / 一次性补全用）。
   * 结果只在内存里用：不要放进 store、不要落盘、不要打日志。
   */
  async resolveApiCredentials(
    providerId: string,
    accountId?: string | null,
  ): Promise<ProviderApiCredentials> {
    const query = accountId ? `?accountId=${encodeURIComponent(accountId)}` : "";
    return invokeOrApi<ProviderApiCredentials>(
      "resolve_provider_api_credentials",
      { providerId, accountId: accountId ?? null },
      () => apiJson<ProviderApiCredentials>(
        `/api/providers/${encodeURIComponent(providerId)}/credentials${query}`,
        "POST",
        {},
      ),
    );
  },

  /** 当前环境有没有可用的系统钥匙串；没有时密钥留在 providers.json（未进钥匙串）。 */
  async getSecretStatus(): Promise<{ keychainAvailable: boolean }> {
    return invokeOrApi<{ keychainAvailable: boolean }>("get_provider_secret_status", undefined, () =>
      apiGet<{ keychainAvailable: boolean }>("/api/providers/secret-status"),
    );
  },

  async openPathInExplorer(path: string): Promise<void> {
    return invokeOrApi<void>("open_path_in_explorer", { path }, async () => {
      throw new Error("Opening paths in Explorer is only available in the desktop app");
    });
  },
};
