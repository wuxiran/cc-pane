import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function useWindowControl() {
  const [isPinned, setIsPinned] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    win.isMaximized().then(setIsMaximized).catch(console.error);
    const unlisten = win.onResized(() => {
      win.isMaximized().then(setIsMaximized).catch(console.error);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  const togglePin = useCallback(async () => {
    try {
      const result = await invoke<boolean>("toggle_always_on_top");
      setIsPinned(result);
    } catch (e) {
      console.error("Failed to toggle pin:", e);
    }
  }, []);

  const closeWindow = useCallback(async () => {
    try {
      await invoke("close_window");
    } catch (e) {
      console.error("Failed to close window:", e);
    }
  }, []);

  const minimizeWindow = useCallback(async () => {
    try {
      await invoke("minimize_window");
    } catch (e) {
      console.error("Failed to minimize window:", e);
    }
  }, []);

  const maximizeWindow = useCallback(async () => {
    try {
      await invoke("maximize_window");
    } catch (e) {
      console.error("Failed to maximize window:", e);
    }
  }, []);

  const startDrag = useCallback(() => {
    getCurrentWindow().startDragging();
  }, []);

  return { isPinned, isMaximized, togglePin, closeWindow, minimizeWindow, maximizeWindow, startDrag };
}
