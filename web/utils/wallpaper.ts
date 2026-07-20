// 壁纸合并 / 收敛纯函数：不碰 store、不碰 Tauri，可独立单测。
// 合并语义（docs/39）：off → null；custom → 以全局为底逐字段浅覆盖（未设字段回落全局）；
// inherit/未设 → 全局；全局 enabled === false（且非 custom）→ null。
import type {
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
    terminalOpacity: clampNumber(settings.terminalOpacity, 0.3, 1, 0.85),
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
  partial: Partial<WallpaperSettings>,
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
