/**
 * 后台标签的分层降档定时器（docs/71 §3 低配机防护，docs/107 P1 停泊）。
 *
 * 可见 → 隐藏后：
 *   T+tier1Delay（1 s）：Tier1（挂起 WebGL renderer；无 WebGL/透明模式时为 no-op）
 *   T+parkDelay（30 s，设置可调）：Park（停泊：不序列化，直接 dispose xterm，唤醒走后端 snapshot）
 *   T+tier2Delay（30 min）：Tier2（休眠：序列化整个终端并释放 xterm 实例）
 * 隐藏 → 可见时按已触发的最高档回滚（Tier2 > Park > Tier1——实例已不存在时 Tier1 无意义）。
 *
 * `notifyVisibility` 会在每次 render 被调用（TerminalView 的无依赖同步 effect），
 * 必须对重复的同值调用完全幂等。React 19 dev 双挂载由调用方在 cleanup 中 `dispose()` 容忍。
 */

export interface TerminalBackgroundLifecycle {
  /** 汇报当前可见性。幂等，可高频调用。 */
  notifyVisibility(visible: boolean): void;
  /** 是否处于隐藏计时/已降档状态（诊断用）。 */
  isBackgrounded(): boolean;
  dispose(): void;
}

export const BACKGROUND_TIER1_DELAY_MS = 1_000;
export const BACKGROUND_PARK_DELAY_MS = 30_000;
export const BACKGROUND_TIER2_DELAY_MS = 30 * 60_000;

interface CreateTerminalBackgroundLifecycleOptions {
  onTier1: () => void;
  onTier1Restore: () => void;
  onTier2: () => void;
  onTier2Restore: () => void;
  /** 停泊层可选：不传则退化为原两档。 */
  onPark?: () => boolean | void;
  onParkRestore?: () => void;
  tier1DelayMs?: number;
  parkDelayMs?: number;
  parkRetryMs?: number;
  tier2DelayMs?: number;
}

type Timer = ReturnType<typeof setTimeout> | null;

export function createTerminalBackgroundLifecycle({
  onTier1,
  onTier1Restore,
  onTier2,
  onTier2Restore,
  onPark,
  onParkRestore,
  tier1DelayMs = BACKGROUND_TIER1_DELAY_MS,
  parkDelayMs = BACKGROUND_PARK_DELAY_MS,
  parkRetryMs = 5_000,
  tier2DelayMs = BACKGROUND_TIER2_DELAY_MS,
}: CreateTerminalBackgroundLifecycleOptions): TerminalBackgroundLifecycle {
  let hidden = false;
  let tier1Fired = false;
  let parkFired = false;
  let tier2Fired = false;
  let tier1Timer: Timer = null;
  let parkTimer: Timer = null;
  let tier2Timer: Timer = null;
  let disposed = false;

  const clearTimers = () => {
    if (tier1Timer !== null) clearTimeout(tier1Timer);
    if (parkTimer !== null) clearTimeout(parkTimer);
    if (tier2Timer !== null) clearTimeout(tier2Timer);
    tier1Timer = parkTimer = tier2Timer = null;
  };

  const tryPark = () => {
    parkTimer = null;
    if (disposed || !hidden) return;
    const parked = onPark?.();
    if (parked === false) {
      parkTimer = setTimeout(tryPark, Math.max(1_000, parkRetryMs));
    } else {
      parkFired = true;
    }
  };

  return {
    notifyVisibility(visible: boolean): void {
      if (disposed) return;
      if (!visible) {
        if (hidden) return;
        hidden = true;
        tier1Timer = setTimeout(() => {
          tier1Timer = null;
          tier1Fired = true;
          onTier1();
        }, tier1DelayMs);
        if (onPark) {
          parkTimer = setTimeout(tryPark, parkDelayMs);
        }
        tier2Timer = setTimeout(() => {
          tier2Timer = null;
          tier2Fired = true;
          onTier2();
        }, tier2DelayMs);
        return;
      }

      if (!hidden) return;
      hidden = false;
      clearTimers();
      const wasTier1 = tier1Fired;
      const wasPark = parkFired;
      const wasTier2 = tier2Fired;
      tier1Fired = parkFired = tier2Fired = false;
      // 高档覆盖低档：休眠/停泊后实例已销毁，restore 只需走唤醒。
      if (wasTier2) {
        onTier2Restore();
        return;
      }
      if (wasPark) {
        onParkRestore?.();
        return;
      }
      if (wasTier1) {
        onTier1Restore();
      }
    },

    isBackgrounded: () => hidden,

    dispose(): void {
      disposed = true;
      clearTimers();
    },
  };
}
