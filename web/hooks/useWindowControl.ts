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
    const unlisten = win.onResized(() => {
      win.isMaximized().then(setIsMaximized).catch((e) => handleErrorSilent(e, "check maximized"));
    });
    return () => { unlisten.then((fn) => fn()); };
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
    getCurrentWindow().startDragging();
  }, []);

  return { isPinned, isMaximized, togglePin, closeWindow, minimizeWindow, maximizeWindow, startDrag };
}
