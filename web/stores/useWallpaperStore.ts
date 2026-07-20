// 壁纸解析状态：持有**已解析的扁平结果**。
//
// ⚠️ 不要写 useSettingsStore(s => resolveWallpaper(...)) 这种 selector——每次返回
// 新对象会撞 `Maximum update depth exceeded`（CLAUDE.md「Zustand selector」条目）。
// 解析只发生在 recompute()（settings 变更 / 切工作空间时触发），组件只做原子字段 selector。
import { create } from "zustand";
import type { WallpaperSettings } from "@/types";
import { setTerminalTransparencyProvider } from "@/components/panes/terminalRenderer";
import { initWallpaperMusicController } from "@/utils/wallpaperMusicController";
import { resolveWallpaper } from "@/utils/wallpaper";
import {
  collectWallpaperVideoPolicyEnvironment,
  decideWallpaperVideoPolicy,
  type WallpaperVideoPolicy,
} from "@/utils/wallpaperVideoPolicy";
import { isTauriRuntime } from "@/services/runtime";
import { wallpaperService } from "@/services";
import { useSettingsStore } from "./useSettingsStore";
import { useWorkspacesStore } from "./useWorkspacesStore";

export type { WallpaperVideoPolicy };

interface WallpaperState {
  /** 当前生效的壁纸配置；null = 未激活（界面走原始不透明路径） */
  resolved: WallpaperSettings | null;
  /** kind 为 image/video 且文件校验通过时的 asset URL */
  assetUrl: string | null;
  /** 音乐文件的 asset URL（阶段 3 消费） */
  musicUrl: string | null;
  /** 视频降级决策（kind=video 时由 recompute 产出；decode 失败运行时改写） */
  videoPolicy: WallpaperVideoPolicy | null;
  /** 视频 onerror（codec 不支持等）→ 降 poster 而非黑屏 */
  markVideoDecodeFailed: () => void;
  /** 音乐自动播放被拒、等待用户手势（StatusBar 音符按钮入口） */
  musicGestureNeeded: boolean;
  /** 音乐当前是否在播（由 wallpaperMusicController 维护，供 UI 渲染图标） */
  musicPlaying: boolean;
  setMusicGestureNeeded: (needed: boolean) => void;
  recompute: () => Promise<void>;
}

let recomputeToken = 0;

export const useWallpaperStore = create<WallpaperState>((set) => ({
  resolved: null,
  assetUrl: null,
  musicUrl: null,
  videoPolicy: null,
  musicGestureNeeded: false,
  musicPlaying: false,

  setMusicGestureNeeded: (needed) => set({ musicGestureNeeded: needed }),

  markVideoDecodeFailed: () => set({ videoPolicy: { mode: "poster", reason: "decode-failed" } }),

  recompute: async () => {
    // 惰性初始化音乐编排（幂等）：不能放模块加载期——那会在测试 mock 就绪前
    // 调用 isTauriRuntime() 触发 TDZ/mock 未定义错误。
    initWallpaperMusicController();
    const token = ++recomputeToken;
    // 跨端门控：Web 端不消费壁纸
    if (!isTauriRuntime()) {
      set({ resolved: null, assetUrl: null, musicUrl: null, videoPolicy: null });
      return;
    }
    const global = useSettingsStore.getState().settings?.wallpaper ?? null;
    const workspace = useWorkspacesStore.getState().selectedWorkspace();
    const resolved = resolveWallpaper(global, workspace?.wallpaperOverride ?? null);

    if (!resolved) {
      set({ resolved: null, assetUrl: null, musicUrl: null, videoPolicy: null });
      return;
    }

    let assetUrl: string | null = null;
    let musicUrl: string | null = null;
    if (resolved.kind !== "none" && resolved.file) {
      try {
        assetUrl = await wallpaperService.resolveWallpaperAsset(resolved.file, resolved.kind);
      } catch {
        assetUrl = null; // 文件缺失/校验失败：壁纸层静默不显示，不打断主界面
      }
    }
    if (resolved.music.enabled && resolved.music.file) {
      try {
        musicUrl = await wallpaperService.resolveWallpaperAsset(resolved.music.file, "audio");
      } catch {
        musicUrl = null;
      }
    }
    let videoPolicy: WallpaperVideoPolicy | null = null;
    if (resolved.kind === "video" && assetUrl) {
      const env = await collectWallpaperVideoPolicyEnvironment();
      videoPolicy = decideWallpaperVideoPolicy(resolved.video.powerSaver, env);
    }
    // 竞态守卫：仅最后一次 recompute 允许落盘
    if (token !== recomputeToken) return;
    set({ resolved, assetUrl, musicUrl, videoPolicy });
  },
}));

// 终端渲染器的透明需求 provider：decideTerminalRenderer 是纯函数模块，不 import store，
// 由这里注入。只有壁纸激活且 terminalOpacity < 1 才要求 DOM 渲染器。
setTerminalTransparencyProvider(() => {
  const state = useWallpaperStore.getState();
  return state.resolved !== null && state.assetUrl !== null && state.resolved.terminalOpacity < 1;
});

// settings / 选中工作空间变更时重算（模块级订阅，避免组件层反复接线）
useSettingsStore.subscribe((state, prev) => {
  if (state.settings?.wallpaper !== prev.settings?.wallpaper) {
    void useWallpaperStore.getState().recompute();
  }
});
useWorkspacesStore.subscribe((state, prev) => {
  if (
    state.expandedWorkspaceId !== prev.expandedWorkspaceId ||
    state.workspaces !== prev.workspaces
  ) {
    void useWallpaperStore.getState().recompute();
  }
});
