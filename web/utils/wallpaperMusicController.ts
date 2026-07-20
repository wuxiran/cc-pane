// 壁纸音乐编排：把 useWallpaperStore 的解析结果驱动到 wallpaperMusic 单例，
// 并处理 autoplay 三层兜底与暂停规则。仅 Tauri 桌面端初始化。
//
// 自动播放兜底：
// 1. 尝试即播（play() 内部 catch NotAllowedError 返回 false）
// 2. 静默手势兜底：pointerdown/keydown once+capture 重试——用户点任何地方就起播
// 3. 显式入口：musicGestureNeeded=true 时 StatusBar 出音符按钮
//
// 暂停规则：hidden → pause；blur 按 music.pauseWhenUnfocused（独立于视频的同名开关，
// 默认 false —— BGM 属全局氛围，切走窗口未必想停）；MiniMode → pause；
// 主视图切走 panes 不暂停。
import { useWallpaperStore } from "@/stores/useWallpaperStore";
import { useMiniModeStore } from "@/stores/useMiniModeStore";
import { isTauriRuntime } from "@/services/runtime";
import * as music from "./wallpaperMusic";

let initialized = false;
let userPaused = false;
let gestureRetryArmed = false;

function wallpaperState() {
  return useWallpaperStore.getState();
}

function musicConfigured(): boolean {
  const state = wallpaperState();
  return state.musicUrl !== null && state.resolved?.music.enabled === true;
}

function shouldPlayNow(): boolean {
  if (!musicConfigured() || userPaused) return false;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return false;
  if (useMiniModeStore.getState().isMiniMode) return false;
  if (musicPausesOnBlur() && typeof document !== "undefined" && !document.hasFocus()) return false;
  return true;
}

function musicPausesOnBlur(): boolean {
  return wallpaperState().resolved?.music.pauseWhenUnfocused ?? false;
}

function setPlaying(playing: boolean) {
  const store = useWallpaperStore.getState();
  if (store.musicPlaying !== playing) {
    useWallpaperStore.setState({ musicPlaying: playing });
  }
}

async function tryPlay(): Promise<void> {
  if (!shouldPlayNow()) return;
  const ok = await music.play();
  setPlaying(ok);
  if (ok) {
    wallpaperState().setMusicGestureNeeded(false);
    return;
  }
  // autoplay 被拒：出显式入口 + 静默手势兜底（多数情况用户下一次点击就起播）
  wallpaperState().setMusicGestureNeeded(true);
  armGestureRetry();
}

function armGestureRetry() {
  if (gestureRetryArmed || typeof document === "undefined") return;
  gestureRetryArmed = true;
  const retry = () => {
    gestureRetryArmed = false;
    document.removeEventListener("pointerdown", retry, true);
    document.removeEventListener("keydown", retry, true);
    void tryPlay();
  };
  document.addEventListener("pointerdown", retry, { once: true, capture: true });
  document.addEventListener("keydown", retry, { once: true, capture: true });
}

function pauseNow() {
  music.pause();
  setPlaying(false);
}

/** 依据当前 store 状态同步单例：换曲/音量/循环/起停 */
function sync() {
  const state = wallpaperState();
  if (!musicConfigured()) {
    music.dispose();
    setPlaying(false);
    state.setMusicGestureNeeded(false);
    return;
  }
  const config = state.resolved!.music;
  music.ensureMusic(state.musicUrl!, {
    volume: config.volume,
    loop: config.loopPlayback,
  });
  if (config.autoplay && shouldPlayNow()) {
    void tryPlay();
  } else if (!shouldPlayNow() && music.isPlaying()) {
    pauseNow();
  }
}

/** StatusBar 音符按钮入口：手动播放/暂停（手动暂停后自动规则不再拉起） */
export function toggleWallpaperMusic(): void {
  if (music.isPlaying()) {
    userPaused = true;
    pauseNow();
  } else {
    userPaused = false;
    void tryPlay();
  }
}

export function initWallpaperMusicController(): void {
  if (initialized || !isTauriRuntime() || typeof document === "undefined") return;
  initialized = true;

  useWallpaperStore.subscribe((state, prev) => {
    if (
      state.musicUrl !== prev.musicUrl ||
      state.resolved?.music !== prev.resolved?.music
    ) {
      sync();
    }
  });

  useMiniModeStore.subscribe((state, prev) => {
    if (state.isMiniMode === prev.isMiniMode) return;
    if (state.isMiniMode) {
      pauseNow();
    } else {
      void tryPlay();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      pauseNow();
    } else {
      void tryPlay();
    }
  });
  window.addEventListener("blur", () => {
    if (musicPausesOnBlur()) pauseNow();
  });
  window.addEventListener("focus", () => {
    void tryPlay();
  });
}
