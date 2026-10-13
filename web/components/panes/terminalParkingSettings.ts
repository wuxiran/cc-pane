// 停泊参数的唯一读取口（docs/107 P1）。设置模型里 `settings.performance.*`
// 由 W1 另行落地；这里用可选访问 + 默认值兜底，W1 接线时只需删掉类型兜底。
import { useSettingsStore } from "@/stores";

export const DEFAULT_PARKED_TERMINAL_LIMIT = 6;
export const DEFAULT_PARK_DELAY_SECS = 30;
const PARKED_LIMIT_RANGE = [2, 12] as const;
const PARK_DELAY_RANGE_SECS = [5, 600] as const;

interface PerformanceParkingSettings {
  parkedTerminalLimit?: number;
  parkDelaySecs?: number;
}

function readPerformanceSettings(): PerformanceParkingSettings | undefined {
  const settings = useSettingsStore.getState().settings as
    | ({ performance?: PerformanceParkingSettings } & object)
    | null;
  return settings?.performance;
}

function clampInt(value: unknown, fallback: number, [min, max]: readonly [number, number]): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** 隐藏且仍持有 xterm 实例的终端上限；超出按最早隐藏者停泊。 */
export function getParkedTerminalLimit(): number {
  return clampInt(
    readPerformanceSettings()?.parkedTerminalLimit,
    DEFAULT_PARKED_TERMINAL_LIMIT,
    PARKED_LIMIT_RANGE,
  );
}

/** 隐藏后多久停泊（Tier1 挂 WebGL 之后、Tier2 休眠之前）。 */
export function getParkDelayMs(): number {
  return clampInt(
    readPerformanceSettings()?.parkDelaySecs,
    DEFAULT_PARK_DELAY_SECS,
    PARK_DELAY_RANGE_SECS,
  ) * 1000;
}
