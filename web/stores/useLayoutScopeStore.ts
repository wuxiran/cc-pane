import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { LayoutSnapshotPayload } from "@/types";
import { DEFAULT_LAYOUT_SCOPE, type LayoutScope } from "@/utils/layoutScope";

export const LAYOUT_SCOPE_STORAGE_KEY = "cc-panes-layout-scopes";
export { DEFAULT_LAYOUT_SCOPE };

export interface LayoutScopeState {
  scopes: Record<string, LayoutSnapshotPayload>;
  activeScope: LayoutScope;
  saveScope: (scope: LayoutScope, payload: LayoutSnapshotPayload) => void;
  getScope: (scope: LayoutScope) => LayoutSnapshotPayload | undefined;
  setActiveScope: (scope: LayoutScope) => void;
  reset: () => void;
  resetForTest: () => void;
}

function clonePayload(payload: LayoutSnapshotPayload): LayoutSnapshotPayload {
  return structuredClone(payload);
}

const initialState = {
  scopes: {} as Record<string, LayoutSnapshotPayload>,
  activeScope: DEFAULT_LAYOUT_SCOPE,
};

export const selectActiveScope = (state: LayoutScopeState): LayoutScope => state.activeScope;

export function getActiveLayoutScope(): LayoutScope {
  return useLayoutScopeStore.getState().activeScope;
}

export const useLayoutScopeStore = create<LayoutScopeState>()(
  persist(
    (set, get) => ({
      ...initialState,
      saveScope: (scope, payload) => set((state) => ({
        scopes: { ...state.scopes, [scope]: clonePayload(payload) },
      })),
      getScope: (scope) => {
        const payload = get().scopes[scope];
        return payload ? clonePayload(payload) : undefined;
      },
      setActiveScope: (activeScope) => set({ activeScope }),
      reset: () => set({
        scopes: {},
        activeScope: DEFAULT_LAYOUT_SCOPE,
      }),
      resetForTest: () => set({
        scopes: {},
        activeScope: DEFAULT_LAYOUT_SCOPE,
      }),
    }),
    {
      name: LAYOUT_SCOPE_STORAGE_KEY,
      version: 2,
      migrate: (persistedState) => {
        const persisted = persistedState as Partial<LayoutScopeState>;
        const defaultPayload = persisted.scopes?.[DEFAULT_LAYOUT_SCOPE];
        return {
          ...initialState,
          scopes: defaultPayload
            ? { [DEFAULT_LAYOUT_SCOPE]: clonePayload(defaultPayload) }
            : {},
          activeScope: DEFAULT_LAYOUT_SCOPE,
        };
      },
      partialize: (state) => ({
        scopes: state.scopes,
        activeScope: state.activeScope,
      }),
    },
  ),
);
