import { describe, it, expect } from "vitest";
import { DEFAULT_WALLPAPER, clampWallpaper, resolveWallpaper } from "./wallpaper";
import type { WallpaperSettings } from "@/types";

function enabledGlobal(partial: Partial<WallpaperSettings> = {}): WallpaperSettings {
  return {
    ...DEFAULT_WALLPAPER,
    enabled: true,
    kind: "image",
    file: "global.png",
    ...partial,
    video: { ...DEFAULT_WALLPAPER.video, ...partial.video },
    music: { ...DEFAULT_WALLPAPER.music, ...partial.music },
  };
}

describe("resolveWallpaper", () => {
  it("off 覆盖：无论全局如何都返回 null", () => {
    expect(resolveWallpaper(enabledGlobal(), { mode: "off" })).toBeNull();
    expect(resolveWallpaper(null, { mode: "off" })).toBeNull();
  });

  it("inherit / 未设 override：全局启用则返回全局，未启用返回 null", () => {
    const global = enabledGlobal();
    expect(resolveWallpaper(global, { mode: "inherit" })?.file).toBe("global.png");
    expect(resolveWallpaper(global, null)?.file).toBe("global.png");
    expect(resolveWallpaper({ ...global, enabled: false }, null)).toBeNull();
    expect(resolveWallpaper(null, null)).toBeNull();
  });

  it("custom：以全局为底逐字段浅覆盖，未设字段回落全局", () => {
    const global = enabledGlobal({ dim: 0.5, blur: 8 });
    const resolved = resolveWallpaper(global, {
      mode: "custom",
      config: { file: "ws.png", dim: 0.2 },
    });
    expect(resolved?.file).toBe("ws.png");
    expect(resolved?.dim).toBe(0.2);
    // 未设字段回落全局
    expect(resolved?.blur).toBe(8);
    expect(resolved?.kind).toBe("image");
  });

  it("custom：嵌套 video/music 也逐字段合并", () => {
    const global = enabledGlobal({ video: { ...DEFAULT_WALLPAPER.video, playbackRate: 0.5 } });
    const resolved = resolveWallpaper(global, {
      mode: "custom",
      config: { video: { pauseWhenUnfocused: false } as never },
    });
    expect(resolved?.video.playbackRate).toBe(0.5);
    expect(resolved?.video.pauseWhenUnfocused).toBe(false);
  });

  it("custom 可以在全局关闭时单独启用壁纸", () => {
    const global = { ...enabledGlobal(), enabled: false };
    const resolved = resolveWallpaper(global, {
      mode: "custom",
      config: { enabled: true, file: "ws.png" },
    });
    expect(resolved?.file).toBe("ws.png");
  });

  it("custom 合并后仍未启用则返回 null", () => {
    const global = { ...enabledGlobal(), enabled: false };
    expect(resolveWallpaper(global, { mode: "custom", config: { dim: 0.1 } })).toBeNull();
  });
});

describe("clampWallpaper", () => {
  it("数值收敛到合法域", () => {
    const clamped = clampWallpaper({
      ...enabledGlobal(),
      opacity: 5,
      blur: -3,
      dim: 2,
      terminalOpacity: 0,
      video: { ...DEFAULT_WALLPAPER.video, playbackRate: 99 },
      music: { ...DEFAULT_WALLPAPER.music, volume: -1 },
    });
    expect(clamped.opacity).toBe(1);
    expect(clamped.blur).toBe(0);
    expect(clamped.dim).toBe(0.9);
    expect(clamped.terminalOpacity).toBe(0.3);
    expect(clamped.video.playbackRate).toBe(2);
    expect(clamped.music.volume).toBe(0);
  });

  it("非法枚举与非数值回落默认", () => {
    const clamped = clampWallpaper({
      ...enabledGlobal(),
      kind: "gif" as never,
      fit: "stretch" as never,
      opacity: Number.NaN,
      video: { ...DEFAULT_WALLPAPER.video, powerSaver: "eco" as never },
    });
    expect(clamped.kind).toBe("none");
    expect(clamped.fit).toBe("cover");
    expect(clamped.opacity).toBe(1);
    expect(clamped.video.powerSaver).toBe("auto");
  });
});
