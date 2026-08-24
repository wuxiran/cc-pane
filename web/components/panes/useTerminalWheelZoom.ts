import { useEffect, useRef, useState, type RefObject } from "react";

import { normalizeTerminalFontSize } from "@/stores";

type TerminalWheelZoomHandler = (step: -1 | 1) => void;

export interface TerminalWheelZoomOptions {
  /**
   * Optional first-use size for a separate terminal surface. Normal terminals
   * leave this unset and start from the configured application font size.
   */
  initialFontSize?: number;
  /**
   * Stable visual-surface identity. When supplied, Ctrl+wheel changes are
   * kept outside the global terminal setting and restored across remounts.
   */
  persistenceKey?: string;
}

const ZOOM_STORAGE_PREFIX = "cc-panes-terminal-zoom-v1:";

function storageKey(persistenceKey: string): string {
  return `${ZOOM_STORAGE_PREFIX}${encodeURIComponent(persistenceKey)}`;
}

function readPersistedFontSize(persistenceKey?: string): number | null {
  if (!persistenceKey || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(persistenceKey));
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? normalizeTerminalFontSize(value) : null;
  } catch {
    return null;
  }
}

function persistFontSize(persistenceKey: string | undefined, fontSize: number): void {
  if (!persistenceKey || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(persistenceKey), String(fontSize));
  } catch {
    // Restricted webviews may deny storage; the live terminal still zooms.
  }
}

export function attachTerminalWheelZoom(
  host: HTMLElement,
  onZoom: TerminalWheelZoomHandler,
): () => void {
  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey || event.deltaY === 0) return;

    event.preventDefault();
    event.stopPropagation();
    onZoom(event.deltaY < 0 ? 1 : -1);
  };

  host.addEventListener("wheel", onWheel, { capture: true, passive: false });
  return () => host.removeEventListener("wheel", onWheel, { capture: true });
}

/** Capture Ctrl+wheel before xterm can translate the wheel into arrow keys. */
export function useTerminalWheelZoom(
  hostRef: RefObject<HTMLElement | null>,
  configuredFontSize: number,
  options: TerminalWheelZoomOptions = {},
): number {
  const initialFontSize = options.initialFontSize ?? configuredFontSize;
  const persistenceKey = options.persistenceKey;
  const persistenceKeyRef = useRef(persistenceKey);
  persistenceKeyRef.current = persistenceKey;
  const [fontSize, setFontSize] = useState(() =>
    readPersistedFontSize(persistenceKey) ?? normalizeTerminalFontSize(initialFontSize),
  );

  useEffect(() => {
    const restored = readPersistedFontSize(persistenceKey);
    setFontSize(restored ?? normalizeTerminalFontSize(initialFontSize));
  }, [configuredFontSize, initialFontSize, persistenceKey]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    return attachTerminalWheelZoom(host, (step) => {
      setFontSize((current) => {
        const next = normalizeTerminalFontSize(current + step);
        persistFontSize(persistenceKeyRef.current, next);
        return next;
      });
    });
  }, [hostRef]);

  return fontSize;
}
