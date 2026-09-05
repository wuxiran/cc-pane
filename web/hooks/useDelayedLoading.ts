import { useEffect, useState } from "react";

/** 默认延迟：加载在 300ms 内完成则不展示骨架，避免闪烁 */
export const SKELETON_DELAY_MS = 300;

/**
 * 延迟展示加载态（骨架屏专用）：
 * - `loading` 持续超过 `delay` 才返回 true，快加载不闪骨架；
 * - `loading` 一旦结束立即返回 false，不拖延真实内容呈现。
 */
export function useDelayedLoading(loading: boolean, delay: number = SKELETON_DELAY_MS): boolean {
  const [elapsed, setElapsed] = useState(false);

  useEffect(() => {
    if (!loading) {
      setElapsed(false);
      return;
    }
    const timer = window.setTimeout(() => setElapsed(true), delay);
    return () => window.clearTimeout(timer);
  }, [loading, delay]);

  // loading 翻 false 的当帧 effect 尚未清 elapsed，用 && loading 保证立即隐藏
  return elapsed && loading;
}
