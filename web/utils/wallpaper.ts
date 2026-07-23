// 壁纸合并 / 收敛纯函数：不碰 store、不碰 Tauri，可独立单测。
// 合并语义（docs/39）：off → null；custom → 以全局为底逐字段浅覆盖（未设字段回落全局）；
// inherit/未设 → 全局；全局 enabled === false（且非 custom）→ null。
import type {
  WallpaperOverrideConfig,
  WallpaperSettings,
  WorkspaceWallpaperOverride,
} from "@/types";

export const DEFAULT_WALLPAPER: WallpaperSettings = {
  enabled: false,
  kind: "none",
  file: null,
  fit: "cover",
  opacity: 1,
  blur: 0,
  dim: 0.35,
  terminalOpacity: 0.85,
  glassBlur: 0,
  video: {
    autoplay: true,
    playbackRate: 1,
    pauseWhenUnfocused: true,
    powerSaver: "auto",
  },
  music: {
    enabled: false,
    file: null,
    volume: 0.5,
    loopPlayback: true,
    autoplay: true,
    pauseWhenUnfocused: false,
    useVideoAudio: false,
  },
};

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** 收敛数值到合法域、枚举回落默认（与 Rust merge_missing_defaults 同口径） */
export function clampWallpaper(settings: WallpaperSettings): WallpaperSettings {
  return {
    ...settings,
    kind: oneOf(settings.kind, ["none", "image", "video"] as const, "none"),
    fit: oneOf(settings.fit, ["cover", "contain", "tile", "center"] as const, "cover"),
    opacity: clampNumber(settings.opacity, 0.1, 1, 1),
    blur: clampNumber(settings.blur, 0, 64, 0),
    dim: clampNumber(settings.dim, 0, 0.9, 0.35),
    terminalOpacity: clampNumber(settings.terminalOpacity, 0, 1, 0.85),
    glassBlur: clampNumber(settings.glassBlur, 0, 24, 0),
    video: {
      ...settings.video,
      playbackRate: clampNumber(settings.video.playbackRate, 0.25, 2, 1),
      powerSaver: oneOf(settings.video.powerSaver, ["auto", "always", "never"] as const, "auto"),
    },
    music: {
      ...settings.music,
      volume: clampNumber(settings.music.volume, 0, 1, 0.5),
    },
  };
}

/** 逐字段浅覆盖：partial 里为 undefined 的字段回落 base；video/music 也逐字段 */
function mergeWallpaper(
  base: WallpaperSettings,
  partial: WallpaperOverrideConfig,
): WallpaperSettings {
  return {
    ...base,
    ...definedFields(partial),
    video: { ...base.video, ...definedFields(partial.video ?? {}) },
    music: { ...base.music, ...definedFields(partial.music ?? {}) },
  } as WallpaperSettings;
}

function definedFields<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined && entry !== null) {
      (out as Record<string, unknown>)[key] = entry;
    }
  }
  return out;
}

/** 音乐源判定结果：videoAudio = 复用视频的 asset URL；file = 需按音频单独解析的文件名 */
export type WallpaperMusicSource =
  | { kind: "videoAudio" }
  | { kind: "file"; file: string }
  | null;

/**
 * 判定 BGM 从哪来。抽成纯函数是为了能独立单测——store 的 recompute 里
 * 混着 Tauri 调用，那段分支不好覆盖。
 *
 * useVideoAudio 只在 kind=video 时成立：图片壁纸没有音轨可用，
 * 此时回落到 music.file，避免勾了开关就彻底没声还找不到原因。
 */
export function resolveMusicSource(settings: WallpaperSettings): WallpaperMusicSource {
  if (!settings.music.enabled) return null;
  if (settings.music.useVideoAudio && settings.kind === "video") {
    return { kind: "videoAudio" };
  }
  return settings.music.file ? { kind: "file", file: settings.music.file } : null;
}

/**
 * 解析当前生效的壁纸配置。返回 null 表示壁纸未激活（界面走原始不透明路径）。
 */
export function resolveWallpaper(
  global: WallpaperSettings | null | undefined,
  override: WorkspaceWallpaperOverride | null | undefined,
): WallpaperSettings | null {
  const base = global ?? DEFAULT_WALLPAPER;
  const mode = override?.mode ?? "inherit";
  if (mode === "off") return null;
  if (mode === "custom") {
    const merged = clampWallpaper(mergeWallpaper(base, override?.config ?? {}));
    return merged.enabled ? merged : null;
  }
  return base.enabled ? clampWallpaper(base) : null;
}
