import { invoke } from "@tauri-apps/api/core";
import type { Provider } from "@/types/provider";

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
};
