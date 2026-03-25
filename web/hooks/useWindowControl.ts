import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriReady, handleErrorSilent } from "@/utils";

export function useWindowControl() {
  const [isPinned, setIsPinned] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!isTauriReady()) return;
    const win = getCurrentWindow();
    win.isMaximized().then(setIsMaximized).catch((e) => handleErrorSilent(e, "check maximized"));
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const unlisten = win.onResized(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        win.isMaximized().then(setIsMaximized).catch((e) => handleErrorSilent(e, "check maximized"));
      }, 150);
    });
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      unlisten.then((fn) => fn());
    };
  }, []);

  const togglePin = useCallback(async () => {
    try {
      const result = await invoke<boolean>("toggle_always_on_top");
      setIsPinned(result);
    } catch (e) {
      handleErrorSilent(e, "toggle pin");
    }
  }, []);

  const closeWindow = useCallback(async () => {
    try {
      await invoke("close_window");
    } catch (e) {
      handleErrorSilent(e, "close window");
    }
  }, []);

  const minimizeWindow = useCallback(async () => {
    try {
      await invoke("minimize_window");
    } catch (e) {
      handleErrorSilent(e, "minimize window");
    }
  }, []);

  const maximizeWindow = useCallback(async () => {
    try {
      await invoke("maximize_window");
    } catch (e) {
      handleErrorSilent(e, "maximize window");
    }
  }, []);

  const startDrag = useCallback(() => {
    if (!isTauriReady()) return;
    getCurrentWindow().startDragging().catch((e) => handleErrorSilent(e, "start drag"));
  }, []);

  return { isPinned, isMaximized, togglePin, closeWindow, minimizeWindow, maximizeWindow, startDrag };
}
