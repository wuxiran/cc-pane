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
      config: { video: { pauseWhenUnfocused: false } },
    });
    expect(resolved?.video.playbackRate).toBe(0.5);
    expect(resolved?.video.pauseWhenUnfocused).toBe(false);
  });

  it("custom：滑杆类参数（透明度/模糊/暗化/终端不透明度）可整套覆盖", () => {
    const global = enabledGlobal({
      opacity: 1,
      blur: 0,
      dim: 0.35,
      terminalOpacity: 0.85,
    });
    const resolved = resolveWallpaper(global, {
      mode: "custom",
      config: { opacity: 0.6, blur: 20, dim: 0.7, terminalOpacity: 0.4 },
    });
    expect(resolved?.opacity).toBe(0.6);
    expect(resolved?.blur).toBe(20);
    expect(resolved?.dim).toBe(0.7);
    expect(resolved?.terminalOpacity).toBe(0.4);
  });

  it("custom：只覆盖部分滑杆时，其余滑杆仍回落全局", () => {
    const global = enabledGlobal({ opacity: 0.9, blur: 6, dim: 0.5, terminalOpacity: 0.7 });
    const resolved = resolveWallpaper(global, { mode: "custom", config: { blur: 30 } });
    expect(resolved?.blur).toBe(30);
    expect(resolved?.opacity).toBe(0.9);
    expect(resolved?.dim).toBe(0.5);
    expect(resolved?.terminalOpacity).toBe(0.7);
  });

  it("custom：嵌套 music 逐字段覆盖，未设的 music 字段回落全局", () => {
    const global = enabledGlobal({
      music: { ...DEFAULT_WALLPAPER.music, enabled: true, file: "bgm.mp3", volume: 0.8 },
    });
    const resolved = resolveWallpaper(global, {
      mode: "custom",
      config: { music: { volume: 0.2, pauseWhenUnfocused: true } },
    });
    expect(resolved?.music.volume).toBe(0.2);
    expect(resolved?.music.pauseWhenUnfocused).toBe(true);
    // 未设字段仍来自全局
    expect(resolved?.music.file).toBe("bgm.mp3");
    expect(resolved?.music.enabled).toBe(true);
    expect(resolved?.music.loopPlayback).toBe(true);
  });

  it("custom：video 与 music 的 pauseWhenUnfocused 互不影响", () => {
    const global = enabledGlobal();
    const resolved = resolveWallpaper(global, {
      mode: "custom",
      config: { video: { pauseWhenUnfocused: false }, music: { pauseWhenUnfocused: true } },
    });
    expect(resolved?.video.pauseWhenUnfocused).toBe(false);
    expect(resolved?.music.pauseWhenUnfocused).toBe(true);
  });

  it("custom：覆盖 video 的一个字段不会整块替换 video", () => {
    const global = enabledGlobal({
      video: { ...DEFAULT_WALLPAPER.video, autoplay: false, powerSaver: "never" },
    });
    const resolved = resolveWallpaper(global, {
      mode: "custom",
      config: { video: { playbackRate: 1.5 } },
    });
    expect(resolved?.video.playbackRate).toBe(1.5);
    expect(resolved?.video.autoplay).toBe(false);
    expect(resolved?.video.powerSaver).toBe("never");
  });

  it("custom：覆盖值同样被收敛到合法域", () => {
    const global = enabledGlobal();
    const resolved = resolveWallpaper(global, {
      mode: "custom",
      config: { dim: 5, blur: -10, music: { volume: 9 } },
    });
    expect(resolved?.dim).toBe(0.9);
    expect(resolved?.blur).toBe(0);
    expect(resolved?.music.volume).toBe(1);
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
