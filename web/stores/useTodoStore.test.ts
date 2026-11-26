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
    batchUpdateStatus: vi.fn(),
    toggleMyDay: vi.fn(),
    stats: vi.fn(),
    listActivities: vi.fn(),
    addSubtask: vi.fn(),
    toggleSubtask: vi.fn(),
    deleteSubtask: vi.fn(),
  },
  taskBindingService: {
    query: vi.fn(),
  },
}));

import { taskBindingService, todoService } from "@/services";
import { useTodoStore } from "./useTodoStore";

const mockTodo = todoService as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const mockBinding = taskBindingService as unknown as Record<
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
    mockBinding.query.mockResolvedValue({ items: [], total: 0, hasMore: false });
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
      activities: [],
      activitiesLoading: false,
      savedFilters: [],
      dispatchInfoByTodoId: {},
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

    // 「所有任务」「收件箱」默认排除 ai-work-item；my_day / overdue 不携带 excludeTodoType
    it.each([
      ["all", { excludeTodoType: "ai-work-item" }],
      ["inbox", { inbox: true, excludeTodoType: "ai-work-item" }],
      ["my_day", { myDay: true, excludeTodoType: undefined }],
      ["overdue", { overdue: true, excludeTodoType: undefined }],
    ] as const)("视图模式 %s 应传递对应查询条件", async (viewMode, expected) => {
      useTodoStore.setState({ viewMode });

      await useTodoStore.getState().loadList();

      expect(mockTodo.query).toHaveBeenLastCalledWith(expect.objectContaining(expected));
    });

    it("ai_work 视图应强制按 todoType=ai-work-item 精确取数", async () => {
      useTodoStore.setState({ viewMode: "ai_work", filterType: "bug" });

      await useTodoStore.getState().loadList();

      expect(mockTodo.query).toHaveBeenCalledWith(
        expect.objectContaining({ todoType: "ai-work-item", excludeTodoType: undefined }),
      );
    });

    it("ai_work 视图加载后应反查 binding 构建派工映射", async () => {
      useTodoStore.setState({ viewMode: "ai_work" });
      mockBinding.query.mockResolvedValue({
        items: [
          {
            id: "b1",
            sessionId: "sess-abcdef",
            status: "running",
            metadata: { todoIds: ["td-1", "td-2"] },
          },
          { id: "b2", status: "pending", metadata: { todoIds: ["td-3"] } },
          { id: "b3", status: "completed", metadata: { other: true } },
          { id: "b4", status: "completed", metadata: null },
        ],
        total: 4,
        hasMore: false,
      });

      await useTodoStore.getState().loadList();
      await vi.waitFor(() => {
        expect(Object.keys(useTodoStore.getState().dispatchInfoByTodoId)).toHaveLength(3);
      });

      const map = useTodoStore.getState().dispatchInfoByTodoId;
      expect(map["td-1"]).toEqual({ bindingId: "b1", sessionId: "sess-abcdef", status: "running" });
      expect(map["td-2"]).toEqual({ bindingId: "b1", sessionId: "sess-abcdef", status: "running" });
      expect(map["td-3"]).toEqual({ bindingId: "b2", sessionId: undefined, status: "pending" });
    });

    it("非 ai_work 视图不应触发 binding 反查", async () => {
      useTodoStore.setState({ viewMode: "all" });

      await useTodoStore.getState().loadList();

      expect(mockBinding.query).not.toHaveBeenCalled();
    });

    it("加载失败时应重置 loading 并向上抛出", async () => {
      mockTodo.query.mockRejectedValue(new Error("加载失败"));

      await expect(useTodoStore.getState().loadList()).rejects.toThrow(
        "加载失败",
      );
      expect(useTodoStore.getState().loading).toBe(false);
    });
  });

  describe("变更操作调用 service 并刷新列表", () => {
    const created = createTestTodo({ id: "new" });
    it.each([
      ["create", [{ title: "New" }], created],
      ["update", ["t1", { title: "改" }], undefined],
      ["reorder", [["a", "b"]], undefined],
      ["toggleMyDay", ["t1"], undefined],
    ] as const)("%s 应调用 service 并刷新列表", async (action, args, returned) => {
      mockTodo[action].mockResolvedValue(returned);

      const run = useTodoStore.getState()[action] as (...a: unknown[]) => Promise<unknown>;
      const result = await run(...args);

      expect(mockTodo[action]).toHaveBeenCalledWith(...args);
      expect(mockTodo.query).toHaveBeenCalled();
      expect(result).toEqual(returned);
    });
  });

  describe("update", () => {
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

  describe("筛选 setter", () => {
    it.each([
      ["setFilterStatus", "filterStatus", "done"],
      ["setFilterScope", "filterScope", "workspace"],
      ["setFilterPriority", "filterPriority", "low"],
      ["setFilterType", "filterType", "bug"],
      ["setViewMode", "viewMode", "my_day"],
    ] as const)("%s 应设置 %s 并触发 loadList", (setter, field, value) => {
      (useTodoStore.getState()[setter] as (v: string) => void)(value);
      expect(useTodoStore.getState()[field]).toBe(value);
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

  describe("保存筛选", () => {
    it("保存并恢复当前筛选条件", () => {
      useTodoStore.setState({
        viewMode: "inbox",
        filterStatus: "todo",
        filterPriority: "high",
        filterType: "bug",
        searchText: "登录",
        sortBy: "priority",
      });

      useTodoStore.getState().saveCurrentFilter("待处理缺陷");
      const filter = useTodoStore.getState().savedFilters[0];
      expect(filter.name).toBe("待处理缺陷");
      expect(filter.workView).toBe("inbox");

      useTodoStore.setState({ viewMode: "all", filterStatus: null, filterPriority: null, filterType: null, sortBy: "manual" });
      useTodoStore.getState().applySavedFilter(filter);
      expect(useTodoStore.getState()).toMatchObject({
        viewMode: "inbox",
        filterStatus: "todo",
        filterPriority: "high",
        filterType: "bug",
        searchText: "登录",
        sortBy: "priority",
      });
    });

    it("可删除已保存筛选", () => {
      useTodoStore.getState().saveCurrentFilter("临时视图");
      const id = useTodoStore.getState().savedFilters[0].id;
      useTodoStore.getState().removeSavedFilter(id);
      expect(useTodoStore.getState().savedFilters).toEqual([]);
    });
  });

  describe("活动记录", () => {
    it("加载指定任务的活动记录", async () => {
      const activities = [{ id: "a1", todoId: "t1", action: "created", createdAt: "2024-01-01T00:00:00Z" }];
      mockTodo.listActivities.mockResolvedValue(activities);

      await useTodoStore.getState().loadActivities("t1");

      expect(mockTodo.listActivities).toHaveBeenCalledWith("t1");
      expect(useTodoStore.getState().activities).toEqual(activities);
      expect(useTodoStore.getState().activitiesLoading).toBe(false);
    });
  });

  describe("toggleMyDay", () => {
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

  describe("toggleSubtask / deleteSubtask", () => {
    it.each(["toggleSubtask", "deleteSubtask"] as const)("%s 应操作子任务并刷新选中项", async (action) => {
      const selected = createTestTodo({ id: "t1" });
      const updated = createTestTodo({ id: "t1", title: "updated" });
      useTodoStore.setState({ todos: [selected], selectedTodo: selected });
      mockTodo[action].mockResolvedValue(undefined);
      mockTodo.get.mockResolvedValue(updated);

      await useTodoStore.getState()[action]("s1");

      expect(mockTodo[action]).toHaveBeenCalledWith("s1");
      expect(useTodoStore.getState().selectedTodo).toEqual(updated);
    });

    it("无选中项时不应调用 get", async () => {
      mockTodo.toggleSubtask.mockResolvedValue(undefined);

      await useTodoStore.getState().toggleSubtask("s1");

      expect(mockTodo.get).not.toHaveBeenCalled();
    });
  });

  describe("new list controls", () => {
    it("user-selected all scope does not inherit the entry scope ref", async () => {
      useTodoStore.setState({
        contextScope: "workspace",
        contextScopeRef: "ws-a",
        filterScope: null,
        scopeSelectionExplicit: true,
      });

      await useTodoStore.getState().loadList();

      expect(mockTodo.query).toHaveBeenCalledWith(
        expect.objectContaining({ scope: undefined, scopeRef: undefined }),
      );
    });

    it("passes the selected sort and omits manual sort", async () => {
      useTodoStore.setState({ sortBy: "priority" });
      await useTodoStore.getState().loadList();
      expect(mockTodo.query).toHaveBeenCalledWith(expect.objectContaining({ sortBy: "priority" }));

      mockTodo.query.mockClear();
      useTodoStore.setState({ sortBy: "manual" });
      await useTodoStore.getState().loadList();
      expect(mockTodo.query).toHaveBeenCalledWith(expect.objectContaining({ sortBy: undefined }));
    });

    it("batch updates status and clears the selection", async () => {
      mockTodo.batchUpdateStatus.mockResolvedValue(2);
      useTodoStore.setState({ selectedIds: ["a", "b"] });

      await useTodoStore.getState().batchUpdateStatus(["a", "b"], "done");

      expect(mockTodo.batchUpdateStatus).toHaveBeenCalledWith(["a", "b"], "done");
      expect(useTodoStore.getState().selectedIds).toEqual([]);
      expect(mockTodo.query).toHaveBeenCalled();
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
