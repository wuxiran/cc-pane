import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toastErr } from "@/lib/feedback";
import { getErrorMessage } from "@/utils";

export type WindowMode = "collapsed" | "bubble" | "menu" | "chat";
export function useCCChanWindowMode(mode: WindowMode, petSize: number, paused: boolean) {
  const queue = useRef(Promise.resolve());
  const [size, setSize] = useState<{ width: number; height: number; mode: WindowMode } | null>(null);
  useEffect(() => {
    if (paused) return;
    let cancelled = false;
    queue.current = queue.current.then(async () => {
      if (cancelled) return;
      const next = await invoke<{ width: number; height: number }>("set_ccchan_window_mode", { mode });
      if (!cancelled && next) setSize({ ...next, mode });
    }).catch((error) => { if (!cancelled) toastErr(getErrorMessage(error)); });
    return () => { cancelled = true; };
  }, [mode, petSize, paused]);
  return size?.mode === mode ? size : null;
}
