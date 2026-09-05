import { beforeEach, describe, expect, it } from "vitest";
import {
  canonicalUiDensity,
  DEFAULT_UI_DENSITY,
  restoreUiDensityFromStorage,
  UI_DENSITY_STORAGE_KEY,
  useDensityStore,
} from "./useDensityStore";

describe("useDensityStore", () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.density;
    useDensityStore.setState({ density: DEFAULT_UI_DENSITY });
  });

  it("默认档为 comfortable", () => {
    expect(DEFAULT_UI_DENSITY).toBe("comfortable");
    expect(useDensityStore.getState().density).toBe("comfortable");
  });

  it("setDensity 同步 store、dataset 与 localStorage", () => {
    useDensityStore.getState().setDensity("compact");

    expect(useDensityStore.getState().density).toBe("compact");
    expect(document.documentElement.dataset.density).toBe("compact");
    expect(localStorage.getItem(UI_DENSITY_STORAGE_KEY)).toBe("compact");
  });

  it("切回 comfortable 后持久化值随之更新", () => {
    useDensityStore.getState().setDensity("compact");
    useDensityStore.getState().setDensity("comfortable");

    expect(useDensityStore.getState().density).toBe("comfortable");
    expect(document.documentElement.dataset.density).toBe("comfortable");
    expect(localStorage.getItem(UI_DENSITY_STORAGE_KEY)).toBe("comfortable");
  });

  it("非法值回落为 comfortable（防注入 / 防脏缓存）", () => {
    expect(canonicalUiDensity("compact")).toBe("compact");
    expect(canonicalUiDensity("comfortable")).toBe("comfortable");
    expect(canonicalUiDensity("dense")).toBe("comfortable");
    expect(canonicalUiDensity(null)).toBe("comfortable");
    expect(canonicalUiDensity("compact; color: red")).toBe("comfortable");

    useDensityStore.getState().setDensity("compact; color: red");
    expect(useDensityStore.getState().density).toBe("comfortable");
    expect(document.documentElement.dataset.density).toBe("comfortable");
  });

  it("启动恢复：从 localStorage 还原 compact 并写回 dataset", () => {
    localStorage.setItem(UI_DENSITY_STORAGE_KEY, "compact");

    expect(restoreUiDensityFromStorage()).toBe("compact");
    expect(document.documentElement.dataset.density).toBe("compact");
  });

  it("启动恢复：缓存非法时回落 comfortable", () => {
    localStorage.setItem(UI_DENSITY_STORAGE_KEY, "ultra-wide");

    expect(restoreUiDensityFromStorage()).toBe("comfortable");
    expect(document.documentElement.dataset.density).toBe("comfortable");
    // 非法缓存被规范化回写，避免每次启动都命中脏值分支
    expect(localStorage.getItem(UI_DENSITY_STORAGE_KEY)).toBe("comfortable");
  });

  it("启动恢复：无缓存时为 comfortable", () => {
    expect(restoreUiDensityFromStorage()).toBe("comfortable");
    expect(document.documentElement.dataset.density).toBe("comfortable");
  });
});
