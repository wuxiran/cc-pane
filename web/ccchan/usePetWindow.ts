// 宠物窗口的平台胶水：透明背景、首帧 ready、命中区域上报、后端悬停事件。
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { isTauriRuntime } from "@/services/runtime";
import { listenCCChan } from "./listen";
import type { HitRect } from "./petLayout";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("input, textarea, [contenteditable='true'], [contenteditable='']"));
}

/** 透明背景 + mac 禁原生长按菜单/选字 + 首帧后通知后端 show。 */
export function usePetWindowChrome(ready: boolean): void {
  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = "html, body, #root { background: transparent !important; margin: 0; padding: 0; overflow: hidden; }";
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  useEffect(() => {
    if (!IS_MAC) return;
    const prevent = (event: Event) => {
      if (!isEditableTarget(event.target)) event.preventDefault();
    };
    window.addEventListener("contextmenu", prevent, true);
    window.addEventListener("selectstart", prevent, true);
    return () => {
      window.removeEventListener("contextmenu", prevent, true);
      window.removeEventListener("selectstart", prevent, true);
    };
  }, []);

  // 首帧提交后通知后端 show（后端新建窗口时先隐藏，避免闪出不透明底色；3s 超时兜底）。
  // 用 setTimeout 而非 rAF：窗口尚未 show 时 WKWebView/WebView2 可能暂停 rAF。
  const sent = useRef(false);
  useEffect(() => {
    if (!ready || sent.current) return;
    const timer = setTimeout(() => {
      sent.current = true;
      invoke("ccchan_window_ready").catch((error) => console.warn("[ccchan] window ready:", error));
    }, 0);
    return () => clearTimeout(timer);
  }, [ready]);
}

/** 命中区域变化才上报；后端据此切换点击穿透。 */
export function useHitRegions(regions: HitRect[]): void {
  const key = JSON.stringify(regions);
  useEffect(() => {
    if (!isTauriRuntime()) return;
    invoke("set_ccchan_hit_regions", { regions: JSON.parse(key) as HitRect[] })
      .catch((error) => console.warn("[ccchan] hit regions:", error));
  }, [key]);
}

/**
 * 悬停：后端轮询全局光标判断（窗口失焦 / 已穿透时 DOM 收不到事件）；
 * 点击穿透降级时后端不发，退回 DOM 指针事件。离开有短暂延迟，避免控件条闪烁。
 */
export function usePetHover() {
  const [nativeHover, setNativeHover] = useState(false);
  const [domHover, setDomHover] = useState(false);
  const [hovered, setHovered] = useState(false);
  useEffect(() => listenCCChan<boolean>("ccchan:hover", ({ payload }) => setNativeHover(Boolean(payload))), []);
  const raw = nativeHover || domHover;
  useEffect(() => {
    if (raw) {
      setHovered(true);
      return;
    }
    const timer = setTimeout(() => setHovered(false), 350);
    return () => clearTimeout(timer);
  }, [raw]);
  return {
    hovered,
    onPointerEnter: () => setDomHover(true),
    onPointerLeave: () => setDomHover(false),
  };
}
