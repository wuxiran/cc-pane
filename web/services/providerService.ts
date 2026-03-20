import { invoke } from "@tauri-apps/api/core";
import type { Provider, ConfigDirInfo } from "@/types/provider";

export const providerService = {
  async listProviders(): Promise<Provider[]> {
    return invoke<Provider[]>("list_providers");
  },

  async getProvider(id: string): Promise<Provider | null> {
    return invoke<Provider | null>("get_provider", { id });
  },

  async getDefaultProvider(): Promise<Provider | null> {
    return invoke<Provider | null>("get_default_provider");
  },

  async addProvider(provider: Provider): Promise<void> {
    return invoke("add_provider", { provider });
  },

  async updateProvider(provider: Provider): Promise<void> {
    return invoke("update_provider", { provider });
  },

  async removeProvider(id: string): Promise<void> {
    return invoke("remove_provider", { id });
  },

  async setDefaultProvider(id: string): Promise<void> {
    return invoke("set_default_provider", { id });
  },

  async readConfigDirInfo(path: string): Promise<ConfigDirInfo> {
    return invoke<ConfigDirInfo>("read_config_dir_info", { path });
  },

  async openPathInExplorer(path: string): Promise<void> {
    return invoke("open_path_in_explorer", { path });
  },
};
