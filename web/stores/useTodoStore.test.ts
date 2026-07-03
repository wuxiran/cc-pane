import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TodoItem, TodoQueryResult, TodoStats } from "@/types";

// Mock 服务层（store 通过 @/services barrel 引入 todoService）
vi.mock("@/services", () => ({
  todoService: {
    query: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    reorder: vi.fn(),
    toggleMyDay: vi.fn(),
    stats: vi.fn(),
    addSubtask: vi.fn(),
    toggleSubtask: vi.fn(),
    deleteSubtask: vi.fn(),
  },
}));

import { todoService } from "@/services";
import { useTodoStore } from "./useTodoStore";

const mockTodo = todoService as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;

function createTestTodo(overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    id: "t1",
    title: "Test Todo",
    status: "todo",
    priority: "medium",
    scope: "global",
    tags: [],
    todoType: "feature",
    myDay: false,
    sortOrder: 0,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    subtasks: [],
    ...overrides,
  };
}

function emptyResult(): TodoQueryResult {
  return { items: [], total: 0, hasMore: false };
}

describe("useTodoStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    // 默认 query 返回空结果，避免 fire-and-forget loadList 抛未处理拒绝
    mockTodo.query.mockResolvedValue(emptyResult());
    useTodoStore.setState({
      todos: [],
      total: 0,
      hasMore: false,
      loading: false,
      filterStatus: null,
      filterScope: null,
      filterPriority: null,
      filterType: null,
      searchText: "",
      customTypes: [],
      selectedTodo: null,
      viewMode: "all",
      contextScope: null,
      contextScopeRef: null,
      stats: null,
    });
  });

  describe("初始状态", () => {
    it("应该有正确的初始值", () => {
      const state = useTodoStore.getState();
      expect(state.todos).toEqual([]);
      expect(state.total).toBe(0);
      expect(state.hasMore).toBe(false);
      expect(state.loading).toBe(false);
      expect(state.selectedTodo).toBeNull();
      expect(state.viewMode).toBe("all");
    });
  });

  describe("loadList", () => {
    it("应该加载列表并写入 todos/total/hasMore", async () => {
      const todos = [createTestTodo({ id: "a" }), createTestTodo({ id: "b" })];
      mockTodo.query.mockResolvedValue({ items: todos, total: 2, hasMore: true });

      await useTodoStore.getState().loadList();

      const state = useTodoStore.getState();
      expect(state.todos).toEqual(todos);
      expect(state.total).toBe(2);
      expect(state.hasMore).toBe(true);
      expect(state.loading).toBe(false);
    });

    it("应该合并当前筛选状态到查询参数", async () => {
      useTodoStore.setState({
        filterStatus: "todo",
        filterPriority: "high",
        searchText: "hello",
      });

      await useTodoStore.getState().loadList();

      expect(mockTodo.query).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "todo",
          priority: "high",
          search: "hello",
          limit: 100,
          offset: 0,
        }),
      );
    });

    it("应该让传入的 query 覆盖默认筛选", async () => {
      useTodoStore.setState({ filterStatus: "todo" });

      await useTodoStore.getState().loadList({ status: "done", limit: 10 });

      expect(mockTodo.query).toHaveBeenCalledWith(
        expect.objectContaining({ status: "done", limit: 10 }),
      );
    });

    it("视图模式为 my_day 时应传 myDay=true", async () => {
      useTodoStore.setState({ viewMode: "my_day" });

      await useTodoStore.getState().loadList();

      expect(mockTodo.query).toHaveBeenCalledWith(
        expect.objectContaining({ myDay: true }),
      );
    });

    it("加载失败时应重置 loading 并向上抛出", async () => {
      mockTodo.query.mockRejectedValue(new Error("加载失败"));

      await expect(useTodoStore.getState().loadList()).rejects.toThrow(
        "加载失败",
      );
      expect(useTodoStore.getState().loading).toBe(false);
    });
  });

  describe("create", () => {
    it("应该创建 Todo 并刷新列表", async () => {
      const todo = createTestTodo({ id: "new" });
      mockTodo.create.mockResolvedValue(todo);

      const result = await useTodoStore.getState().create({ title: "New" });

      expect(mockTodo.create).toHaveBeenCalledWith({ title: "New" });
      expect(mockTodo.query).toHaveBeenCalled();
      expect(result).toEqual(todo);
    });
  });

  describe("update", () => {
    it("应该更新 Todo 并刷新列表", async () => {
      mockTodo.update.mockResolvedValue(undefined);

      await useTodoStore.getState().update("t1", { title: "改" });

      expect(mockTodo.update).toHaveBeenCalledWith("t1", { title: "改" });
      expect(mockTodo.query).toHaveBeenCalled();
    });

    it("更新选中项时应刷新 selectedTodo", async () => {
      const selected = createTestTodo({ id: "t1", title: "旧" });
      const updated = createTestTodo({ id: "t1", title: "新" });
      useTodoStore.setState({ selectedTodo: selected });
      mockTodo.update.mockResolvedValue(undefined);
      mockTodo.get.mockResolvedValue(updated);

      await useTodoStore.getState().update("t1", { title: "新" });

      expect(mockTodo.get).toHaveBeenCalledWith("t1");
      expect(useTodoStore.getState().selectedTodo).toEqual(updated);
    });

    it("更新非选中项时不刷新 selectedTodo", async () => {
      const selected = createTestTodo({ id: "other" });
      useTodoStore.setState({ selectedTodo: selected });
      mockTodo.update.mockResolvedValue(undefined);

      await useTodoStore.getState().update("t1", { title: "新" });

      expect(mockTodo.get).not.toHaveBeenCalled();
      expect(useTodoStore.getState().selectedTodo).toEqual(selected);
    });
  });

  describe("remove", () => {
    it("应该从列表移除并递减 total", async () => {
      const a = createTestTodo({ id: "a" });
      const b = createTestTodo({ id: "b" });
      useTodoStore.setState({ todos: [a, b], total: 2 });
      mockTodo.delete.mockResolvedValue(undefined);

      await useTodoStore.getState().remove("a");

      const state = useTodoStore.getState();
      expect(state.todos).toEqual([b]);
      expect(state.total).toBe(1);
    });

    it("删除选中项时应清空 selectedTodo", async () => {
      const a = createTestTodo({ id: "a" });
      useTodoStore.setState({ todos: [a], total: 1, selectedTodo: a });
      mockTodo.delete.mockResolvedValue(undefined);

      await useTodoStore.getState().remove("a");

      expect(useTodoStore.getState().selectedTodo).toBeNull();
    });

    it("total 不会低于 0", async () => {
      useTodoStore.setState({ todos: [], total: 0 });
      mockTodo.delete.mockResolvedValue(undefined);

      await useTodoStore.getState().remove("x");

      expect(useTodoStore.getState().total).toBe(0);
    });
  });

  describe("select", () => {
    it("应该设置 selectedTodo", () => {
      const todo = createTestTodo();
      useTodoStore.getState().select(todo);
      expect(useTodoStore.getState().selectedTodo).toEqual(todo);
    });

    it("传 null 应清空选中", () => {
      useTodoStore.setState({ selectedTodo: createTestTodo() });
      useTodoStore.getState().select(null);
      expect(useTodoStore.getState().selectedTodo).toBeNull();
    });
  });

  describe("筛选 setter", () => {
    it("setFilterStatus 应设置状态并触发 loadList", () => {
      useTodoStore.getState().setFilterStatus("done");
      expect(useTodoStore.getState().filterStatus).toBe("done");
      expect(mockTodo.query).toHaveBeenCalled();
    });

    it("setFilterScope 应设置作用域并触发 loadList", () => {
      useTodoStore.getState().setFilterScope("workspace");
      expect(useTodoStore.getState().filterScope).toBe("workspace");
      expect(mockTodo.query).toHaveBeenCalled();
    });

    it("setFilterPriority 应设置优先级并触发 loadList", () => {
      useTodoStore.getState().setFilterPriority("low");
      expect(useTodoStore.getState().filterPriority).toBe("low");
      expect(mockTodo.query).toHaveBeenCalled();
    });

    it("setFilterType 应设置类型并触发 loadList", () => {
      useTodoStore.getState().setFilterType("bug");
      expect(useTodoStore.getState().filterType).toBe("bug");
      expect(mockTodo.query).toHaveBeenCalled();
    });

    it("setSearchText 应设置文本但不触发 loadList", () => {
      useTodoStore.getState().setSearchText("abc");
      expect(useTodoStore.getState().searchText).toBe("abc");
      expect(mockTodo.query).not.toHaveBeenCalled();
    });
  });

  describe("自定义类型", () => {
    it("addCustomType 应追加并持久化到 localStorage", () => {
      useTodoStore.getState().addCustomType("Research");

      expect(useTodoStore.getState().customTypes).toContain("research");
      expect(
        JSON.parse(localStorage.getItem("cc-panes-todo-custom-types") || "[]"),
      ).toContain("research");
    });

    it("addCustomType 应去重且忽略空白", () => {
      useTodoStore.getState().addCustomType("research");
      useTodoStore.getState().addCustomType("RESEARCH");
      useTodoStore.getState().addCustomType("   ");

      expect(useTodoStore.getState().customTypes).toEqual(["research"]);
    });

    it("removeCustomType 应移除并持久化", () => {
      useTodoStore.setState({ customTypes: ["research", "spike"] });

      useTodoStore.getState().removeCustomType("research");

      expect(useTodoStore.getState().customTypes).toEqual(["spike"]);
      expect(
        JSON.parse(localStorage.getItem("cc-panes-todo-custom-types") || "[]"),
      ).toEqual(["spike"]);
    });
  });

  describe("setContext", () => {
    it("应该同时设置上下文与 filterScope", () => {
      useTodoStore.getState().setContext("project", "/tmp/proj");

      const state = useTodoStore.getState();
      expect(state.contextScope).toBe("project");
      expect(state.contextScopeRef).toBe("/tmp/proj");
      expect(state.filterScope).toBe("project");
    });
  });

  describe("reorder", () => {
    it("应该调用 reorder 并刷新列表", async () => {
      mockTodo.reorder.mockResolvedValue(undefined);

      await useTodoStore.getState().reorder(["a", "b"]);

      expect(mockTodo.reorder).toHaveBeenCalledWith(["a", "b"]);
      expect(mockTodo.query).toHaveBeenCalled();
    });
  });

  describe("setViewMode", () => {
    it("应该设置视图模式并触发 loadList", () => {
      useTodoStore.getState().setViewMode("my_day");
      expect(useTodoStore.getState().viewMode).toBe("my_day");
      expect(mockTodo.query).toHaveBeenCalled();
    });
  });

  describe("toggleMyDay", () => {
    it("应该切换并刷新列表", async () => {
      mockTodo.toggleMyDay.mockResolvedValue(undefined);

      await useTodoStore.getState().toggleMyDay("t1");

      expect(mockTodo.toggleMyDay).toHaveBeenCalledWith("t1");
      expect(mockTodo.query).toHaveBeenCalled();
    });

    it("切换选中项时应刷新 selectedTodo", async () => {
      const selected = createTestTodo({ id: "t1", myDay: false });
      const updated = createTestTodo({ id: "t1", myDay: true });
      useTodoStore.setState({ selectedTodo: selected });
      mockTodo.toggleMyDay.mockResolvedValue(undefined);
      mockTodo.get.mockResolvedValue(updated);

      await useTodoStore.getState().toggleMyDay("t1");

      expect(useTodoStore.getState().selectedTodo).toEqual(updated);
    });
  });

  describe("loadStats", () => {
    it("应该加载统计到 stats", async () => {
      const stats: TodoStats = {
        total: 5,
        byStatus: {},
        byScope: {},
        byPriority: {},
        overdue: 1,
      };
      mockTodo.stats.mockResolvedValue(stats);

      await useTodoStore.getState().loadStats();

      expect(useTodoStore.getState().stats).toEqual(stats);
    });

    it("统计失败时应静默忽略", async () => {
      mockTodo.stats.mockRejectedValue(new Error("stats fail"));

      await expect(useTodoStore.getState().loadStats()).resolves.toBeUndefined();
      expect(useTodoStore.getState().stats).toBeNull();
    });
  });

  describe("addSubtask", () => {
    it("应该添加子任务并刷新选中项与列表", async () => {
      const before = createTestTodo({ id: "t1" });
      const after = createTestTodo({
        id: "t1",
        subtasks: [
          {
            id: "s1",
            todoId: "t1",
            title: "子任务",
            completed: false,
            sortOrder: 0,
            createdAt: "2024-01-01T00:00:00Z",
          },
        ],
      });
      useTodoStore.setState({ todos: [before], selectedTodo: before });
      mockTodo.addSubtask.mockResolvedValue(undefined);
      mockTodo.get.mockResolvedValue(after);

      await useTodoStore.getState().addSubtask("t1", "子任务");

      expect(mockTodo.addSubtask).toHaveBeenCalledWith("t1", "子任务");
      const state = useTodoStore.getState();
      expect(state.selectedTodo).toEqual(after);
      expect(state.todos[0]).toEqual(after);
    });
  });

  describe("toggleSubtask", () => {
    it("应该切换子任务并刷新选中项", async () => {
      const selected = createTestTodo({ id: "t1" });
      const updated = createTestTodo({ id: "t1", title: "updated" });
      useTodoStore.setState({ todos: [selected], selectedTodo: selected });
      mockTodo.toggleSubtask.mockResolvedValue(undefined);
      mockTodo.get.mockResolvedValue(updated);

      await useTodoStore.getState().toggleSubtask("s1");

      expect(mockTodo.toggleSubtask).toHaveBeenCalledWith("s1");
      expect(useTodoStore.getState().selectedTodo).toEqual(updated);
    });

    it("无选中项时不应调用 get", async () => {
      mockTodo.toggleSubtask.mockResolvedValue(undefined);

      await useTodoStore.getState().toggleSubtask("s1");

      expect(mockTodo.get).not.toHaveBeenCalled();
    });
  });

  describe("deleteSubtask", () => {
    it("应该删除子任务并刷新选中项", async () => {
      const selected = createTestTodo({ id: "t1" });
      const updated = createTestTodo({ id: "t1", title: "updated" });
      useTodoStore.setState({ todos: [selected], selectedTodo: selected });
      mockTodo.deleteSubtask.mockResolvedValue(undefined);
      mockTodo.get.mockResolvedValue(updated);

      await useTodoStore.getState().deleteSubtask("s1");

      expect(mockTodo.deleteSubtask).toHaveBeenCalledWith("s1");
      expect(useTodoStore.getState().selectedTodo).toEqual(updated);
    });
  });

  describe("reset", () => {
    it("应该恢复到初始状态", () => {
      useTodoStore.setState({
        todos: [createTestTodo()],
        total: 3,
        selectedTodo: createTestTodo(),
        viewMode: "my_day",
        filterStatus: "done",
      });

      useTodoStore.getState().reset();

      const state = useTodoStore.getState();
      expect(state.todos).toEqual([]);
      expect(state.total).toBe(0);
      expect(state.selectedTodo).toBeNull();
      expect(state.viewMode).toBe("all");
      expect(state.filterStatus).toBeNull();
    });
  });
});
