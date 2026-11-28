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
      loading: false,
      loaded: false,
    });
  });

  describe("初始状态", () => {
    it("应该使用默认设置和回退宠物", () => {
      const state = useCCChanStore.getState();
      expect(state.settings).toEqual(DEFAULT_CCCHAN_SETTINGS);
      expect(state.pets).toEqual([FALLBACK_PET]);
      expect(state.loaded).toBe(false);
    });
  });

  describe("load", () => {
    it("应该加载设置与宠物并标记 loaded", async () => {
      // 旧版本设置：带已删除的 aiEngine / soundEnabled / wanderEnabled。
      const settings = {
        aiEngine: "codex",
        defaultPetId: "cat",
        autoStart: true,
        soundEnabled: false,
        wanderEnabled: true,
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
      // 旧字段被丢弃，缺的新字段由 normalize 补默认值
      expect(state.settings).toEqual({
        defaultPetId: "cat",
        autoStart: true,
        windowVisible: true,
        windowX: 10,
        windowY: 20,
        windowPosPhysical: false,
        petSize: 120,
        activeBotId: null,
        appearance: "pet",
        orbSort: "recent",
        orbHoverSwitch: true,
      });
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
        activeBotId: "bot-1",
      };

      await useCCChanStore.getState().saveSettings(settings);

      expect(mockInvoke).toHaveBeenCalledWith("save_ccchan_settings", {
        settings,
      });
      expect(useCCChanStore.getState().settings).toEqual(settings);
    });
  });

  describe("新字段默认值与规范化", () => {
    it("默认 petSize 为 120、未选 Bot", () => {
      expect(DEFAULT_CCCHAN_SETTINGS.petSize).toBe(120);
      expect(DEFAULT_CCCHAN_SETTINGS.activeBotId).toBeNull();
    });

    it("applySettings 应只更新内存并 clamp petSize", () => {
      useCCChanStore.getState().applySettings({
        ...DEFAULT_CCCHAN_SETTINGS,
        activeBotId: "  ",
        petSize: 999,
      });

      const state = useCCChanStore.getState();
      expect(state.settings.activeBotId).toBeNull();
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

  describe("setter", () => {
    it("setWindowVisible 应仅更新 settings.windowVisible", () => {
      useCCChanStore.getState().setWindowVisible(true);
      const state = useCCChanStore.getState();
      expect(state.settings.windowVisible).toBe(true);
      expect(state.settings.defaultPetId).toBe(DEFAULT_CCCHAN_SETTINGS.defaultPetId);
    });

    it("setActiveBotId 应落盘当前 Bot", async () => {
      mockTauriInvoke({ save_ccchan_settings: undefined });
      await useCCChanStore.getState().setActiveBotId("b2");
      expect(mockInvoke).toHaveBeenCalledWith("save_ccchan_settings", {
        settings: { ...DEFAULT_CCCHAN_SETTINGS, activeBotId: "b2" },
      });
      expect(useCCChanStore.getState().settings.activeBotId).toBe("b2");
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
it("defaults legacy settings without appearance to the pet and normalizes orb fields", async () => {
  const { normalizeCCChanSettings } = await import("./useCCChanStore");
  const legacy = normalizeCCChanSettings({ defaultPetId: "homie", petSize: 120 } as never);
  expect(legacy).toMatchObject({ appearance: "pet", orbSort: "recent", orbHoverSwitch: true });
  const bogus = normalizeCCChanSettings({ appearance: "ball", orbSort: "x", orbHoverSwitch: "no" } as never);
  expect(bogus).toMatchObject({ appearance: "pet", orbSort: "recent", orbHoverSwitch: true });
  const orb = normalizeCCChanSettings({ appearance: "orb", orbSort: "attention", orbHoverSwitch: false });
  expect(orb).toMatchObject({ appearance: "orb", orbSort: "attention", orbHoverSwitch: false });
});
