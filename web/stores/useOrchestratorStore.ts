import { create } from "zustand";
import { persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { taskBindingService } from "@/services";
import type {
  TaskBinding,
  TaskBindingChangedEvent,
  TaskBindingNode,
  TaskBindingRole,
  TaskBindingStatus,
  CreateTaskBindingRequest,
  TaskBindingPatch,
  UpdateTaskBindingRequest,
  TaskBindingQuery,
} from "@/types";

type FilterTab = "all" | "running" | "completed";
type OrchestratorViewType = "list" | "tree";
const SELECTED_TASK_STORAGE_KEY = "cc-panes-orchestration-selected-task-id";

function readSelectedTaskId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(SELECTED_TASK_STORAGE_KEY);
  } catch {
    return null;
  }
}

function syncSelectedTaskId(id: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (id) {
      window.sessionStorage.setItem(SELECTED_TASK_STORAGE_KEY, id);
    } else {
      window.sessionStorage.removeItem(SELECTED_TASK_STORAGE_KEY);
    }
  } catch {
    // sessionStorage can be unavailable in restricted webviews/tests.
  }
}

interface OrchestratorState {
  // 数据
  bindings: TaskBinding[];
  total: number;
  hasMore: boolean;
  loading: boolean;

  // 过滤
  filterTab: FilterTab;
  filterWorkspace: string | null;
  filterProjectPath: string | null;
  filterRole: TaskBindingRole | null;
  searchKeyword: string;

  // 输入目标
  lastTargetProjectPath: string | null;

  // 视图状态
  viewType: OrchestratorViewType;
  selectedTaskId: string | null;

  // Actions
  loadBindings: (query?: TaskBindingQuery) => Promise<void>;
  create: (request: CreateTaskBindingRequest) => Promise<TaskBinding>;
  update: (id: string, request: UpdateTaskBindingRequest) => Promise<TaskBinding>;
  updatePatch: (id: string, patch: TaskBindingPatch) => Promise<TaskBinding>;
  remove: (id: string) => Promise<void>;
  removeCascade: (id: string) => Promise<void>;
  applyChangedEvent: (event: TaskBindingChangedEvent) => void;
  setFilterTab: (tab: FilterTab) => void;
  setFilterWorkspace: (workspace: string | null) => void;
  setFilterProjectPath: (projectPath: string | null) => void;
  setFilterRole: (role: TaskBindingRole | null) => void;
  setSearchKeyword: (keyword: string) => void;
  setLastTargetProjectPath: (projectPath: string | null) => void;
  setViewType: (viewType: OrchestratorViewType) => void;
  setSelectedTaskId: (id: string | null) => void;
  getTaskTree: () => TaskBindingNode[];
  getVisibleBindings: () => TaskBinding[];
  getActivityBadge: () => { failed: boolean; activeCount: number };

  // 通过 sessionId 更新状态（同步 hook 使用）
  updateBySessionId: (
    sessionId: string,
    updates: TaskBindingPatch
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

function buildTaskTree(bindings: TaskBinding[]): TaskBindingNode[] {
  const nodes = new Map<string, TaskBindingNode>();
  const roots: TaskBindingNode[] = [];

  for (const binding of bindings) {
    nodes.set(binding.id, { ...binding, children: [], depth: 0 });
  }

  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : null;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const assignDepth = (node: TaskBindingNode, depth: number) => {
    node.depth = depth;
    for (const child of node.children) {
      assignDepth(child, depth + 1);
    }
  };
  for (const root of roots) {
    assignDepth(root, 0);
  }

  return roots;
}

function ensureSelectedTask(state: OrchestratorState) {
  if (!state.selectedTaskId) return;
  const exists = state.bindings.some((binding) => binding.id === state.selectedTaskId);
  if (!exists) {
    state.selectedTaskId = state.bindings[0]?.id ?? null;
    syncSelectedTaskId(state.selectedTaskId);
  }
}

function upsertBinding(bindings: TaskBinding[], binding: TaskBinding): TaskBinding[] {
  const index = bindings.findIndex((item) => item.id === binding.id);
  if (index === -1) return [binding, ...bindings];
  const next = bindings.slice();
  next[index] = binding;
  return next;
}

export const useOrchestratorStore = create<OrchestratorState>()(
  persist(
    immer((set, get) => ({
      bindings: [],
      total: 0,
      hasMore: false,
      loading: false,
      filterTab: "all",
      filterWorkspace: null,
      filterProjectPath: null,
      filterRole: null,
      searchKeyword: "",
      lastTargetProjectPath: null,
      viewType: "list",
      selectedTaskId: readSelectedTaskId(),

    loadBindings: async (query?) => {
      set((state) => {
        state.loading = true;
      });
      try {
        const {
          filterTab,
          filterWorkspace,
          filterProjectPath,
          filterRole,
          searchKeyword,
        } = get();
        const mergedQuery: TaskBindingQuery = {
          status: query?.status ?? filterTabToStatus(filterTab),
          workspaceName: query?.workspaceName ?? filterWorkspace ?? undefined,
          projectPath: query?.projectPath ?? filterProjectPath ?? undefined,
          role: query?.role ?? filterRole ?? undefined,
          search: query?.search ?? (searchKeyword.trim() || undefined),
          limit: query?.limit ?? 50,
          offset: query?.offset ?? 0,
        };
        const result = await taskBindingService.query(mergedQuery);
        set((state) => {
          state.bindings = result.items;
          state.total = result.total;
          state.hasMore = result.hasMore;
          state.loading = false;
          ensureSelectedTask(state);
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

    updatePatch: async (id, patch) => {
      const binding = await taskBindingService.updatePatch(id, patch);
      set((state) => {
        state.bindings = upsertBinding(state.bindings, binding);
      });
      return binding;
    },

    remove: async (id) => {
      await taskBindingService.delete(id);
      set((state) => {
        state.bindings = state.bindings.filter((b) => b.id !== id);
        state.total = Math.max(0, state.total - 1);
        ensureSelectedTask(state);
      });
    },

    removeCascade: async (id) => {
      // fix(H3) review: 前端不再逐个删除子任务，后端事务递归删除后本地一次性收敛。
      await taskBindingService.deleteCascade(id);
      set((state) => {
        const deleteIds = new Set<string>([id]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const binding of state.bindings) {
            if (binding.parentId && deleteIds.has(binding.parentId) && !deleteIds.has(binding.id)) {
              deleteIds.add(binding.id);
              changed = true;
            }
          }
        }
        state.bindings = state.bindings.filter((binding) => !deleteIds.has(binding.id));
        state.total = Math.max(0, state.total - deleteIds.size);
        ensureSelectedTask(state);
      });
    },

    applyChangedEvent: (event) => {
      set((state) => {
        if (event.op === "delete") {
          state.bindings = state.bindings.filter((binding) => binding.id !== event.id);
          state.total = Math.max(0, state.total - 1);
          ensureSelectedTask(state);
          return;
        }
        if (!event.binding) return;
        state.bindings = upsertBinding(state.bindings, event.binding);
        state.total = Math.max(state.total, state.bindings.length);
        ensureSelectedTask(state);
      });
    },

    setFilterTab: (tab) => {
      set((state) => {
        state.filterTab = tab;
      });
      get().loadBindings();
    },

    setFilterWorkspace: (workspace) => {
      set((state) => {
        state.filterWorkspace = workspace;
        state.filterProjectPath = null;
      });
      get().loadBindings();
    },

    setFilterProjectPath: (projectPath) => {
      set((state) => {
        state.filterProjectPath = projectPath;
      });
      get().loadBindings();
    },

    setFilterRole: (role) => {
      set((state) => {
        state.filterRole = role;
      });
      get().loadBindings();
    },

    setSearchKeyword: (keyword) => {
      set((state) => {
        state.searchKeyword = keyword;
      });
      get().loadBindings();
    },

    setLastTargetProjectPath: (projectPath) =>
      set((state) => {
        state.lastTargetProjectPath = projectPath;
      }),

    setViewType: (viewType) =>
      set((state) => {
        state.viewType = viewType;
      }),

    setSelectedTaskId: (id) =>
      set((state) => {
        state.selectedTaskId = id;
        syncSelectedTaskId(id);
      }),

    getTaskTree: () => buildTaskTree(get().bindings),

    getVisibleBindings: () => get().bindings,

    getActivityBadge: () => {
      const bindings = get().bindings;
      return {
        failed: bindings.some((binding) => binding.status === "failed"),
        activeCount: bindings.filter(
          (binding) => binding.status === "running" || binding.status === "waiting"
        ).length,
      };
    },

    updateBySessionId: async (sessionId, updates) => {
      const binding = await taskBindingService.findBySession(sessionId);
      if (binding) {
        const updated = await taskBindingService.updatePatch(binding.id, updates);
        set((state) => {
          state.bindings = upsertBinding(state.bindings, updated);
        });
      }
    },
    })),
    {
      name: "cc-panes-orchestrator",
      partialize: (state) => ({
        lastTargetProjectPath: state.lastTargetProjectPath,
      }),
    }
  )
);
