import { create } from "zustand";
import type { CanvasDisplayMode } from "@/types/canvas";
import { notifyTerminalLayoutChanged } from "@/lib/paneTree";

export type CanvasAnimationIntensity = "off" | "reduced" | "full";

interface CanvasDisplayState {
  mode: CanvasDisplayMode;
  animationIntensity: CanvasAnimationIntensity;
  setMode: (mode: CanvasDisplayMode) => void;
  setAnimationIntensity: (intensity: CanvasAnimationIntensity) => void;
}

export const useCanvasDisplayStore = create<CanvasDisplayState>((set, get) => ({
  mode: "panel",
  animationIntensity: "full",
  setMode: (mode) => {
    if (get().mode === mode) return;
    set({ mode });
    // The terminal surface is kept mounted and only changes display state.
    // Give xterm a post-commit layout signal for both manual and snapshot changes.
    notifyTerminalLayoutChanged("canvas.mode");
  },
  setAnimationIntensity: (animationIntensity) => set({ animationIntensity }),
}));
