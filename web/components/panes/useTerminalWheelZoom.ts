import { useEffect, useState, type RefObject } from "react";

import { normalizeTerminalFontSize } from "@/stores";

type TerminalWheelZoomHandler = (step: -1 | 1) => void;

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
): number {
  const [fontSize, setFontSize] = useState(() => normalizeTerminalFontSize(configuredFontSize));

  useEffect(() => {
    setFontSize(normalizeTerminalFontSize(configuredFontSize));
  }, [configuredFontSize]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    return attachTerminalWheelZoom(host, (step) => {
      setFontSize((current) => normalizeTerminalFontSize(current + step));
    });
  }, [hostRef]);

  return fontSize;
}
