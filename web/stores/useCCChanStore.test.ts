import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { PetMeta } from "@/ccchan/types";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";
import {
  useCCChanStore,
  DEFAULT_CCCHAN_SETTINGS,
  FALLBACK_PET,
} from "./useCCChanStore";

const mockInvoke = invoke as ReturnType<typeof vi.fn>;

function createPet(id: string): PetMeta {
  return {
    id,
    displayName: id,
    description: "",
    spritesheetUrl: "data:image/svg+xml;utf8,x",
    atlas: { cellW: 64, cellH: 64, cols: 1, rows: 1 },
    animations: {
      idle: { row: 0, frames: 1, fps: 1 },
    },
  };
}

describe("useCCChanStore", () => {
  beforeEach(() => {
    resetTauriInvoke();
    useCCChanStore.setState({
      settings: DEFAULT_CCCHAN_SETTINGS,
      pets: [FALLBACK_PET],
      expanded: false,
      chatSessionId: null,
      loading: false,
      loaded: false,
    });
  });

  describe("初始状态", () => {
    it("应该使用默认设置和回退宠物", () => {
      const state = useCCChanStore.getState();
      expect(state.settings).toEqual(DEFAULT_CCCHAN_SETTINGS);
      expect(state.pets).toEqual([FALLBACK_PET]);
      expect(state.expanded).toBe(false);
      expect(state.loaded).toBe(false);
    });
  });

  describe("load", () => {
    it("应该加载设置与宠物并标记 loaded", async () => {
      const settings = {
        aiEngine: "codex" as const,
        defaultPetId: "cat",
        autoStart: true,
        soundEnabled: false,
        windowVisible: true,
        windowX: 10,
        windowY: 20,
      };
      const pets = [createPet("cat"), createPet("dog")];
      mockTauriInvoke({
        get_ccchan_settings: settings,
        get_ccchan_pets: pets,
      });

      await useCCChanStore.getState().load();

      const state = useCCChanStore.getState();
      // 旧配置缺新字段时由 normalize 补默认值
      expect(state.settings).toEqual({ ...settings, wanderEnabled: false, petSize: 120 });
      expect(state.pets).toEqual(pets);
      expect(state.loaded).toBe(true);
      expect(state.loading).toBe(false);
    });

    it("宠物列表为空时应回退到 FALLBACK_PET", async () => {
      mockTauriInvoke({
        get_ccchan_settings: DEFAULT_CCCHAN_SETTINGS,
        get_ccchan_pets: [],
      });

      await useCCChanStore.getState().load();

      expect(useCCChanStore.getState().pets).toEqual([FALLBACK_PET]);
    });

    it("invoke 失败时应回退到默认值", async () => {
      mockTauriInvoke({
        get_ccchan_settings: () => {
          throw new Error("settings fail");
        },
        get_ccchan_pets: () => {
          throw new Error("pets fail");
        },
      });

      await useCCChanStore.getState().load();

      const state = useCCChanStore.getState();
      expect(state.settings).toEqual(DEFAULT_CCCHAN_SETTINGS);
      expect(state.pets).toEqual([FALLBACK_PET]);
      expect(state.loaded).toBe(true);
      expect(state.loading).toBe(false);
    });

    it("正在加载时应直接返回不再调用 invoke", async () => {
      useCCChanStore.setState({ loading: true });

      await useCCChanStore.getState().load();

      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });

  describe("saveSettings", () => {
    it("应该规范化设置、调用 invoke 并更新 state", async () => {
      mockTauriInvoke({ save_ccchan_settings: undefined });
      const settings = {
        ...DEFAULT_CCCHAN_SETTINGS,
        aiEngine: "codex" as const,
        soundEnabled: false,
      };

      await useCCChanStore.getState().saveSettings(settings);

      expect(mockInvoke).toHaveBeenCalledWith("save_ccchan_settings", {
        settings,
      });
      expect(useCCChanStore.getState().settings).toEqual(settings);
    });
  });

  describe("新字段默认值与规范化", () => {
    it("默认漫游关闭、petSize 为 120", () => {
      expect(DEFAULT_CCCHAN_SETTINGS.wanderEnabled).toBe(false);
      expect(DEFAULT_CCCHAN_SETTINGS.petSize).toBe(120);
    });

    it("applySettings 应只更新内存并 clamp petSize", () => {
      useCCChanStore.getState().applySettings({
        ...DEFAULT_CCCHAN_SETTINGS,
        wanderEnabled: true,
        petSize: 999,
      });

      const state = useCCChanStore.getState();
      expect(state.settings.wanderEnabled).toBe(true);
      expect(state.settings.petSize).toBe(240);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("applySettings 对非法 petSize 回退默认值", () => {
      useCCChanStore.getState().applySettings({ petSize: Number.NaN });
      expect(useCCChanStore.getState().settings.petSize).toBe(120);

      useCCChanStore.getState().applySettings({ petSize: 10 });
      expect(useCCChanStore.getState().settings.petSize).toBe(80);
    });

    it("saveSettings 应先 clamp 再落盘", async () => {
      mockTauriInvoke({ save_ccchan_settings: undefined });

      await useCCChanStore.getState().saveSettings({
        ...DEFAULT_CCCHAN_SETTINGS,
        petSize: 500,
      });

      expect(mockInvoke).toHaveBeenCalledWith("save_ccchan_settings", {
        settings: { ...DEFAULT_CCCHAN_SETTINGS, petSize: 240 },
      });
      expect(useCCChanStore.getState().settings.petSize).toBe(240);
    });
  });

  describe("同步 setter", () => {
    it("setExpanded 应更新 expanded", () => {
      useCCChanStore.getState().setExpanded(true);
      expect(useCCChanStore.getState().expanded).toBe(true);
    });

    it("setChatSessionId 应更新 chatSessionId", () => {
      useCCChanStore.getState().setChatSessionId("sess-1");
      expect(useCCChanStore.getState().chatSessionId).toBe("sess-1");
    });

    it("setWindowVisible 应仅更新 settings.windowVisible", () => {
      useCCChanStore.getState().setWindowVisible(true);
      const state = useCCChanStore.getState();
      expect(state.settings.windowVisible).toBe(true);
      expect(state.settings.aiEngine).toBe(DEFAULT_CCCHAN_SETTINGS.aiEngine);
    });

    it("setPosition 应更新窗口坐标", () => {
      useCCChanStore.getState().setPosition(100, 200);
      const state = useCCChanStore.getState();
      expect(state.settings.windowX).toBe(100);
      expect(state.settings.windowY).toBe(200);
    });

    it("setDefaultPetId 应更新默认宠物", () => {
      useCCChanStore.getState().setDefaultPetId("cat");
      expect(useCCChanStore.getState().settings.defaultPetId).toBe("cat");
    });
  });

  describe("switchPet", async () => {
    it("应该切换到下一个宠物", async () => {
      useCCChanStore.setState({
        pets: [createPet("a"), createPet("b"), createPet("c")],
        settings: { ...DEFAULT_CCCHAN_SETTINGS, defaultPetId: "a" },
      });

      await useCCChanStore.getState().switchPet();

      expect(useCCChanStore.getState().settings.defaultPetId).toBe("b");
    });

    it("在最后一个宠物时应回绕到第一个", async () => {
      useCCChanStore.setState({
        pets: [createPet("a"), createPet("b")],
        settings: { ...DEFAULT_CCCHAN_SETTINGS, defaultPetId: "b" },
      });

      await useCCChanStore.getState().switchPet();

      expect(useCCChanStore.getState().settings.defaultPetId).toBe("a");
    });

    it("当前宠物不在列表时应从索引 0 的下一个开始", async () => {
      useCCChanStore.setState({
        pets: [createPet("a"), createPet("b")],
        settings: { ...DEFAULT_CCCHAN_SETTINGS, defaultPetId: "unknown" },
      });

      await useCCChanStore.getState().switchPet();

      expect(useCCChanStore.getState().settings.defaultPetId).toBe("b");
    });

    it("宠物列表为空时不应改变设置", async () => {
      useCCChanStore.setState({
        pets: [],
        settings: { ...DEFAULT_CCCHAN_SETTINGS, defaultPetId: "homie" },
      });

      await useCCChanStore.getState().switchPet();

      expect(useCCChanStore.getState().settings.defaultPetId).toBe("homie");
    });
  });
});


it("does not overwrite newer pushed settings with an older in-flight load", async () => {
  let finish!: (settings: typeof DEFAULT_CCCHAN_SETTINGS) => void;
  useCCChanStore.setState({ loading: false, settings: DEFAULT_CCCHAN_SETTINGS });
  mockTauriInvoke({ get_ccchan_settings: () => new Promise((resolve) => { finish = resolve; }), get_ccchan_pets: [FALLBACK_PET] });
  const loading = useCCChanStore.getState().load();
  useCCChanStore.getState().applySettings({ petSize: 200 });
  finish(DEFAULT_CCCHAN_SETTINGS);
  await loading;
  expect(useCCChanStore.getState().settings.petSize).toBe(200);
});
it("preserves other settings when receiving a partial update", () => {
  useCCChanStore.setState({ settings: { ...DEFAULT_CCCHAN_SETTINGS, defaultPetId: "doro.codex-pet", windowX: 100 } });
  useCCChanStore.getState().applySettings({ petSize: 200 });
  expect(useCCChanStore.getState().settings).toMatchObject({ petSize: 200, defaultPetId: "doro.codex-pet", windowX: 100 });
});
