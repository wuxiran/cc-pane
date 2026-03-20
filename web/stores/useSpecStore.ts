import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { SpecEntry, SpecStatus } from "@/types/spec";
import { specService } from "@/services/specService";

interface SpecState {
  specs: SpecEntry[];
  loading: boolean;
  selectedSpec: SpecEntry | null;

  // Actions
  loadSpecs: (projectPath: string, status?: SpecStatus) => Promise<void>;
  createSpec: (
    projectPath: string,
    title: string,
    tasks?: string[]
  ) => Promise<SpecEntry>;
  updateSpec: (
    specId: string,
    request: { title?: string; status?: SpecStatus }
  ) => Promise<void>;
  deleteSpec: (projectPath: string, specId: string) => Promise<void>;
  syncTasks: (projectPath: string, specId: string) => Promise<void>;
  select: (spec: SpecEntry | null) => void;
  reset: () => void;
}

const INITIAL_STATE = {
  specs: [] as SpecEntry[],
  loading: false,
  selectedSpec: null as SpecEntry | null,
};

export const useSpecStore = create<SpecState>()(
  immer((set, get) => ({
    ...INITIAL_STATE,

    loadSpecs: async (projectPath, status) => {
      set((state) => {
        state.loading = true;
      });
      try {
        const specs = await specService.list(projectPath, status);
        set((state) => {
          state.specs = specs;
          state.loading = false;
        });
      } catch {
        set((state) => {
          state.loading = false;
        });
      }
    },

    createSpec: async (projectPath, title, tasks) => {
      const spec = await specService.create({ projectPath, title, tasks });
      await get().loadSpecs(projectPath);
      return spec;
    },

    updateSpec: async (specId, request) => {
      const updated = await specService.update(specId, request);
      set((state) => {
        const idx = state.specs.findIndex((s) => s.id === specId);
        if (idx !== -1) {
          state.specs[idx] = updated;
        }
        if (state.selectedSpec?.id === specId) {
          state.selectedSpec = updated;
        }
      });
    },

    deleteSpec: async (projectPath, specId) => {
      await specService.delete(projectPath, specId);
      set((state) => {
        state.specs = state.specs.filter((s) => s.id !== specId);
        if (state.selectedSpec?.id === specId) {
          state.selectedSpec = null;
        }
      });
    },

    syncTasks: async (projectPath, specId) => {
      await specService.syncTasks(projectPath, specId);
    },

    select: (spec) =>
      set((state) => {
        state.selectedSpec = spec;
      }),

    reset: () =>
      set((state) => {
        Object.assign(state, INITIAL_STATE);
      }),
  }))
);
