import { describe, it, expect, beforeEach, vi } from "vitest";
import { useSettingsStore } from "./useSettingsStore";
import { settingsService } from "@/services";
import { createTestSettings, resetTestDataCounter } from "@/test/utils/testData";

vi.mock("@/services", () => ({
  settingsService: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
  },
}));

describe("useSettingsStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTestDataCounter();
    useSettingsStore.setState({
      settings: null,
      loading: false,
    });
  });

  describe("初始状态", () => {
    it("应该有正确的初始值", () => {
      const state = useSettingsStore.getState();
      expect(state.settings).toBeNull();
      expect(state.loading).toBe(false);
    });
  });

  describe("loadSettings", () => {
    it("应调用 getSettings 并设置 settings", async () => {
      const mockSettings = createTestSettings();
      vi.mocked(settingsService.getSettings).mockResolvedValue(mockSettings);

      await useSettingsStore.getState().loadSettings();

      const state = useSettingsStore.getState();
      expect(state.settings).toEqual(mockSettings);
      expect(state.loading).toBe(false);
    });

    it("加载期间 loading 应为 true", async () => {
      vi.mocked(settingsService.getSettings).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(createTestSettings()), 10))
      );

      const loadPromise = useSettingsStore.getState().loadSettings();
      expect(useSettingsStore.getState().loading).toBe(true);

      await loadPromise;
      expect(useSettingsStore.getState().loading).toBe(false);
    });

    it("加载失败时不应抛异常且 loading 恢复 false", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(settingsService.getSettings).mockRejectedValue(
        new Error("load failed")
      );

      // loadSettings 内部 catch 了错误，不会抛出
      await useSettingsStore.getState().loadSettings();

      expect(useSettingsStore.getState().loading).toBe(false);
      expect(useSettingsStore.getState().settings).toBeNull();
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe("saveSettings", () => {
    it("应调用 updateSettings 并更新 settings", async () => {
      const newSettings = createTestSettings({
        theme: { mode: "light" },
      });
      vi.mocked(settingsService.updateSettings).mockResolvedValue();

      await useSettingsStore.getState().saveSettings(newSettings);

      const state = useSettingsStore.getState();
      expect(state.settings).toEqual(newSettings);
      expect(settingsService.updateSettings).toHaveBeenCalledWith(newSettings);
    });

    it("保存失败时应抛异常", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(settingsService.updateSettings).mockRejectedValue(
        new Error("save failed")
      );

      await expect(
        useSettingsStore.getState().saveSettings(createTestSettings())
      ).rejects.toThrow("save failed");

      consoleSpy.mockRestore();
    });
  });

  describe("getDefaults", () => {
    it("应返回完整默认设置", () => {
      const defaults = useSettingsStore.getState().getDefaults();

      expect(defaults.theme.mode).toBe("dark");
      expect(defaults.terminal.fontSize).toBe(14);
      expect(defaults.terminal.cursorStyle).toBe("block");
      expect(defaults.proxy.enabled).toBe(false);
      expect(defaults.general.language).toBe("zh-CN");
      expect(defaults.notification.enabled).toBe(true);
    });

    it("快捷键绑定应有 19 个", () => {
      const defaults = useSettingsStore.getState().getDefaults();
      const bindingCount = Object.keys(defaults.shortcuts.bindings).length;
      expect(bindingCount).toBe(19);
    });

    it("应包含关键快捷键定义", () => {
      const defaults = useSettingsStore.getState().getDefaults();
      const bindings = defaults.shortcuts.bindings;

      expect(bindings["toggle-sidebar"]).toBe("Ctrl+B");
      expect(bindings["new-tab"]).toBe("Ctrl+T");
      expect(bindings["close-tab"]).toBe("Ctrl+W");
      expect(bindings["settings"]).toBe("Ctrl+,");
      expect(bindings["split-right"]).toBe("Ctrl+\\");
    });
  });
});
