import { describe, it, expect, beforeEach, vi } from "vitest";
import { useProvidersStore } from "./useProvidersStore";
import { providerService } from "@/services/providerService";
import * as workspaceService from "@/services/workspaceService";
import {
  createTestProvider,
  createTestWorkspace,
  resetTestDataCounter,
} from "@/test/utils/testData";

vi.mock("@/services/providerService", () => ({
  providerService: {
    listProviders: vi.fn(),
    addProvider: vi.fn(),
    updateProvider: vi.fn(),
    removeProvider: vi.fn(),
    setDefaultProvider: vi.fn(),
  },
}));

vi.mock("@/services/workspaceService", () => ({
  listWorkspaces: vi.fn(),
  updateWorkspaceProvider: vi.fn(),
}));

describe("useProvidersStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTestDataCounter();
    useProvidersStore.setState({
      providers: [],
    });
  });

  describe("初始状态", () => {
    it("应该有正确的初始值", () => {
      const state = useProvidersStore.getState();
      expect(state.providers).toEqual([]);
    });
  });

  describe("defaultProvider", () => {
    it("有 isDefault 的 provider 应返回它", () => {
      const p1 = createTestProvider({ isDefault: false });
      const p2 = createTestProvider({ isDefault: true });
      useProvidersStore.setState({ providers: [p1, p2] });

      const defaultP = useProvidersStore.getState().defaultProvider();
      expect(defaultP).not.toBeNull();
      expect(defaultP!.id).toBe(p2.id);
    });

    it("没有 isDefault 时应返回第一个", () => {
      const p1 = createTestProvider({ isDefault: false });
      const p2 = createTestProvider({ isDefault: false });
      useProvidersStore.setState({ providers: [p1, p2] });

      const defaultP = useProvidersStore.getState().defaultProvider();
      expect(defaultP).not.toBeNull();
      expect(defaultP!.id).toBe(p1.id);
    });

    it("空列表应返回 null", () => {
      const defaultP = useProvidersStore.getState().defaultProvider();
      expect(defaultP).toBeNull();
    });
  });

  describe("loadProviders", () => {
    it("应调用 listProviders 并设置 providers", async () => {
      const providers = [createTestProvider(), createTestProvider()];
      vi.mocked(providerService.listProviders).mockResolvedValue(providers);

      await useProvidersStore.getState().loadProviders();

      expect(useProvidersStore.getState().providers).toEqual(providers);
    });

    it("加载失败时不应抛异常", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(providerService.listProviders).mockRejectedValue(
        new Error("load failed")
      );

      await useProvidersStore.getState().loadProviders();

      expect(useProvidersStore.getState().providers).toEqual([]);
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe("addProvider", () => {
    it("应调用 addProvider 后刷新列表", async () => {
      const newProvider = createTestProvider({ name: "new-provider" });
      const refreshedList = [newProvider];
      vi.mocked(providerService.addProvider).mockResolvedValue();
      vi.mocked(providerService.listProviders).mockResolvedValue(refreshedList);

      await useProvidersStore.getState().addProvider(newProvider);

      expect(providerService.addProvider).toHaveBeenCalledWith(newProvider);
      expect(providerService.listProviders).toHaveBeenCalled();
      expect(useProvidersStore.getState().providers).toEqual(refreshedList);
    });
  });

  describe("updateProvider", () => {
    it("应调用 updateProvider 后刷新列表", async () => {
      const provider = createTestProvider({ name: "updated" });
      const refreshedList = [provider];
      vi.mocked(providerService.updateProvider).mockResolvedValue();
      vi.mocked(providerService.listProviders).mockResolvedValue(refreshedList);

      await useProvidersStore.getState().updateProvider(provider);

      expect(providerService.updateProvider).toHaveBeenCalledWith(provider);
      expect(providerService.listProviders).toHaveBeenCalled();
      expect(useProvidersStore.getState().providers).toEqual(refreshedList);
    });
  });

  describe("removeProvider", () => {
    it("应调用 removeProvider 后刷新列表并清理关联 workspace", async () => {
      const providerId = "provider-to-remove";
      const ws1 = createTestWorkspace({ name: "ws-1", providerId });
      const ws2 = createTestWorkspace({ name: "ws-2" });
      vi.mocked(providerService.removeProvider).mockResolvedValue();
      vi.mocked(providerService.listProviders).mockResolvedValue([]);
      vi.mocked(workspaceService.listWorkspaces).mockResolvedValue([ws1, ws2]);
      vi.mocked(workspaceService.updateWorkspaceProvider).mockResolvedValue();

      await useProvidersStore.getState().removeProvider(providerId);

      expect(providerService.removeProvider).toHaveBeenCalledWith(providerId);
      expect(providerService.listProviders).toHaveBeenCalled();
      // 只清理关联了此 provider 的 workspace
      expect(workspaceService.updateWorkspaceProvider).toHaveBeenCalledTimes(1);
      expect(workspaceService.updateWorkspaceProvider).toHaveBeenCalledWith("ws-1", null);
    });

    it("清理 workspace 失败时不应抛异常", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(providerService.removeProvider).mockResolvedValue();
      vi.mocked(providerService.listProviders).mockResolvedValue([]);
      vi.mocked(workspaceService.listWorkspaces).mockRejectedValue(
        new Error("ws error")
      );

      await useProvidersStore.getState().removeProvider("some-id");

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe("setDefault", () => {
    it("应调用 setDefaultProvider 后刷新列表", async () => {
      const provider = createTestProvider({ isDefault: true });
      vi.mocked(providerService.setDefaultProvider).mockResolvedValue();
      vi.mocked(providerService.listProviders).mockResolvedValue([provider]);

      await useProvidersStore.getState().setDefault(provider.id);

      expect(providerService.setDefaultProvider).toHaveBeenCalledWith(provider.id);
      expect(providerService.listProviders).toHaveBeenCalled();
      expect(useProvidersStore.getState().providers).toEqual([provider]);
    });
  });
});
