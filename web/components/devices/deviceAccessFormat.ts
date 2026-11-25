// 「已授权的客户端」列表的纯展示逻辑：在线判定、相对时间、浏览器摘要、有效期选项。

/** 这个时间窗内有过访问即视为「在线」。后端活跃度每分钟至多记录一次，窗口需大于 1 分钟。 */
export const ONLINE_WINDOW_MS = 2 * 60 * 1000;

export type LastSeen =
  | { kind: "online" }
  | { kind: "minutes" | "hours" | "days"; count: number }
  | { kind: "never" };

export function describeLastSeen(lastSeenAt: string | null | undefined, now: number = Date.now()): LastSeen {
  if (!lastSeenAt) return { kind: "never" };
  const at = new Date(lastSeenAt).getTime();
  if (Number.isNaN(at)) return { kind: "never" };
  const elapsed = Math.max(0, now - at);
  if (elapsed <= ONLINE_WINDOW_MS) return { kind: "online" };
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return { kind: "minutes", count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { kind: "hours", count: hours };
  return { kind: "days", count: Math.floor(hours / 24) };
}

/** User-Agent → 「浏览器 · 系统」短摘要；识别不了返回 null（界面显示「未知浏览器」）。 */
export function summarizeUserAgent(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  const browser = [
    ["Edg/", "Edge"],
    ["OPR/", "Opera"],
    ["Firefox/", "Firefox"],
    ["Chrome/", "Chrome"],
    ["CriOS/", "Chrome"],
    ["Safari/", "Safari"],
  ].find(([marker]) => userAgent.includes(marker))?.[1];
  const os = [
    ["iPhone", "iOS"],
    ["iPad", "iPadOS"],
    ["Android", "Android"],
    ["Windows", "Windows"],
    ["Mac OS X", "macOS"],
    ["Linux", "Linux"],
  ].find(([marker]) => userAgent.includes(marker))?.[1];
  const parts = [browser, os].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** 配对时可选的令牌有效期（天）；0 = 永不过期。 */
export const PAIRING_TTL_OPTIONS = [30, 90, 0] as const;
export type PairingTtl = (typeof PAIRING_TTL_OPTIONS)[number];
export const DEFAULT_PAIRING_TTL: PairingTtl = 90;
