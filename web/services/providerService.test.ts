import { describe, it, expect, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { providerService } from "./providerService";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";
import {
  createTestProvider,
  resetTestDataCounter,
} from "@/test/utils/testData";

describe("providerService", () => {
  beforeEach(() => {
    resetTauriInvoke();
    resetTestDataCounter();
  });

  describe("listProviders", () => {
    it("应该调用 list_providers 命令并返回 Provider 列表", async () => {
      const providers = [createTestProvider(), createTestProvider()];
      mockTauriInvoke({ list_providers: providers });

      const result = await providerService.listProviders();

      expect(invoke).toHaveBeenCalledWith("list_providers");
      expect(result).toEqual(providers);
    });

    it("应该在空列表时返回空数组", async () => {
      mockTauriInvoke({ list_providers: [] });

      const result = await providerService.listProviders();

      expect(result).toEqual([]);
    });
  });

  describe("getProvider", () => {
    it("应该调用 get_provider 命令并返回 Provider", async () => {
      const provider = createTestProvider();
      mockTauriInvoke({ get_provider: provider });

      const result = await providerService.getProvider(provider.id);

      expect(invoke).toHaveBeenCalledWith("get_provider", { id: provider.id });
      expect(result).toEqual(provider);
    });

    it("应该在 Provider 不存在时返回 null", async () => {
      mockTauriInvoke({ get_provider: null });

      const result = await providerService.getProvider("non-existent");

      expect(result).toBeNull();
    });
  });

  describe("getDefaultProvider", () => {
    it("应该调用 get_default_provider 命令并返回默认 Provider", async () => {
      const provider = createTestProvider({ isDefault: true });
      mockTauriInvoke({ get_default_provider: provider });

      const result = await providerService.getDefaultProvider();

      expect(invoke).toHaveBeenCalledWith("get_default_provider");
      expect(result).toEqual(provider);
    });

    it("应该在没有默认 Provider 时返回 null", async () => {
      mockTauriInvoke({ get_default_provider: null });

      const result = await providerService.getDefaultProvider();

      expect(result).toBeNull();
    });
  });

  describe("addProvider", () => {
    it("应该调用 add_provider 命令", async () => {
      const provider = createTestProvider();
      mockTauriInvoke({ add_provider: undefined });

      await providerService.addProvider(provider);

      expect(invoke).toHaveBeenCalledWith("add_provider", { provider });
    });
  });

  describe("updateProvider", () => {
    it("应该调用 update_provider 命令", async () => {
      const provider = createTestProvider({ name: "updated" });
      mockTauriInvoke({ update_provider: undefined });

      await providerService.updateProvider(provider);

      expect(invoke).toHaveBeenCalledWith("update_provider", { provider });
    });
  });

  describe("removeProvider", () => {
    it("应该调用 remove_provider 命令", async () => {
      mockTauriInvoke({ remove_provider: undefined });

      await providerService.removeProvider("prov-1");

      expect(invoke).toHaveBeenCalledWith("remove_provider", { id: "prov-1" });
    });
  });

  describe("setDefaultProvider", () => {
    it("应该调用 set_default_provider 命令", async () => {
      mockTauriInvoke({ set_default_provider: undefined });

      await providerService.setDefaultProvider("prov-1");

      expect(invoke).toHaveBeenCalledWith("set_default_provider", {
        id: "prov-1",
      });
    });
  });
});
