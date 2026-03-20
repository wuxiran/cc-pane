/**
 * Memory 状态管理
 *
 * 使用 Zustand + Immer 管理 Memory 系统的前端状态。
 * 所有异步操作通过 memoryService 层调用 Tauri 后端。
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { memoryService } from "@/services";
import type {
  Memory,
  MemoryQuery,
  MemoryStats,
  MemoryScope,
  StoreMemoryRequest,
  UpdateMemoryRequest,
} from "@/types";

interface MemoryState {
  // 列表/搜索状态
  memories: Memory[];
  total: number;
  hasMore: boolean;
  loading: boolean;

  // 当前筛选条件
  searchText: string;
  selectedScope: MemoryScope | null;
  selectedCategory: string | null;

  // 当前选中的 Memory
  selectedMemory: Memory | null;

  // 统计
  stats: MemoryStats | null;

  // Actions
  search: (query: MemoryQuery) => Promise<void>;
  loadList: (params?: {
    scope?: MemoryScope;
    workspaceName?: string;
    projectPath?: string;
    limit?: number;
    offset?: number;
  }) => Promise<void>;
  store: (request: StoreMemoryRequest) => Promise<Memory>;
  update: (id: string, request: UpdateMemoryRequest) => Promise<void>;
  remove: (id: string) => Promise<void>;
  select: (memory: Memory | null) => void;
  setSearchText: (text: string) => void;
  setSelectedScope: (scope: MemoryScope | null) => void;
  setSelectedCategory: (category: string | null) => void;
  loadStats: (params?: {
    workspaceName?: string;
    projectPath?: string;
  }) => Promise<void>;
  reset: () => void;
}

const INITIAL_STATE = {
  memories: [] as Memory[],
  total: 0,
  hasMore: false,
  loading: false,
  searchText: "",
  selectedScope: null as MemoryScope | null,
  selectedCategory: null as string | null,
  selectedMemory: null as Memory | null,
  stats: null as MemoryStats | null,
};

export const useMemoryStore = create<MemoryState>()(
  immer((set, get) => ({
    ...INITIAL_STATE,

    search: async (query) => {
      set((state) => {
        state.loading = true;
      });
      try {
        const result = await memoryService.search(query);
        set((state) => {
          state.memories = result.items;
          state.total = result.total;
          state.hasMore = result.has_more;
          state.loading = false;
        });
      } catch (error) {
        set((state) => {
          state.loading = false;
        });
        throw error;
      }
    },

    loadList: async (params) => {
      set((state) => {
        state.loading = true;
      });
      try {
        const result = await memoryService.list({
          scope: params?.scope,
          workspaceName: params?.workspaceName,
          projectPath: params?.projectPath,
          limit: params?.limit,
          offset: params?.offset,
        });
        set((state) => {
          state.memories = result.items;
          state.total = result.total;
          state.hasMore = result.has_more;
          state.loading = false;
        });
      } catch (error) {
        set((state) => {
          state.loading = false;
        });
        throw error;
      }
    },

    store: async (request) => {
      const memory = await memoryService.store(request);
      // 刷新列表
      const { searchText, selectedScope } = get();
      if (searchText) {
        await get().search({
          search: searchText,
          scope: selectedScope ?? undefined,
        });
      } else {
        await get().loadList({ scope: selectedScope ?? undefined });
      }
      return memory;
    },

    update: async (id, request) => {
      await memoryService.update(id, request);
      // 刷新列表
      const { searchText, selectedScope } = get();
      if (searchText) {
        await get().search({
          search: searchText,
          scope: selectedScope ?? undefined,
        });
      } else {
        await get().loadList({ scope: selectedScope ?? undefined });
      }
      // 更新选中项
      const { selectedMemory } = get();
      if (selectedMemory?.id === id) {
        const updated = await memoryService.get(id);
        set((state) => {
          state.selectedMemory = updated;
        });
      }
    },

    remove: async (id) => {
      await memoryService.delete(id);
      set((state) => {
        state.memories = state.memories.filter((m) => m.id !== id);
        state.total = Math.max(0, state.total - 1);
        if (state.selectedMemory?.id === id) {
          state.selectedMemory = null;
        }
      });
    },

    select: (memory) =>
      set((state) => {
        state.selectedMemory = memory;
      }),

    setSearchText: (text) =>
      set((state) => {
        state.searchText = text;
      }),

    setSelectedScope: (scope) =>
      set((state) => {
        state.selectedScope = scope;
      }),

    setSelectedCategory: (category) =>
      set((state) => {
        state.selectedCategory = category;
      }),

    loadStats: async (params) => {
      try {
        const stats = await memoryService.stats(params);
        set((state) => {
          state.stats = stats;
        });
      } catch {
        // 统计加载失败不影响主流程
      }
    },

    reset: () =>
      set((state) => {
        Object.assign(state, INITIAL_STATE);
      }),
  }))
);
