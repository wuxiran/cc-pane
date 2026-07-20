// 壁纸背景音乐：HTMLAudioElement 单例（流式解码，**不用** Web Audio 解码整文件——
// 大 mp3 吃内存）。「单例 + 恢复」思路参考 notificationSound.ts，但不共享实例
// （那是合成音，采样率/生命周期不同）。
//
// 换曲淡出淡入（约 200ms，setInterval 调 volume）避免爆音。

const FADE_MS = 200;
const FADE_STEP_MS = 20;

let audio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;
let targetVolume = 0.5;
let fadeTimer: ReturnType<typeof setInterval> | null = null;

function clearFade() {
  if (fadeTimer !== null) {
    clearInterval(fadeTimer);
    fadeTimer = null;
  }
}

function fadeTo(volume: number, onDone?: () => void) {
  const element = audio;
  if (!element) {
    onDone?.();
    return;
  }
  clearFade();
  const from = element.volume;
  const steps = Math.max(1, Math.round(FADE_MS / FADE_STEP_MS));
  let step = 0;
  fadeTimer = setInterval(() => {
    step += 1;
    const ratio = Math.min(1, step / steps);
    element.volume = Math.min(1, Math.max(0, from + (volume - from) * ratio));
    if (ratio >= 1) {
      clearFade();
      onDone?.();
    }
  }, FADE_STEP_MS);
}

export interface EnsureMusicOptions {
  volume: number;
  loop: boolean;
}

/**
 * 保证单例指向给定 URL。URL 变化时淡出旧曲 → 换源；音量/循环即时生效。
 * 不主动播放——调用方决定何时 play()。
 */
export function ensureMusic(url: string, options: EnsureMusicOptions): void {
  targetVolume = Math.min(1, Math.max(0, options.volume));
  if (!audio) {
    audio = new Audio();
    audio.preload = "auto";
  }
  const element = audio;
  element.loop = options.loop;
  if (currentUrl === url) {
    // 同曲：音量平滑到位即可
    fadeTo(targetVolume);
    return;
  }
  const wasPlaying = currentUrl !== null && !element.paused;
  currentUrl = url;
  const swap = () => {
    element.src = url;
    element.volume = 0;
    if (wasPlaying) {
      void element.play().then(
        () => fadeTo(targetVolume),
        () => {},
      );
    } else {
      element.volume = targetVolume;
    }
  };
  if (wasPlaying) {
    fadeTo(0, swap);
  } else {
    swap();
  }
}

/** 尝试播放；autoplay 被拒（NotAllowedError 等）时返回 false，由调用方走手势兜底 */
export async function play(): Promise<boolean> {
  const element = audio;
  if (!element || !currentUrl) return false;
  try {
    await element.play();
    fadeTo(targetVolume);
    return true;
  } catch {
    return false;
  }
}

export function pause(): void {
  const element = audio;
  if (!element || element.paused) return;
  fadeTo(0, () => {
    element.pause();
  });
}

export function isPlaying(): boolean {
  return audio !== null && !audio.paused;
}

export function setVolume(volume: number): void {
  targetVolume = Math.min(1, Math.max(0, volume));
  fadeTo(targetVolume);
}

export function dispose(): void {
  clearFade();
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }
  audio = null;
  currentUrl = null;
}
