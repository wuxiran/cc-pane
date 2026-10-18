import type { Event, UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";

export function listenCCChan<T>(name: string, handler: (event: Event<T>) => void, onReady?: () => void): UnlistenFn {
  if (typeof window === "undefined" || !window.__TAURI_INTERNALS__) return () => {};
  let disposed = false;
  let unlisten: UnlistenFn | undefined;
  try {
    void getCurrentWebview().listen<T>(name, (event) => {
      if (!disposed) handler(event);
    }).then((fn) => {
      if (disposed) fn();
      else { unlisten = fn; onReady?.(); }
    }).catch((error) => console.warn(`[ccchan] failed to listen ${name}:`, error));
  } catch (error) {
    console.warn(`[ccchan] failed to listen ${name}:`, error);
  }
  return () => { disposed = true; unlisten?.(); };
}
