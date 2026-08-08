/**
 * Todo 状态管理
 *
 * 使用 Zustand + Immer 管理 TodoList 看板的前端状态。
 * 所有异步操作通过 todoService 层调用 Tauri 后端。
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { todoService } from "@/services";
import type {
  TodoItem,
  TodoStatus,
  TodoPriority,
  TodoScope,
  TodoQuery,
  TodoQueryResult,
  TodoStats,
  TodoSortBy,
  TodoWorkView,
  TodoActivity,
  TodoSavedFilter,
  CreateTodoRequest,
  UpdateTodoRequest,
} from "@/types";

/** 预定义类型常量（不可删除） */
export const BUILTIN_TODO_TYPES = ["feature", "bug", "docs", "chore"] as const;

interface TodoState {
  // 列表
  todos: TodoItem[];
  total: number;
  hasMore: boolean;
  loading: boolean;

  // 筛选状态
  filterStatus: TodoStatus | null;
  filterScope: TodoScope | null;
  filterPriority: TodoPriority | null;
  filterType: string | null;
  searchText: string;

  // 自定义类型
  customTypes: string[];

  // 当前选中
  selectedTodo: TodoItem | null;

  // 视图模式
  viewMode: TodoWorkView;

  // 打开时的上下文
  contextScope: TodoScope | null;
  contextScopeRef: string | null;
  scopeSelectionExplicit: boolean;

  // 统计
  stats: TodoStats | null;
  activities: TodoActivity[];
  activitiesLoading: boolean;
  savedFilters: TodoSavedFilter[];

  // Actions
  loadList: (query?: TodoQuery) => Promise<void>;
  create: (request: CreateTodoRequest) => Promise<TodoItem>;
  update: (id: string, request: UpdateTodoRequest) => Promise<void>;
  remove: (id: string) => Promise<void>;
  select: (todo: TodoItem | null) => void;
  setFilterStatus: (status: TodoStatus | null) => void;
  setFilterScope: (scope: TodoScope | null) => void;
  setFilterPriority: (priority: TodoPriority | null) => void;
  setFilterType: (type: string | null) => void;
  clearFilters: () => void;
  sortBy: TodoSortBy;
  setSortBy: (sortBy: TodoSortBy) => void;
  selectedIds: string[];
  toggleSelected: (id: string) => void;
  clearSelection: () => void;
  batchUpdateStatus: (ids: string[], status: TodoStatus) => Promise<void>;
  addCustomType: (type: string) => void;
  removeCustomType: (type: string) => void;
  setSearchText: (text: string) => void;
  setContext: (scope: TodoScope | null, scopeRef: string | null) => void;
  reorder: (todoIds: string[]) => Promise<void>;
  setViewMode: (mode: TodoWorkView) => void;
  toggleMyDay: (id: string) => Promise<void>;
  loadStats: () => Promise<void>;
  loadActivities: (todoId: string) => Promise<void>;
  saveCurrentFilter: (name: string) => void;
  applySavedFilter: (filter: TodoSavedFilter) => void;
  removeSavedFilter: (id: string) => void;
  addSubtask: (todoId: string, title: string) => Promise<void>;
  toggleSubtask: (subtaskId: string) => Promise<void>;
  deleteSubtask: (subtaskId: string) => Promise<void>;
  reset: () => void;
}

const INITIAL_STATE = {
  todos: [] as TodoItem[],
  total: 0,
  hasMore: false,
  loading: false,
  filterStatus: null as TodoStatus | null,
  filterScope: null as TodoScope | null,
  filterPriority: null as TodoPriority | null,
  filterType: null as string | null,
  searchText: "",
  customTypes: JSON.parse(localStorage.getItem("cc-panes-todo-custom-types") || "[]") as string[],
  selectedTodo: null as TodoItem | null,
  viewMode: "all" as TodoWorkView,
  contextScope: null as TodoScope | null,
  contextScopeRef: null as string | null,
  scopeSelectionExplicit: false,
  sortBy: "manual" as TodoSortBy,
  selectedIds: [] as string[],
  stats: null as TodoStats | null,
  activities: [] as TodoActivity[],
  activitiesLoading: false,
  savedFilters: JSON.parse(localStorage.getItem("cc-panes-todo-saved-filters") || "[]") as TodoSavedFilter[],
};

export const useTodoStore = create<TodoState>()(
  immer((set, get) => ({
    ...INITIAL_STATE,

    loadList: async (query?) => {
      set((state) => {
        state.loading = true;
      });
      try {
        const {
          filterStatus,
          filterScope,
          filterPriority,
          filterType,
          searchText,
          contextScope,
          contextScopeRef,
          scopeSelectionExplicit,
          sortBy,
          viewMode,
        } = get();
        const activeScope = scopeSelectionExplicit ? filterScope : filterScope ?? contextScope;
        const activeScopeRef = scopeSelectionExplicit
          ? filterScope && filterScope === contextScope
            ? contextScopeRef ?? undefined
            : undefined
          : contextScopeRef ?? undefined;
        const mergedQuery: TodoQuery = {
          status: query?.status ?? filterStatus ?? undefined,
          priority: query?.priority ?? filterPriority ?? undefined,
          scope: query?.scope ?? activeScope ?? undefined,
          scopeRef: query?.scopeRef ?? activeScopeRef,
          search: query?.search ?? (searchText.trim() || undefined),
          todoType: query?.todoType ?? filterType ?? undefined,
          sortBy: query?.sortBy ?? (sortBy === "manual" ? undefined : sortBy),
          myDay: viewMode === "my_day" ? true : undefined,
          inbox: viewMode === "inbox" ? true : undefined,
          overdue: viewMode === "overdue" ? true : undefined,
          limit: query?.limit ?? 100,
          offset: query?.offset ?? 0,
          ...query,
        };

        const result: TodoQueryResult = await todoService.query(mergedQuery);
        set((state) => {
          state.todos = result.items;
          state.total = result.total;
          state.hasMore = result.hasMore;
          state.loading = false;
          state.selectedIds = state.selectedIds.filter((id) => result.items.some((todo) => todo.id === id));
        });
        void get().loadStats();
      } catch (error) {
        set((state) => {
          state.loading = false;
        });
        throw error;
      }
    },

    create: async (request) => {
      const todo = await todoService.create(request);
      await get().loadList();
      return todo;
    },

    update: async (id, request) => {
      await todoService.update(id, request);
      await get().loadList();
      // 更新选中项
      const { selectedTodo } = get();
      if (selectedTodo?.id === id) {
        const updated = await todoService.get(id);
        set((state) => {
          state.selectedTodo = updated;
        });
      }
    },

    remove: async (id) => {
      await todoService.delete(id);
      set((state) => {
        state.todos = state.todos.filter((t) => t.id !== id);
        state.total = Math.max(0, state.total - 1);
        if (state.selectedTodo?.id === id) {
          state.selectedTodo = null;
        }
      });
      void get().loadStats();
    },

    select: (todo) =>
      set((state) => {
        state.selectedTodo = todo;
      }),

    setFilterStatus: (status) => {
      set((state) => {
        state.filterStatus = status;
      });
      get().loadList();
    },

    setFilterScope: (scope) => {
      set((state) => {
        state.filterScope = scope;
        state.scopeSelectionExplicit = true;
      });
      get().loadList();
    },

    setFilterPriority: (priority) => {
      set((state) => {
        state.filterPriority = priority;
      });
      get().loadList();
    },

    setFilterType: (type) => {
      set((state) => {
        state.filterType = type;
      });
      get().loadList();
    },

    clearFilters: () => {
      set((state) => {
        state.filterStatus = null;
        state.filterPriority = null;
        state.filterType = null;
        state.searchText = "";
        state.filterScope = null;
        state.scopeSelectionExplicit = true;
      });
      get().loadList();
    },

    sortBy: "manual",
    setSortBy: (sortBy) => {
      set((state) => {
        state.sortBy = sortBy;
      });
      get().loadList();
    },

    selectedIds: [],
    toggleSelected: (id) =>
      set((state) => {
        const index = state.selectedIds.indexOf(id);
        if (index === -1) state.selectedIds.push(id);
        else state.selectedIds.splice(index, 1);
      }),

    clearSelection: () =>
      set((state) => {
        state.selectedIds = [];
      }),

    batchUpdateStatus: async (ids, status) => {
      if (ids.length === 0) return;
      await todoService.batchUpdateStatus(ids, status);
      set((state) => {
        for (const todo of state.todos) {
          if (ids.includes(todo.id)) todo.status = status;
        }
        state.selectedIds = [];
      });
      await get().loadList();
    },

    addCustomType: (type) => {
      set((state) => {
        const trimmed = type.trim().toLowerCase();
        if (trimmed && !state.customTypes.includes(trimmed)) {
          state.customTypes.push(trimmed);
        }
      });
      localStorage.setItem("cc-panes-todo-custom-types", JSON.stringify(get().customTypes));
    },

    removeCustomType: (type) => {
      set((state) => {
        state.customTypes = state.customTypes.filter((t) => t !== type);
      });
      localStorage.setItem("cc-panes-todo-custom-types", JSON.stringify(get().customTypes));
    },

    setSearchText: (text) =>
      set((state) => {
        state.searchText = text;
      }),

    setContext: (scope, scopeRef) =>
      set((state) => {
        state.contextScope = scope;
        state.contextScopeRef = scopeRef;
        state.scopeSelectionExplicit = false;
        // 同步设置筛选
        state.filterScope = scope;
      }),

    reorder: async (todoIds) => {
      await todoService.reorder(todoIds);
      await get().loadList();
    },

    setViewMode: (mode) => {
      set((state) => {
        state.viewMode = mode;
      });
      get().loadList();
    },

    toggleMyDay: async (id) => {
      await todoService.toggleMyDay(id);
      await get().loadList();
      // 更新选中项
      const { selectedTodo } = get();
      if (selectedTodo?.id === id) {
        const updated = await todoService.get(id);
        set((state) => {
          state.selectedTodo = updated;
        });
      }
    },

    loadStats: async () => {
      try {
        const { contextScope, contextScopeRef } = get();
        const stats = await todoService.stats({
          scope: get().scopeSelectionExplicit ? get().filterScope ?? undefined : contextScope ?? undefined,
          scopeRef:
            get().scopeSelectionExplicit && get().filterScope !== contextScope
              ? undefined
              : contextScopeRef ?? undefined,
        });
        set((state) => {
          state.stats = stats;
        });
      } catch {
        // 统计加载失败不影响主流程
      }
    },

    loadActivities: async (todoId) => {
      set((state) => {
        state.activitiesLoading = true;
      });
      try {
        const activities = await todoService.listActivities(todoId);
        set((state) => {
          state.activities = activities;
          state.activitiesLoading = false;
        });
      } catch {
        set((state) => {
          state.activities = [];
          state.activitiesLoading = false;
        });
      }
    },

    saveCurrentFilter: (name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const state = get();
      const filter: TodoSavedFilter = {
        id: crypto.randomUUID(),
        name: trimmed,
        workView: state.viewMode,
        status: state.filterStatus,
        scope: state.filterScope,
        priority: state.filterPriority,
        todoType: state.filterType,
        search: state.searchText,
        sortBy: state.sortBy,
        createdAt: new Date().toISOString(),
      };
      set((draft) => {
        draft.savedFilters = [filter, ...draft.savedFilters.filter((item) => item.name !== filter.name)].slice(0, 12);
      });
      localStorage.setItem("cc-panes-todo-saved-filters", JSON.stringify(get().savedFilters));
    },

    applySavedFilter: (filter) => {
      set((state) => {
        state.viewMode = filter.workView;
        state.filterStatus = filter.status;
        state.filterScope = filter.scope;
        state.filterPriority = filter.priority;
        state.filterType = filter.todoType;
        state.sortBy = filter.sortBy;
        state.searchText = filter.search ?? "";
        state.scopeSelectionExplicit = true;
      });
      get().loadList();
    },

    removeSavedFilter: (id) => {
      set((state) => {
        state.savedFilters = state.savedFilters.filter((filter) => filter.id !== id);
      });
      localStorage.setItem("cc-panes-todo-saved-filters", JSON.stringify(get().savedFilters));
    },

    addSubtask: async (todoId, title) => {
      await todoService.addSubtask(todoId, title);
      // 刷新选中项
      const updated = await todoService.get(todoId);
      set((state) => {
        if (state.selectedTodo?.id === todoId && updated) {
          state.selectedTodo = updated;
        }
        // 更新列表中的项
        const idx = state.todos.findIndex((t) => t.id === todoId);
        if (idx !== -1 && updated) {
          state.todos[idx] = updated;
        }
      });
    },

    toggleSubtask: async (subtaskId) => {
      await todoService.toggleSubtask(subtaskId);
      // 刷新选中项的 subtasks
      const { selectedTodo } = get();
      if (selectedTodo) {
        const updated = await todoService.get(selectedTodo.id);
        set((state) => {
          if (updated) {
            state.selectedTodo = updated;
            const idx = state.todos.findIndex((t) => t.id === updated.id);
            if (idx !== -1) {
              state.todos[idx] = updated;
            }
          }
        });
      }
    },

    deleteSubtask: async (subtaskId) => {
      await todoService.deleteSubtask(subtaskId);
      const { selectedTodo } = get();
      if (selectedTodo) {
        const updated = await todoService.get(selectedTodo.id);
        set((state) => {
          if (updated) {
            state.selectedTodo = updated;
            const idx = state.todos.findIndex((t) => t.id === updated.id);
            if (idx !== -1) {
              state.todos[idx] = updated;
            }
          }
        });
      }
    },

    reset: () =>
      set((state) => {
        Object.assign(state, INITIAL_STATE);
      }),
  }))
);
