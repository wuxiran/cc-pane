// 壁纸视频降级策略：照 decideTerminalRenderer 的 { mode, reason } 形状，
// 返回可诊断、可测的决策；env 全部可注入便于单测。
// 判定顺序先硬后软：用户强制 → reduced-motion → 低端设备 → 电池 → 解码失败 → 默认播。
import type { WallpaperPowerSaver } from "@/types";

export interface WallpaperVideoPolicy {
  mode: "video" | "poster";
  reason: string;
}

export interface WallpaperVideoPolicyEnvironment {
  prefersReducedMotion?: boolean;
  hardwareConcurrency?: number;
  /** navigator.deviceMemory（GB；部分平台缺省 undefined，不作为降级依据） */
  deviceMemory?: number;
  battery?: { discharging: boolean; level: number } | null;
  /** 视频 onerror / codec 不支持（运行时反馈，重算时注入） */
  decodeFailed?: boolean;
}

export function decideWallpaperVideoPolicy(
  powerSaver: WallpaperPowerSaver,
  env: WallpaperVideoPolicyEnvironment = {},
): WallpaperVideoPolicy {
  if (powerSaver === "never") {
    return { mode: "video", reason: "user-force-video" };
  }
  if (powerSaver === "always") {
    // 表外补充：用户显式选「总是省电」即恒 poster
    return { mode: "poster", reason: "user-power-saver" };
  }
  if (env.prefersReducedMotion) {
    return { mode: "poster", reason: "reduced-motion" };
  }
  if (
    (env.hardwareConcurrency !== undefined && env.hardwareConcurrency < 4) ||
    (env.deviceMemory !== undefined && env.deviceMemory < 4)
  ) {
    return { mode: "poster", reason: "low-end-device" };
  }
  if (env.battery && env.battery.discharging && env.battery.level < 0.3) {
    return { mode: "poster", reason: "battery-saver" };
  }
  if (env.decodeFailed) {
    return { mode: "poster", reason: "decode-failed" };
  }
  return { mode: "video", reason: "auto-video" };
}

interface BatteryManagerLike {
  charging: boolean;
  level: number;
}

/** 从真实运行时采集 env（getBattery 不可用/失败时置 null） */
export async function collectWallpaperVideoPolicyEnvironment(): Promise<WallpaperVideoPolicyEnvironment> {
  const env: WallpaperVideoPolicyEnvironment = {};
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    env.prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
  if (typeof navigator !== "undefined") {
    env.hardwareConcurrency = navigator.hardwareConcurrency;
    env.deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    const getBattery = (
      navigator as Navigator & { getBattery?: () => Promise<BatteryManagerLike> }
    ).getBattery;
    if (typeof getBattery === "function") {
      try {
        const battery = await getBattery.call(navigator);
        env.battery = { discharging: !battery.charging, level: battery.level };
      } catch {
        env.battery = null;
      }
    }
  }
  return env;
}
