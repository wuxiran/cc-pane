import type { RateLimitSnapshot, RateLimitWindow } from "@/types/rateLimit";

const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;
const DAY_MINUTES = 24 * HOUR_MINUTES;

export const RATE_LIMIT_WARNING_PERCENT = 75;
export const RATE_LIMIT_DANGER_PERCENT = 90;

export type RateLimitSeverity = "normal" | "warning" | "danger";

/** 窗口长度的紧凑写法：300 → 5h，10080 → 7d；不知道长度时返回 null。 */
export function formatWindowLength(minutes: number | null): string | null {
  if (!minutes || minutes <= 0) return null;
  if (minutes % DAY_MINUTES === 0) return `${minutes / DAY_MINUTES}d`;
  if (minutes % HOUR_MINUTES === 0) return `${minutes / HOUR_MINUTES}h`;
  return `${minutes}m`;
}

/** 距重置的紧凑时长：2d3h / 3h12m / 12m / <1m。 */
export function formatDuration(ms: number): string {
  if (ms < MINUTE_MS) return "<1m";
  const totalMinutes = Math.floor(ms / MINUTE_MS);
  const days = Math.floor(totalMinutes / DAY_MINUTES);
  const hours = Math.floor((totalMinutes % DAY_MINUTES) / HOUR_MINUTES);
  const minutes = totalMinutes % HOUR_MINUTES;
  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/**
 * 还有效的窗口。重置时间已过的窗口里那个百分比属于上一个周期，显示出来就是错的数，
 * 所以直接丢掉（与 Claude Code statusline 的 rate_limits 同一口径）。
 */
export function activeRateLimitWindows(
  snapshot: RateLimitSnapshot | null | undefined,
  now: number,
): RateLimitWindow[] {
  if (!snapshot) return [];
  return snapshot.windows.filter((window) => window.resetsAt === null || window.resetsAt > now);
}

export function rateLimitSeverity(usedPercent: number, limitReached = false): RateLimitSeverity {
  if (limitReached || usedPercent >= RATE_LIMIT_DANGER_PERCENT) return "danger";
  if (usedPercent >= RATE_LIMIT_WARNING_PERCENT) return "warning";
  return "normal";
}

export function formatPercent(usedPercent: number): string {
  return `${Math.round(usedPercent)}%`;
}

/** 用得最多的窗口——状态栏只给它配重置倒计时。 */
export function mostConstrainedWindow(windows: RateLimitWindow[]): RateLimitWindow | null {
  return windows.reduce<RateLimitWindow | null>(
    (worst, window) => (worst === null || window.usedPercent > worst.usedPercent ? window : worst),
    null,
  );
}
