/**
 * WebGL context 丢失后的有限重试（docs/107 P1）。
 *
 * 此前 renderer controller 一旦收到 context-loss 就永久钉在 DOM（直到用户切
 * renderer mode）。GPU 驱动重置 / 系统睡醒 / 多窗口抢 context 这类**瞬时**丢失
 * 其实很快就能恢复——这里允许 60 s 窗口内最多 3 次重试（1 s / 2 s / 4 s 退避），
 * 超过才视为硬件/驱动真有问题，钉 DOM。
 *
 * 纯计时逻辑，`retry` 回调由 controller 提供（清闩 + 重新 configure）。
 */

export const WEBGL_CONTEXT_LOSS_MAX_RETRIES = 3;
export const WEBGL_CONTEXT_LOSS_WINDOW_MS = 60_000;
export const WEBGL_CONTEXT_LOSS_RETRY_DELAY_MS = 1_000;

interface TerminalWebglContextLossRetryOptions {
  maxRetries?: number;
  windowMs?: number;
  retryDelayMs?: number;
  now?: () => number;
}

export interface TerminalWebglContextLossRetry {
  /**
   * 记一次丢失。返回 true = 已安排重试；false = 窗口内次数耗尽，钉 DOM
   * （调用方保持 context-loss 闩不动）。
   */
  recordLoss(): boolean;
  isPinned(): boolean;
  /** 窗口内已记录的丢失次数（诊断）。 */
  lossesInWindow(): number;
  dispose(): void;
}

export function createTerminalWebglContextLossRetry(
  retry: () => void,
  {
    maxRetries = WEBGL_CONTEXT_LOSS_MAX_RETRIES,
    windowMs = WEBGL_CONTEXT_LOSS_WINDOW_MS,
    retryDelayMs = WEBGL_CONTEXT_LOSS_RETRY_DELAY_MS,
    now = () => Date.now(),
  }: TerminalWebglContextLossRetryOptions = {},
): TerminalWebglContextLossRetry {
  let losses: number[] = [];
  let pinned = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const prune = () => {
    const cutoff = now() - windowMs;
    losses = losses.filter((at) => at > cutoff);
  };

  return {
    recordLoss(): boolean {
      if (disposed) return false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      prune();
      losses.push(now());
      // 不黏住：窗口滑过后再丢失照样给重试机会。
      pinned = losses.length > maxRetries;
      if (pinned) return false;
      const attempt = losses.length;
      timer = setTimeout(() => {
        timer = null;
        if (!disposed) retry();
      }, retryDelayMs * 2 ** (attempt - 1));
      return true;
    },
    isPinned: () => pinned,
    lossesInWindow: () => {
      prune();
      return losses.length;
    },
    dispose(): void {
      disposed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
