import { useEffect, type RefObject } from "react";

import { TERMINAL_FONT_SIZE_DEFAULT, useSettingsStore } from "@/stores";

export function attachTerminalWheelZoom(host: HTMLElement): () => void {
  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey || event.deltaY === 0) return;

    event.preventDefault();
    event.stopPropagation();

    const settings = useSettingsStore.getState();
    const current = settings.settings?.terminal.fontSize ?? TERMINAL_FONT_SIZE_DEFAULT;
    settings.setTerminalFontSize(current + (event.deltaY < 0 ? 1 : -1));
  };

  host.addEventListener("wheel", onWheel, { capture: true, passive: false });
  return () => host.removeEventListener("wheel", onWheel, { capture: true });
}

/** Capture Ctrl+wheel before xterm can translate the wheel into arrow keys. */
export function useTerminalWheelZoom(hostRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    return attachTerminalWheelZoom(host);
  }, [hostRef]);
}
