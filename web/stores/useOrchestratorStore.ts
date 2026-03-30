import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { taskBindingService } from "@/services";
import type {
  TaskBinding,
  TaskBindingStatus,
  CreateTaskBindingRequest,
  UpdateTaskBindingRequest,
  TaskBindingQuery,
} from "@/types";

type FilterTab = "all" | "running" | "completed";

interface OrchestratorState {
  // 数据
  bindings: TaskBinding[];
  total: number;
  hasMore: boolean;
  loading: boolean;

  // 过滤
  filterTab: FilterTab;

  // Actions
  loadBindings: (query?: TaskBindingQuery) => Promise<void>;
  create: (request: CreateTaskBindingRequest) => Promise<TaskBinding>;
  update: (id: string, request: UpdateTaskBindingRequest) => Promise<TaskBinding>;
  remove: (id: string) => Promise<void>;
  setFilterTab: (tab: FilterTab) => void;

  // 通过 sessionId 更新状态（同步 hook 使用）
  updateBySessionId: (
    sessionId: string,
    updates: UpdateTaskBindingRequest
  ) => Promise<void>;
}

function filterTabToStatus(tab: FilterTab): TaskBindingStatus | undefined {
  switch (tab) {
    case "running":
      return "running";
    case "completed":
      return "completed";
    default:
      return undefined;
  }
}

export const useOrchestratorStore = create<OrchestratorState>()(
  immer((set, get) => ({
    bindings: [],
    total: 0,
    hasMore: false,
    loading: false,
    filterTab: "all",

    loadBindings: async (query?) => {
      set((state) => {
        state.loading = true;
      });
      try {
        const { filterTab } = get();
        const mergedQuery: TaskBindingQuery = {
          status: query?.status ?? filterTabToStatus(filterTab),
          projectPath: query?.projectPath,
          search: query?.search,
          limit: query?.limit ?? 50,
          offset: query?.offset ?? 0,
        };
        const result = await taskBindingService.query(mergedQuery);
        set((state) => {
          state.bindings = result.items;
          state.total = result.total;
          state.hasMore = result.hasMore;
          state.loading = false;
        });
      } catch (error) {
        console.error("[orchestrator] Failed to load bindings:", error);
        set((state) => {
          state.loading = false;
        });
      }
    },

    create: async (request) => {
      const binding = await taskBindingService.create(request);
      await get().loadBindings();
      return binding;
    },

    update: async (id, request) => {
      const binding = await taskBindingService.update(id, request);
      await get().loadBindings();
      return binding;
    },

    remove: async (id) => {
      await taskBindingService.delete(id);
      set((state) => {
        state.bindings = state.bindings.filter((b) => b.id !== id);
      });
    },

    setFilterTab: (tab) => {
      set((state) => {
        state.filterTab = tab;
      });
      get().loadBindings();
    },

    updateBySessionId: async (sessionId, updates) => {
      const binding = await taskBindingService.findBySession(sessionId);
      if (binding) {
        await taskBindingService.update(binding.id, updates);
        await get().loadBindings();
      }
    },
  }))
);
