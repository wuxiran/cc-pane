import { useEffect, useRef } from "react";

/**
 * 只在页面可见时跑的 setInterval。
 *
 * 主窗口关到托盘或最小化后（Rust 侧会把 WebView2 设为不可见，见
 * `main_window_visibility.rs`），这些轮询照跑只会白白唤醒 CPU、打 IPC。
 * 隐藏即停；重新可见时若距上次执行已满一个周期，先补跑一次再恢复节拍，
 * 用户切回来看到的状态不会比平时更旧。
 *
 * 只给“晚一点也无妨”的刷新用：提醒、保存这类必须在后台发生的不要套。
 */
export function startVisibleInterval(callback: () => void, intervalMs: number): () => void {
  if (typeof document === "undefined") {
    const timer = setInterval(callback, intervalMs);
    return () => clearInterval(timer);
  }
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastRunAt = Date.now();
  const run = () => {
    lastRunAt = Date.now();
    callback();
  };
  const start = () => {
    if (timer !== null || document.visibilityState === "hidden") return;
    if (Date.now() - lastRunAt >= intervalMs) run();
    timer = setInterval(run, intervalMs);
  };
  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") stop();
    else start();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  start();
  return () => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    stop();
  };
}

/** `startVisibleInterval` 的 hook 版；callback 变化不会重置节拍。 */
export function useVisibleInterval(callback: () => void, intervalMs: number): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  useEffect(() => startVisibleInterval(() => callbackRef.current(), intervalMs), [intervalMs]);
}
