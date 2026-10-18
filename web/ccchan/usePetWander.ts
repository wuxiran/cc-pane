import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import type { CCChanPetState } from "./types";
const INITIAL_WANDER_AFTER_MS = 4_000;
const WANDER_REPEAT_MIN_MS = 8_000;
const WANDER_REPEAT_MAX_MS = 18_000;
const WANDER_SPEED_PX_PER_SEC = 110;
const WANDER_STEP_MS = 120;
const WANDER_EDGE_PAD = 40;
const WANDER_MIN_DISTANCE = 160;
export function usePetWander(enabled: boolean, paused: boolean, petSize: number, setEggState: (state: CCChanPetState | null) => void) {
  useEffect(() => {
    if (!enabled || paused) {
      setEggState(null);
      return;
    }

    let cancelled = false;
    let nextTimer: ReturnType<typeof setTimeout> | null = null;
    let stepTimer: ReturnType<typeof setTimeout> | null = null;

    function clearTimers() {
      if (nextTimer) clearTimeout(nextTimer);
      if (stepTimer) clearTimeout(stepTimer);
      nextTimer = null;
      stepTimer = null;
    }

    function scheduleNext() {
      if (cancelled) return;
      const next = WANDER_REPEAT_MIN_MS + Math.random() * (WANDER_REPEAT_MAX_MS - WANDER_REPEAT_MIN_MS);
      nextTimer = setTimeout(wander, next);
    }

    async function wander() {
      if (cancelled) {
        scheduleNext();
        return;
      }
      try {
        const win = getCurrentWindow();
        const monitor = await currentMonitor();
        const physicalPos = await win.outerPosition();
        const scale = await win.scaleFactor();
        if (cancelled) return;
        const startX = physicalPos.x / scale;
        const startY = physicalPos.y / scale;
        if (!monitor) {
          scheduleNext();
          return;
        }
        const mScale = monitor.scaleFactor;
        const mx = monitor.position.x / mScale;
        const my = monitor.position.y / mScale;
        const mw = monitor.size.width / mScale;
        const mh = monitor.size.height / mScale;
        let targetX = startX;
        let targetY = startY;
        let dist = 0;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          targetX = mx + WANDER_EDGE_PAD + Math.random() * Math.max(1, mw - WANDER_EDGE_PAD * 2 - petSize);
          targetY = my + WANDER_EDGE_PAD + Math.random() * Math.max(1, mh - WANDER_EDGE_PAD * 2 - petSize);
          dist = Math.hypot(targetX - startX, targetY - startY);
          if (dist >= WANDER_MIN_DISTANCE) break;
        }
        const dx = targetX - startX;
        const dy = targetY - startY;
        if (dist < 30) {
          scheduleNext();
          return;
        }
        const duration = Math.min(12_000, Math.max(1_600, (dist / WANDER_SPEED_PX_PER_SEC) * 1000));
        const startTime = performance.now();
        setEggState("walking");

        const stepOnce = async () => {
          if (cancelled) return;
          const elapsed = performance.now() - startTime;
          const t = Math.min(1, elapsed / duration);
          const nx = startX + dx * t;
          const ny = startY + dy * t;
          const done = t >= 1;
          try { await invoke("move_ccchan_window", { x: nx, y: ny, persist: done }); }
          catch (error) { console.warn("[ccchan] wander failed:", error); if (!cancelled) { setEggState(null); scheduleNext(); } return; }
          if (done || cancelled) {
            setEggState(null);
            scheduleNext();
            return;
          }
          stepTimer = setTimeout(stepOnce, WANDER_STEP_MS);
        };
        stepOnce();
      } catch (error) {
        if (cancelled) return;
        console.warn("[ccchan] wander failed:", error);
        setEggState(null);
        scheduleNext();
      }
    }

    nextTimer = setTimeout(wander, INITIAL_WANDER_AFTER_MS);
    return () => {
      // cancelled 同时挡住在途的 stepOnce（开关中途关闭时立即停止移动）。
      cancelled = true;
      clearTimers();
      setEggState(null);
    };
  }, [enabled, paused, petSize, setEggState]);

}
