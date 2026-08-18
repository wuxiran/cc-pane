/**
 * 后台标签的分层降档定时器（docs/71 §3 低配机防护）。
 *
 * 可见 → 隐藏后：
 *   T+tier1Delay：Tier1（挂起 WebGL renderer；无 WebGL/透明模式时为 no-op）
 *   T+tier2Delay：Tier2（休眠：序列化整个终端并释放 xterm 实例）
 * 隐藏 → 可见时按已触发的最高档回滚（Tier2 优先——实例已不存在，Tier1 无意义）。
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

export const BACKGROUND_TIER1_DELAY_MS = 5 * 60_000;
export const BACKGROUND_TIER2_DELAY_MS = 30 * 60_000;

interface CreateTerminalBackgroundLifecycleOptions {
  onTier1: () => void;
  onTier1Restore: () => void;
  onTier2: () => void;
  onTier2Restore: () => void;
  tier1DelayMs?: number;
  tier2DelayMs?: number;
}

export function createTerminalBackgroundLifecycle({
  onTier1,
  onTier1Restore,
  onTier2,
  onTier2Restore,
  tier1DelayMs = BACKGROUND_TIER1_DELAY_MS,
  tier2DelayMs = BACKGROUND_TIER2_DELAY_MS,
}: CreateTerminalBackgroundLifecycleOptions): TerminalBackgroundLifecycle {
  let hidden = false;
  let tier1Fired = false;
  let tier2Fired = false;
  let tier1Timer: ReturnType<typeof setTimeout> | null = null;
  let tier2Timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clearTimers = () => {
    if (tier1Timer !== null) {
      clearTimeout(tier1Timer);
      tier1Timer = null;
    }
    if (tier2Timer !== null) {
      clearTimeout(tier2Timer);
      tier2Timer = null;
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
      const wasTier2 = tier2Fired;
      tier1Fired = false;
      tier2Fired = false;
      // Tier2 覆盖 Tier1：休眠后实例已销毁，restore 只需走唤醒。
      if (wasTier2) {
        onTier2Restore();
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
