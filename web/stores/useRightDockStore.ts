import { create } from "zustand";
import { persist } from "zustand/middleware";

export type RightDockView = "git" | "files";

export const RIGHT_DOCK_STORAGE_KEY = "cc-panes-right-dock";
export const DEFAULT_RIGHT_DOCK_WIDTH = 340;
export const MIN_RIGHT_DOCK_WIDTH = 280;
export const MAX_RIGHT_DOCK_WIDTH = 560;

export function clampRightDockWidth(width: number): number {
  return Math.min(MAX_RIGHT_DOCK_WIDTH, Math.max(MIN_RIGHT_DOCK_WIDTH, width));
}

interface RightDockState {
  visible: boolean;
  activeView: RightDockView;
  width: number;
  toggleView: (view: RightDockView) => void;
  setWidth: (width: number) => void;
  setVisible: (visible: boolean) => void;
}

export const useRightDockStore = create<RightDockState>()(
  persist(
    (set) => ({
      visible: false,
      activeView: "git",
      width: DEFAULT_RIGHT_DOCK_WIDTH,
      toggleView: (view) =>
        set((state) => ({
          activeView: view,
          visible: state.activeView === view ? !state.visible : true,
        })),
      setWidth: (width) => set({ width: clampRightDockWidth(width) }),
      setVisible: (visible) => set({ visible }),
    }),
    {
      name: RIGHT_DOCK_STORAGE_KEY,
      partialize: (state) => ({
        visible: state.visible,
        width: state.width,
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<RightDockState>;
        return {
          ...currentState,
          visible: typeof persisted.visible === "boolean" ? persisted.visible : currentState.visible,
          width: typeof persisted.width === "number"
            ? clampRightDockWidth(persisted.width)
            : currentState.width,
        };
      },
    },
  ),
);
