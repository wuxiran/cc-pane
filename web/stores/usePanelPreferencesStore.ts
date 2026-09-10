import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ResourceSortMode = "group" | "cpu" | "memory";
interface PanelPreferences {
  resourceWidth: number;
  layoutWidth: number;
  /** 布局列表高度上限；null = 自动（由列表内容撑开） */
  layoutHeight: number | null;
  resourceSort: ResourceSortMode;
  autoFitLayouts: string[];
  setResourceWidth: (width: number) => void;
  setLayoutWidth: (width: number) => void;
  setLayoutHeight: (height: number | null) => void;
  setResourceSort: (sort: ResourceSortMode) => void;
  setAutoFit: (layoutId: string, enabled: boolean) => void;
}
const clamp = (n: number, min: number, max: number, fallback: number) => Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
export const usePanelPreferencesStore = create<PanelPreferences>()(persist((set) => ({
  resourceWidth: 560, layoutWidth: 360, layoutHeight: null, resourceSort: "group", autoFitLayouts: [],
  setResourceWidth: value => set({ resourceWidth: clamp(value, 430, 960, 560) }),
  setLayoutWidth: value => set({ layoutWidth: clamp(value, 288, 720, 360) }),
  setLayoutHeight: value => set({ layoutHeight: value === null ? null : clamp(value, 160, 800, 320) }),
  setResourceSort: resourceSort => set({ resourceSort }),
  setAutoFit: (id, enabled) => set(s => ({ autoFitLayouts: enabled
    ? [...new Set([...s.autoFitLayouts, id])] : s.autoFitLayouts.filter(v => v !== id) })),
}), { name: "cc-panes-panel-preferences", merge: (saved, current) => {
  const s = (saved ?? {}) as Partial<PanelPreferences>;
  return { ...current, resourceWidth: clamp(s.resourceWidth ?? 560, 430, 960, 560),
    layoutWidth: clamp(s.layoutWidth ?? 360, 288, 720, 360),
    layoutHeight: s.layoutHeight === null ? null : (typeof s.layoutHeight === "number" ? clamp(s.layoutHeight, 160, 800, 320) : null),
    resourceSort: s.resourceSort === "cpu" || s.resourceSort === "memory" ? s.resourceSort : "group",
    autoFitLayouts: Array.isArray(s.autoFitLayouts) ? s.autoFitLayouts.filter(v => typeof v === "string") : [] };
} }));
