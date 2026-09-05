// 壁纸视频「遮挡/不可见即暂停」测试：mock 各 store 的原子字段 + video 元素方法，
// 验证有效可见性信号（视图层可见 && 未被亮色终端纯色垫层完全遮挡）驱动 play/pause。
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MainWallpaperLayer from "./MainWallpaperLayer";
import type { WallpaperSettings } from "@/types";
import type { WallpaperVideoPolicy } from "@/utils/wallpaperVideoPolicy";
import type { AppViewMode } from "@/stores/useActivityBarStore";

const wallpaperState = vi.hoisted(() => ({
  resolved: null as WallpaperSettings | null,
  assetUrl: null as string | null,
  videoPolicy: null as WallpaperVideoPolicy | null,
  markVideoDecodeFailed: vi.fn(),
}));

const miniModeState = vi.hoisted(() => ({ isMiniMode: false }));
const activityBarState = vi.hoisted(() => ({ appViewMode: "panes" as AppViewMode }));
const themeState = vi.hoisted(() => ({ isDark: true }));
const canvasDisplayState = vi.hoisted(() => ({ mode: "panel" as "panel" | "canvas" }));

const terminalTab = {
  id: "t1",
  title: "zsh",
  contentType: "terminal",
  projectId: "p1",
  projectPath: "/proj",
  sessionId: null,
};

interface MockPanelNode {
  type: "panel";
  id: string;
  tabs: unknown[];
  activeTabId: string | null;
}

const panesState = vi.hoisted(() => ({
  rootPane: { type: "panel", id: "root", tabs: [], activeTabId: null } as MockPanelNode,
}));

vi.mock("@/stores/useWallpaperStore", () => ({
  useWallpaperStore: (selector: (s: typeof wallpaperState) => unknown) =>
    selector(wallpaperState),
}));
vi.mock("@/stores/useMiniModeStore", () => ({
  useMiniModeStore: (selector: (s: typeof miniModeState) => unknown) => selector(miniModeState),
}));
vi.mock("@/stores/useActivityBarStore", () => ({
  useActivityBarStore: (selector: (s: typeof activityBarState) => unknown) =>
    selector(activityBarState),
}));
vi.mock("@/stores/useThemeStore", () => ({
  useThemeStore: (selector: (s: typeof themeState) => unknown) => selector(themeState),
}));
vi.mock("@/stores/useCanvasDisplayStore", () => ({
  useCanvasDisplayStore: (selector: (s: typeof canvasDisplayState) => unknown) =>
    selector(canvasDisplayState),
}));
vi.mock("@/stores/usePanesStore", () => ({
  usePanesStore: (selector: (s: typeof panesState) => unknown) => selector(panesState),
}));

function useVideoWallpaper() {
  wallpaperState.resolved = {
    enabled: true,
    kind: "video",
    file: "wallpaper.mp4",
    fit: "cover",
    opacity: 1,
    blur: 0,
    dim: 0,
    terminalOpacity: 1,
    glassBlur: 0,
    video: { autoplay: true, playbackRate: 1, pauseWhenUnfocused: false, powerSaver: "auto" },
    music: {
      enabled: false,
      file: null,
      volume: 1,
      loopPlayback: true,
      autoplay: false,
      pauseWhenUnfocused: false,
      useVideoAudio: false,
    },
  };
  wallpaperState.assetUrl = "asset://wallpaper.mp4";
  wallpaperState.videoPolicy = { mode: "video", reason: "auto-video" };
}

function useTerminalLayout() {
  panesState.rootPane = {
    type: "panel",
    id: "root",
    tabs: [terminalTab],
    activeTabId: "t1",
  };
}

function useEmptyLayout() {
  panesState.rootPane = { type: "panel", id: "root", tabs: [], activeTabId: null };
}

describe("MainWallpaperLayer 视频壁纸有效可见性（遮挡/不可见即暂停）", () => {
  let playSpy: ReturnType<typeof vi.spyOn>;
  let pauseSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // 先恢复原型方法：重复 spyOn 同一方法会复用旧 spy，调用历史跨用例累积
    vi.restoreAllMocks();
    useVideoWallpaper();
    useEmptyLayout();
    themeState.isDark = true;
    canvasDisplayState.mode = "panel";
    activityBarState.appViewMode = "panes";
    miniModeState.isMiniMode = false;
    playSpy = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockReturnValue(Promise.resolve());
    pauseSpy = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  });

  it("可见且无遮挡：起播（play 被调）", () => {
    const { container } = render(<MainWallpaperLayer />);
    expect(container.querySelector("video")).not.toBeNull();
    expect(playSpy).toHaveBeenCalled();
  });

  it("亮色 + 终端主导 + panel 模式：垫层完全遮挡 → pause，不起播", () => {
    themeState.isDark = false;
    useTerminalLayout();
    render(<MainWallpaperLayer />);
    expect(pauseSpy).toHaveBeenCalled();
    expect(playSpy).not.toHaveBeenCalled();
  });

  it("遮挡解除（主题切暗 / 终端关闭）→ 恢复 play", () => {
    themeState.isDark = false;
    useTerminalLayout();
    const { rerender } = render(<MainWallpaperLayer />);
    expect(playSpy).not.toHaveBeenCalled();

    // 主题切暗：垫层条件不再成立，壁纸重新可见
    themeState.isDark = true;
    rerender(<MainWallpaperLayer />);
    expect(playSpy).toHaveBeenCalledTimes(1);

    // 再次遮挡（切回亮色），随后终端 tab 关闭也解除遮挡
    themeState.isDark = false;
    rerender(<MainWallpaperLayer />);
    expect(pauseSpy).toHaveBeenCalled();
    playSpy.mockClear();
    useEmptyLayout();
    rerender(<MainWallpaperLayer />);
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it("canvas 模式不垫：节点间透壁纸是该视图设计，视频继续播", () => {
    themeState.isDark = false;
    useTerminalLayout();
    canvasDisplayState.mode = "canvas";
    render(<MainWallpaperLayer />);
    expect(playSpy).toHaveBeenCalled();
  });

  it("切到非 panes 全屏视图 → pause；切回 panes → play", () => {
    const { rerender } = render(<MainWallpaperLayer />);
    expect(playSpy).toHaveBeenCalledTimes(1);

    activityBarState.appViewMode = "home";
    rerender(<MainWallpaperLayer />);
    expect(pauseSpy).toHaveBeenCalled();

    playSpy.mockClear();
    activityBarState.appViewMode = "panes";
    rerender(<MainWallpaperLayer />);
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it("orchestration 是 panes 兼容态：壁纸仍可见，不暂停", () => {
    activityBarState.appViewMode = "orchestration";
    render(<MainWallpaperLayer />);
    expect(playSpy).toHaveBeenCalled();
  });

  it("play() 被 AbortError 拒绝时静默吞掉，不向调用方抛", () => {
    playSpy.mockReturnValue(
      Promise.reject(new DOMException("interrupted", "AbortError")),
    );
    expect(() => render(<MainWallpaperLayer />)).not.toThrow();
  });

  it("图片壁纸不渲染 video，也不触达 play/pause", () => {
    useVideoWallpaper();
    wallpaperState.resolved = { ...wallpaperState.resolved!, kind: "image" };
    const { container } = render(<MainWallpaperLayer />);
    expect(container.querySelector("video")).toBeNull();
    expect(playSpy).not.toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();
  });
});
