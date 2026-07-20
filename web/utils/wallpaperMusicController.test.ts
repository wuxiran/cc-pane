// 音乐失焦暂停：music.pauseWhenUnfocused 独立于 video 的同名开关。
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import type { WallpaperSettings } from "@/types";
import { DEFAULT_WALLPAPER } from "./wallpaper";

const wallpaperState = {
  resolved: null as WallpaperSettings | null,
  musicUrl: "asset://bgm.mp3" as string | null,
  musicPlaying: false,
  setMusicGestureNeeded: vi.fn(),
};

vi.mock("@/stores/useWallpaperStore", () => ({
  useWallpaperStore: {
    getState: () => wallpaperState,
    setState: (patch: Record<string, unknown>) => Object.assign(wallpaperState, patch),
    subscribe: () => () => {},
  },
}));

vi.mock("@/stores/useMiniModeStore", () => ({
  useMiniModeStore: {
    getState: () => ({ isMiniMode: false }),
    subscribe: () => () => {},
  },
}));

vi.mock("@/services/runtime", () => ({ isTauriRuntime: () => true }));

const musicMock = {
  play: vi.fn(async () => true),
  pause: vi.fn(),
  dispose: vi.fn(),
  ensureMusic: vi.fn(),
  isPlaying: vi.fn(() => true),
};
vi.mock("./wallpaperMusic", () => musicMock);

function resolvedWith(music: Partial<WallpaperSettings["music"]>, video = {}): WallpaperSettings {
  return {
    ...DEFAULT_WALLPAPER,
    enabled: true,
    kind: "image",
    file: "bg.png",
    video: { ...DEFAULT_WALLPAPER.video, ...video },
    music: { ...DEFAULT_WALLPAPER.music, enabled: true, file: "bgm.mp3", ...music },
  };
}

describe("wallpaperMusicController 失焦暂停", () => {
  beforeAll(async () => {
    const { initWallpaperMusicController } = await import("./wallpaperMusicController");
    initWallpaperMusicController();
  });

  beforeEach(() => {
    musicMock.pause.mockClear();
    musicMock.play.mockClear();
    wallpaperState.musicUrl = "asset://bgm.mp3";
  });

  it("默认（pauseWhenUnfocused=false）失焦不暂停 —— BGM 属全局氛围", () => {
    wallpaperState.resolved = resolvedWith({});
    expect(wallpaperState.resolved.music.pauseWhenUnfocused).toBe(false);

    window.dispatchEvent(new Event("blur"));

    expect(musicMock.pause).not.toHaveBeenCalled();
  });

  it("music.pauseWhenUnfocused=true 时失焦暂停", () => {
    wallpaperState.resolved = resolvedWith({ pauseWhenUnfocused: true });

    window.dispatchEvent(new Event("blur"));

    expect(musicMock.pause).toHaveBeenCalled();
  });

  it("video.pauseWhenUnfocused=true 不再牵连音乐（两个开关互相独立）", () => {
    wallpaperState.resolved = resolvedWith(
      { pauseWhenUnfocused: false },
      { pauseWhenUnfocused: true },
    );

    window.dispatchEvent(new Event("blur"));

    expect(musicMock.pause).not.toHaveBeenCalled();
  });

  it("未解析出壁纸时按默认 false 处理，不暂停", () => {
    wallpaperState.resolved = null;

    window.dispatchEvent(new Event("blur"));

    expect(musicMock.pause).not.toHaveBeenCalled();
  });
});
