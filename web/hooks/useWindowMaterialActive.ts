// 系统窗口材质（macOS vibrancy / Windows Mica）是否已生效。
// useSystemAppearance 在确认原生材质挂上后给 <html> 写 data-material="on"；这里订阅这个属性，
// 让主内容区也能跟着变成半透明磨砂（外壳那几块由 index.css 直接按属性处理）。
import { useSyncExternalStore } from "react";

function read(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.material === "on";
}

function subscribe(onChange: () => void): () => void {
  if (typeof MutationObserver === "undefined" || typeof document === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-material"] });
  return () => observer.disconnect();
}

export function useWindowMaterialActive(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
