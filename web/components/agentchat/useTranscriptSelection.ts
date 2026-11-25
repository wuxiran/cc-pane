import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export interface TranscriptSelectionAnchor { text: string; top: number; left: number }

/** 当前文档选区若完整落在 transcript 内，返回其文本；否则空串。 */
export function readTranscriptSelection(root: HTMLElement | null): string {
  if (!root || typeof window.getSelection !== "function") return "";
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return "";
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return "";
  return selection.toString().trim() ? selection.toString() : "";
}

function anchorFor(root: HTMLElement, text: string): TranscriptSelectionAnchor {
  const host = root.parentElement ?? root;
  const range = window.getSelection()?.getRangeAt(0);
  const rect = range && typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
  const hostRect = host.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return { text, top: 8, left: hostRect.width / 2 || 120 };
  const above = rect.top - hostRect.top - 34;
  const top = above >= 4 ? above : rect.bottom - hostRect.top + 6;
  const center = rect.left - hostRect.left + rect.width / 2;
  const left = Math.min(Math.max(center, 90), Math.max(90, hostRect.width - 90));
  return { text, top, left };
}

/**
 * 跟踪 Agent Chat transcript 里的文本选区：
 * - anchor：鼠标/键盘选完后在选区附近浮出「交给 Codex 桌面」用的位置；
 * - captureForMenu：「…」菜单打开会抢焦点，按下菜单触发器那一刻先快照选区。
 */
export function useTranscriptSelection(scrollRef: RefObject<HTMLElement | null>, enabled: boolean) {
  const [anchor, setAnchor] = useState<TranscriptSelectionAnchor | null>(null);
  const menuSnapshot = useRef("");

  useEffect(() => {
    const refresh = () => {
      const root = scrollRef.current;
      const text = enabled ? readTranscriptSelection(root) : "";
      setAnchor(text && root ? anchorFor(root, text) : null);
    };
    // 选区在 mouseup 之后才定型，延一拍再读。
    const settle = () => window.setTimeout(refresh, 0);
    const onSelectionChange = () => {
      if (!readTranscriptSelection(scrollRef.current)) setAnchor(null);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[aria-haspopup="menu"]')) menuSnapshot.current = readTranscriptSelection(scrollRef.current);
      else if (!target?.closest('[role="menu"]')) menuSnapshot.current = "";
    };
    const onScroll = (event: Event) => {
      if (event.target === scrollRef.current) setAnchor(null);
    };
    document.addEventListener("mouseup", settle);
    document.addEventListener("keyup", settle);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mouseup", settle);
      document.removeEventListener("keyup", settle);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [scrollRef, enabled]);

  const captureForMenu = useCallback(
    () => readTranscriptSelection(scrollRef.current) || menuSnapshot.current,
    [scrollRef],
  );
  const dismiss = useCallback(() => setAnchor(null), []);
  return { anchor, captureForMenu, dismiss };
}
