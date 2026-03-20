import { describe, it, expect, beforeEach, vi } from "vitest";
import { useMemoryStore } from "./useMemoryStore";
import { memoryService } from "@/services";
import type { Memory, MemoryQueryResult, MemoryStats } from "@/types";

vi.mock("@/services", () => ({
  memoryService: {
    search: vi.fn(),
    list: vi.fn(),
    store: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    get: vi.fn(),
    stats: vi.fn(),
  },
}));

function createMockMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "mem-1",
    title: "Test Memory",
    content: "Test content",
    scope: "global",
    category: "fact",
    importance: 3,
    workspace_name: null,
    project_path: null,
    session_id: null,
    tags: ["test"],
    source: "user",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    accessed_at: "2024-01-01T00:00:00Z",
    access_count: 0,
    user_id: null,
    sync_status: "local_only",
    sync_version: 0,
    is_deleted: false,
    ...overrides,
  };
}

const mockResult: MemoryQueryResult = {
  items: [createMockMemory(), createMockMemory({ id: "mem-2", title: "Memory 2" })],
  total: 2,
  has_more: false,
};

describe("useMemoryStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMemoryStore.getState().reset();
  });

  describe("初始状态", () => {
    it("应该有正确的初始值", () => {
      const state = useMemoryStore.getState();
      expect(state.memories).toEqual([]);
      expect(state.total).toBe(0);
      expect(state.hasMore).toBe(false);
      expect(state.loading).toBe(false);
      expect(state.searchText).toBe("");
      expect(state.selectedScope).toBeNull();
      expect(state.selectedCategory).toBeNull();
      expect(state.selectedMemory).toBeNull();
      expect(state.stats).toBeNull();
    });
  });

  describe("search", () => {
    it("成功时应更新 memories 和 total", async () => {
      vi.mocked(memoryService.search).mockResolvedValue(mockResult);

      await useMemoryStore.getState().search({ search: "test" });

      const state = useMemoryStore.getState();
      expect(state.memories).toEqual(mockResult.items);
      expect(state.total).toBe(2);
      expect(state.hasMore).toBe(false);
      expect(state.loading).toBe(false);
    });

    it("加载期间 loading 应为 true", async () => {
      vi.mocked(memoryService.search).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(mockResult), 10))
      );

      const searchPromise = useMemoryStore.getState().search({ search: "test" });
      expect(useMemoryStore.getState().loading).toBe(true);

      await searchPromise;
      expect(useMemoryStore.getState().loading).toBe(false);
    });

    it("失败时应重置 loading 并 rethrow 错误", async () => {
      vi.mocked(memoryService.search).mockRejectedValue(
        new Error("search failed")
      );

      await expect(
        useMemoryStore.getState().search({ search: "test" })
      ).rejects.toThrow("search failed");

      expect(useMemoryStore.getState().loading).toBe(false);
    });
  });

  describe("loadList", () => {
    it("成功时应更新列表", async () => {
      vi.mocked(memoryService.list).mockResolvedValue(mockResult);

      await useMemoryStore.getState().loadList({ scope: "global" });

      const state = useMemoryStore.getState();
      expect(state.memories).toEqual(mockResult.items);
      expect(state.total).toBe(2);
      expect(state.loading).toBe(false);
    });

    it("失败时应 rethrow 错误", async () => {
      vi.mocked(memoryService.list).mockRejectedValue(
        new Error("list failed")
      );

      await expect(
        useMemoryStore.getState().loadList()
      ).rejects.toThrow("list failed");

      expect(useMemoryStore.getState().loading).toBe(false);
    });
  });

  describe("store", () => {
    it("有 searchText 时应调用 search 刷新", async () => {
      const newMemory = createMockMemory({ id: "mem-new" });
      vi.mocked(memoryService.store).mockResolvedValue(newMemory);
      vi.mocked(memoryService.search).mockResolvedValue({
        items: [newMemory],
        total: 1,
        has_more: false,
      });
      useMemoryStore.setState({ searchText: "test", selectedScope: "global" });

      const result = await useMemoryStore.getState().store({
        title: "new",
        content: "content",
      });

      expect(result).toEqual(newMemory);
      expect(memoryService.search).toHaveBeenCalledWith({
        search: "test",
        scope: "global",
      });
    });

    it("无 searchText 时应调用 loadList 刷新", async () => {
      const newMemory = createMockMemory({ id: "mem-new" });
      vi.mocked(memoryService.store).mockResolvedValue(newMemory);
      vi.mocked(memoryService.list).mockResolvedValue({
        items: [newMemory],
        total: 1,
        has_more: false,
      });
      useMemoryStore.setState({ searchText: "", selectedScope: "project" });

      await useMemoryStore.getState().store({
        title: "new",
        content: "content",
      });

      expect(memoryService.list).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "project" })
      );
    });
  });

  describe("update", () => {
    it("应调用 update 并刷新列表", async () => {
      const memory = createMockMemory();
      useMemoryStore.setState({
        memories: [memory],
        selectedMemory: memory,
        searchText: "",
      });
      vi.mocked(memoryService.update).mockResolvedValue(true);
      vi.mocked(memoryService.list).mockResolvedValue({
        items: [{ ...memory, title: "updated" }],
        total: 1,
        has_more: false,
      });
      const updatedMemory = { ...memory, title: "updated" };
      vi.mocked(memoryService.get).mockResolvedValue(updatedMemory);

      await useMemoryStore
        .getState()
        .update("mem-1", { title: "updated" });

      expect(memoryService.update).toHaveBeenCalledWith("mem-1", {
        title: "updated",
      });
      // selectedMemory 应被更新
      expect(useMemoryStore.getState().selectedMemory?.title).toBe("updated");
    });

    it("selectedMemory 不匹配时不应调用 get", async () => {
      useMemoryStore.setState({
        selectedMemory: createMockMemory({ id: "other-id" }),
        searchText: "",
      });
      vi.mocked(memoryService.update).mockResolvedValue(true);
      vi.mocked(memoryService.list).mockResolvedValue({
        items: [],
        total: 0,
        has_more: false,
      });

      await useMemoryStore
        .getState()
        .update("mem-1", { title: "updated" });

      expect(memoryService.get).not.toHaveBeenCalled();
    });
  });

  describe("remove", () => {
    it("应本地过滤列表并减少 total", async () => {
      const mem1 = createMockMemory({ id: "mem-1" });
      const mem2 = createMockMemory({ id: "mem-2" });
      useMemoryStore.setState({
        memories: [mem1, mem2],
        total: 2,
        selectedMemory: null,
      });
      vi.mocked(memoryService.delete).mockResolvedValue(true);

      await useMemoryStore.getState().remove("mem-1");

      const state = useMemoryStore.getState();
      expect(state.memories).toHaveLength(1);
      expect(state.memories[0].id).toBe("mem-2");
      expect(state.total).toBe(1);
    });

    it("删除选中的 memory 时应清除 selectedMemory", async () => {
      const memory = createMockMemory();
      useMemoryStore.setState({
        memories: [memory],
        total: 1,
        selectedMemory: memory,
      });
      vi.mocked(memoryService.delete).mockResolvedValue(true);

      await useMemoryStore.getState().remove("mem-1");

      expect(useMemoryStore.getState().selectedMemory).toBeNull();
    });

    it("删除非选中的 memory 时不应清除 selectedMemory", async () => {
      const mem1 = createMockMemory({ id: "mem-1" });
      const mem2 = createMockMemory({ id: "mem-2" });
      useMemoryStore.setState({
        memories: [mem1, mem2],
        total: 2,
        selectedMemory: mem2,
      });
      vi.mocked(memoryService.delete).mockResolvedValue(true);

      await useMemoryStore.getState().remove("mem-1");

      expect(useMemoryStore.getState().selectedMemory).toEqual(mem2);
    });

    it("total 不应变为负数", async () => {
      useMemoryStore.setState({
        memories: [],
        total: 0,
        selectedMemory: null,
      });
      vi.mocked(memoryService.delete).mockResolvedValue(true);

      await useMemoryStore.getState().remove("mem-1");

      expect(useMemoryStore.getState().total).toBe(0);
    });
  });

  describe("同步操作", () => {
    it("select 应设置 selectedMemory", () => {
      const memory = createMockMemory();

      useMemoryStore.getState().select(memory);

      expect(useMemoryStore.getState().selectedMemory).toEqual(memory);
    });

    it("select(null) 应清除 selectedMemory", () => {
      useMemoryStore.setState({ selectedMemory: createMockMemory() });

      useMemoryStore.getState().select(null);

      expect(useMemoryStore.getState().selectedMemory).toBeNull();
    });

    it("setSearchText 应更新搜索文本", () => {
      useMemoryStore.getState().setSearchText("hello");
      expect(useMemoryStore.getState().searchText).toBe("hello");
    });

    it("setSelectedScope 应更新选中 scope", () => {
      useMemoryStore.getState().setSelectedScope("workspace");
      expect(useMemoryStore.getState().selectedScope).toBe("workspace");
    });

    it("setSelectedScope(null) 应清除", () => {
      useMemoryStore.setState({ selectedScope: "global" });
      useMemoryStore.getState().setSelectedScope(null);
      expect(useMemoryStore.getState().selectedScope).toBeNull();
    });

    it("setSelectedCategory 应更新选中 category", () => {
      useMemoryStore.getState().setSelectedCategory("decision");
      expect(useMemoryStore.getState().selectedCategory).toBe("decision");
    });
  });

  describe("loadStats", () => {
    it("成功时应更新 stats", async () => {
      const mockStats: MemoryStats = {
        total: 10,
        by_scope: { global: 5, project: 5 },
        by_category: { fact: 6, decision: 4 },
      };
      vi.mocked(memoryService.stats).mockResolvedValue(mockStats);

      await useMemoryStore.getState().loadStats();

      expect(useMemoryStore.getState().stats).toEqual(mockStats);
    });

    it("失败时不应抛异常", async () => {
      vi.mocked(memoryService.stats).mockRejectedValue(
        new Error("stats failed")
      );

      // 不应抛出
      await useMemoryStore.getState().loadStats();

      expect(useMemoryStore.getState().stats).toBeNull();
    });
  });

  describe("reset", () => {
    it("应恢复所有状态到初始值", () => {
      useMemoryStore.setState({
        memories: [createMockMemory()],
        total: 5,
        hasMore: true,
        loading: true,
        searchText: "search",
        selectedScope: "global",
        selectedCategory: "fact",
        selectedMemory: createMockMemory(),
        stats: { total: 10, by_scope: {}, by_category: {} },
      });

      useMemoryStore.getState().reset();

      const state = useMemoryStore.getState();
      expect(state.memories).toEqual([]);
      expect(state.total).toBe(0);
      expect(state.hasMore).toBe(false);
      expect(state.loading).toBe(false);
      expect(state.searchText).toBe("");
      expect(state.selectedScope).toBeNull();
      expect(state.selectedCategory).toBeNull();
      expect(state.selectedMemory).toBeNull();
      expect(state.stats).toBeNull();
    });
  });
});
