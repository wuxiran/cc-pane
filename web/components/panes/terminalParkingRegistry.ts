/**
 * 停泊注册表（docs/107 P1）：统计「隐藏但仍持有 xterm 实例」的终端，
 * 超过上限时按最早隐藏者（LRU）逐出——调用其 `park` 回调立即停泊，
 * 不等 30 s 的停泊定时器。
 *
 * 纯逻辑，无 React / store 依赖；单例与设置读取在 `terminalParking.ts`。
 * `notifyHidden` 每次 render 都可能被调用，对已登记的 owner 幂等（不刷新 hiddenAt）。
 */

export interface TerminalParkingRegistry {
  /** owner 进入隐藏且仍活着；`park` 返回 true 表示已不再持有 xterm。 */
  notifyHidden(owner: object, park: () => boolean): void;
  /** owner 变可见（或卸载）：退出隐藏集合。 */
  notifyVisible(owner: object): void;
  /** owner 已由定时器/休眠路径停泊：退出隐藏集合但不再调 park。 */
  notifyParked(owner: object): void;
  /** 改上限；缩小时立即按 LRU 逐出到上限以内。 */
  setLimit(limit: number): void;
  hiddenCount(): number;
  /** 诊断用：按隐藏先后排序的 owner 列表。 */
  hiddenOwners(): object[];
}

interface HiddenEntry {
  park: () => boolean;
  hiddenAt: number;
  seq: number;
}

interface CreateTerminalParkingRegistryOptions {
  /** 常量或惰性读取（随设置变化）。 */
  limit: number | (() => number);
  now?: () => number;
}

export function createTerminalParkingRegistry({
  limit,
  now = () => Date.now(),
}: CreateTerminalParkingRegistryOptions): TerminalParkingRegistry {
  const hidden = new Map<object, HiddenEntry>();
  let seq = 0;
  let limitOverride: number | null = null;
  let evicting = false;

  const currentLimit = () => {
    const raw = limitOverride ?? (typeof limit === "function" ? limit() : limit);
    return Math.max(1, Math.floor(raw));
  };

  const sortedEntries = () =>
    [...hidden].sort((a, b) => a[1].hiddenAt - b[1].hiddenAt || a[1].seq - b[1].seq);

  /** 逐出到上限以内。park 失败（输入豁免 / 重连中）的 owner 挪到 LRU 末尾，下轮再试。 */
  const evictToLimit = () => {
    if (evicting) return;
    evicting = true;
    try {
      const max = currentLimit();
      if (hidden.size <= max) return;
      for (const [owner, entry] of sortedEntries()) {
        if (hidden.size <= max) break;
        if (!hidden.has(owner)) continue;
        let parked = false;
        try {
          parked = entry.park();
        } catch {
          parked = false;
        }
        if (parked) {
          hidden.delete(owner);
        } else {
          entry.hiddenAt = now();
          entry.seq = ++seq;
        }
      }
    } finally {
      evicting = false;
    }
  };

  return {
    notifyHidden(owner, park) {
      const existing = hidden.get(owner);
      if (existing) {
        existing.park = park;
        return;
      }
      hidden.set(owner, { park, hiddenAt: now(), seq: ++seq });
      evictToLimit();
    },
    notifyVisible(owner) {
      hidden.delete(owner);
    },
    notifyParked(owner) {
      hidden.delete(owner);
    },
    setLimit(next) {
      limitOverride = Number.isFinite(next) ? next : null;
      evictToLimit();
    },
    hiddenCount: () => hidden.size,
    hiddenOwners: () => sortedEntries().map(([owner]) => owner),
  };
}
