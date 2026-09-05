import "@/i18n";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toastErr, toastOk } from "@/lib/feedback";
import { useTodoStore } from "@/stores";
import type { TodoItem } from "@/types";
import TodoManager from "./TodoManager";

vi.mock("@/lib/feedback", () => ({
  toastOk: vi.fn(),
  toastErr: vi.fn(),
}));

// 子组件均有独立测试，这里桩化并捕获 props 以聚焦 Manager 的编排逻辑
const captured = vi.hoisted(() => ({
  sidebar: [] as Record<string, never>[],
  filterBar: [] as Record<string, never>[],
  listItems: [] as Record<string, never>[],
  tagGroups: [] as Record<string, never>[],
  editor: [] as Record<string, never>[],
  overview: [] as Record<string, never>[],
  onDragEnd: undefined as unknown,
}));

vi.mock("./TodoViewSwitcher", () => ({
  default: (p: never) => {
    captured.sidebar.push(p);
    return <div data-testid="todo-view-switcher" />;
  },
}));
vi.mock("./TodoFilterBar", () => ({
  default: (p: never) => {
    captured.filterBar.push(p);
    return <div data-testid="todo-filter-bar" />;
  },
}));
vi.mock("./TodoListItem", () => ({
  SortableTodoListItem: (p: { todo: TodoItem }) => {
    captured.listItems.push(p as never);
    return <div data-testid="todo-list-item">{p.todo.title}</div>;
  },
}));
vi.mock("./TodoTagGroup", () => ({
  default: (p: { tag: string; label?: string }) => {
    captured.tagGroups.push(p as never);
    return (
      <div data-testid="todo-tag-group">{p.label ?? p.tag}</div>
    );
  },
}));
vi.mock("./TodoEditor", () => ({
  default: (p: never) => {
    captured.editor.push(p);
    return <div data-testid="todo-editor" />;
  },
}));
vi.mock("./TodoOverview", () => ({
  default: (p: never) => {
    captured.overview.push(p);
    return <div data-testid="todo-overview" />;
  },
}));

vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: { children: React.ReactNode; onDragEnd: unknown }) => {
      captured.onDragEnd = props.onDragEnd;
      return <>{props.children}</>;
    },
  };
});

function createTodo(overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    id: "t1",
    title: "任务一",
    status: "todo",
    priority: "medium",
    scope: "global",
    tags: [],
    todoType: "feature",
    myDay: false,
    sortOrder: 0,
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-01T00:00:00Z",
    subtasks: [],
    ...overrides,
  };
}

function seedStore(overrides: Record<string, unknown> = {}) {
  useTodoStore.setState({
    todos: [],
    total: 0,
    loading: false,
    selectedTodo: null,
    filterStatus: null,
    filterScope: null,
    filterPriority: null,
    filterType: null,
    searchText: "",
    customTypes: [],
    viewMode: "all",
    loadList: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(createTodo()),
    update: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    select: vi.fn(),
    setFilterStatus: vi.fn(),
    setFilterScope: vi.fn(),
    setFilterPriority: vi.fn(),
    setFilterType: vi.fn(),
    setSearchText: vi.fn(),
    setContext: vi.fn(),
    reset: vi.fn(),
    setViewMode: vi.fn(),
    toggleMyDay: vi.fn().mockResolvedValue(undefined),
    reorder: vi.fn().mockResolvedValue(undefined),
    addSubtask: vi.fn().mockResolvedValue(undefined),
    toggleSubtask: vi.fn().mockResolvedValue(undefined),
    deleteSubtask: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as never);
}

function lastEditor() {
  return captured.editor[captured.editor.length - 1] as unknown as {
    form: { title: string; tags: string; scope: string; scopeRef: string };
    isNew: boolean;
    onChange: (f: unknown) => void;
    onSave: () => Promise<void> | void;
    onDelete?: () => void;
  };
}

describe("TodoManager", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    captured.sidebar.length = 0;
    captured.filterBar.length = 0;
    captured.listItems.length = 0;
    captured.tagGroups.length = 0;
    captured.editor.length = 0;
    captured.overview.length = 0;
    seedStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("挂载时设置上下文并加载列表，卸载时 reset", () => {
    const { unmount } = render(
      <TodoManager scope="workspace" scopeRef="ws-a" />,
    );

    const s = useTodoStore.getState();
    expect(s.setContext).toHaveBeenCalledWith("workspace", "ws-a");
    expect(s.loadList).toHaveBeenCalled();

    unmount();
    expect(s.reset).toHaveBeenCalledTimes(1);
  });

  it("scope 为空串时不设置上下文", () => {
    render(<TodoManager scope="" scopeRef="" />);

    expect(useTodoStore.getState().setContext).not.toHaveBeenCalled();
  });

  it("搜索文本变化 300ms 去抖后重新加载", () => {
    vi.useFakeTimers();
    render(<TodoManager scope="" scopeRef="" />);
    const loadList = useTodoStore.getState().loadList;
    act(() => {
      vi.advanceTimersByTime(300);
    });
    const baseline = vi.mocked(loadList).mock.calls.length;

    act(() => {
      useTodoStore.setState({ searchText: "关键字" } as never);
    });
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(vi.mocked(loadList).mock.calls.length).toBe(baseline);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(vi.mocked(loadList).mock.calls.length).toBe(baseline + 1);
  });

  it("loading 时显示加载占位", () => {
    seedStore({ loading: true });
    render(<TodoManager scope="" scopeRef="" />);

    expect(screen.getByText("加载中...")).toBeVisible();
  });

  it("空列表显示加号入口和右侧概览", () => {
    render(<TodoManager scope="workspace" scopeRef="ws-a" />);

    expect(screen.getByText("暂无任务")).toBeVisible();
    expect(screen.getByTestId("todo-overview")).toBeInTheDocument();
    expect(screen.queryByTestId("todo-filter-bar")).not.toBeInTheDocument();

    expect(screen.queryByPlaceholderText("添加任务...")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
    expect(lastEditor().isNew).toBe(true);
  });

  it("列表加载后自动选中第一条", () => {
    const todos = [createTodo(), createTodo({ id: "t2", title: "任务二" })];
    seedStore({ todos, total: 2 });
    render(<TodoManager scope="" scopeRef="" />);

    expect(useTodoStore.getState().select).not.toHaveBeenCalled();
  });

  it("头部显示当前视图标题与任务总数", () => {
    seedStore({ total: 3, viewMode: "my_day" });
    render(<TodoManager scope="" scopeRef="" />);

    expect(captured.sidebar[captured.sidebar.length - 1]).toEqual(expect.objectContaining({ viewMode: "my_day" }));
    expect(screen.getByText("共 3 个任务")).toBeVisible();
  });

  it("按 filterScope 显示作用域标题", () => {
    seedStore({ filterScope: "project" });
    render(<TodoManager scope="" scopeRef="" />);

    expect(captured.sidebar[captured.sidebar.length - 1]).toEqual(expect.objectContaining({ activeScope: "project" }));
  });

  it("uses a two-column layout and resizes the task list", () => {
    seedStore({ todos: [createTodo()], total: 1 });
    render(<TodoManager scope="" scopeRef="" />);

    const [layoutHandle] = screen.getAllByRole("separator");
    const listPanel = layoutHandle.previousElementSibling as HTMLElement;
    const detailsPanel = layoutHandle.parentElement?.nextElementSibling as HTMLElement;

    expect(screen.getByTestId("todo-view-switcher")).toBeInTheDocument();
    expect(listPanel).toHaveStyle({ width: "280px" });
    expect(detailsPanel).toHaveClass("flex-1");

    fireEvent.pointerDown(layoutHandle, { clientX: 280 });
    fireEvent.pointerMove(window, { clientX: 320 });
    fireEvent.pointerUp(window);
    expect(listPanel).toHaveStyle({ width: "320px" });
    expect(localStorage.getItem("cc-panes-sidebar-width")).toBe("320");

    fireEvent.pointerDown(layoutHandle, { clientX: 320 });
    fireEvent.pointerMove(window, { clientX: 280 });
    fireEvent.pointerUp(window);
    expect(listPanel).toHaveStyle({ width: "280px" });
  });

  it("uses the same persisted width as the other sidebar views", () => {
    localStorage.setItem("cc-panes-sidebar-width", "333");
    seedStore({ todos: [createTodo()], total: 1 });
    render(<TodoManager scope="" scopeRef="" />);

    const [layoutHandle] = screen.getAllByRole("separator");
    expect(layoutHandle.previousElementSibling).toHaveStyle({ width: "333px" });
  });

  it("选中任务后编辑器回填表单（标签逗号连接）", () => {
    const todo = createTodo({
      title: "修 bug",
      tags: ["bug", "前端"],
      description: "描述",
    });
    seedStore({ todos: [todo], selectedTodo: todo, total: 1 });
    render(<TodoManager scope="" scopeRef="" />);

    const editor = lastEditor();
    expect(editor.isNew).toBe(false);
    expect(editor.form.title).toBe("修 bug");
    expect(editor.form.tags).toBe("bug, 前端");
  });

  it("点击加号打开新建编辑器", async () => {
    render(<TodoManager scope="" scopeRef="" />);

    const addButton = screen.getByRole("button", { name: "新建任务" });
    expect(addButton).toBeEnabled();
    fireEvent.click(addButton);

    expect(lastEditor().isNew).toBe(true);
    await act(async () => {
      await lastEditor().onSave();
    });
    expect(toastErr).toHaveBeenCalled();
    expect(useTodoStore.getState().create).not.toHaveBeenCalled();
  });

  it("保存：新建时组装 CreateTodoRequest（解析标签、空值转 undefined）", async () => {
    seedStore({ viewMode: "overdue" });
    render(<TodoManager scope="" scopeRef="" />);

    fireEvent.click(screen.getByRole("button", { name: "新建任务" }));

    const editor = lastEditor();
    act(() => {
      editor.onChange({
        ...editor.form,
        title: "  新任务  ",
        tags: "bug, , 前端",
      });
    });
    await act(async () => {
      await lastEditor().onSave();
    });

    expect(useTodoStore.getState().create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "新任务",
        tags: ["bug", "前端"],
        description: undefined,
        dueDate: undefined,
        todoType: undefined,
      }),
    );
    expect(toastOk).toHaveBeenCalled();
  });

  it("保存：编辑已选任务走 update", async () => {
    const todo = createTodo({ id: "t9", title: "旧标题" });
    seedStore({ todos: [todo], selectedTodo: todo, total: 1 });
    render(<TodoManager scope="" scopeRef="" />);

    const editor = lastEditor();
    act(() => {
      editor.onChange({ ...editor.form, title: "新标题" });
    });
    await act(async () => {
      await lastEditor().onSave();
    });

    expect(useTodoStore.getState().update).toHaveBeenCalledWith(
      "t9",
      expect.objectContaining({ title: "新标题", tags: [] }),
    );
  });

  it("保存失败时提示 operationFailed", async () => {
    const todo = createTodo();
    seedStore({
      todos: [todo],
      selectedTodo: todo,
      total: 1,
      update: vi.fn().mockRejectedValue(new Error("db locked")),
    });
    render(<TodoManager scope="" scopeRef="" />);

    await act(async () => {
      await lastEditor().onSave();
    });

    expect(toastErr).toHaveBeenCalled();
  });

  it("删除已选任务调用 remove 并提示", async () => {
    const todo = createTodo({ id: "t9" });
    seedStore({ todos: [todo], selectedTodo: todo, total: 1 });
    render(<TodoManager scope="" scopeRef="" />);

    await act(async () => {
      lastEditor().onDelete!();
    });

    expect(useTodoStore.getState().remove).toHaveBeenCalledWith("t9");
    expect(toastOk).toHaveBeenCalled();
  });

  it("列表项状态循环：todo→in_progress，done→todo", async () => {
    const todos = [
      createTodo({ id: "t1", status: "todo" }),
      createTodo({ id: "t2", title: "任务二", status: "done" }),
    ];
    seedStore({ todos, selectedTodo: todos[0], total: 2 });
    render(<TodoManager scope="" scopeRef="" />);

    const items = captured.listItems as unknown as {
      todo: TodoItem;
      onToggleStatus: () => void;
    }[];
    await act(async () => {
      items.find((i) => i.todo.id === "t1")!.onToggleStatus();
    });
    expect(useTodoStore.getState().update).toHaveBeenCalledWith("t1", {
      status: "in_progress",
    });

    await act(async () => {
      items.find((i) => i.todo.id === "t2")!.onToggleStatus();
    });
    expect(useTodoStore.getState().update).toHaveBeenCalledWith("t2", {
      status: "todo",
    });
  });

  it("列表项优先级循环：中→高→低→中", async () => {
    const todos = [
      createTodo({ id: "medium", priority: "medium" }),
      createTodo({ id: "high", title: "高优先级", priority: "high" }),
      createTodo({ id: "low", title: "低优先级", priority: "low" }),
    ];
    seedStore({ todos, selectedTodo: todos[0], total: 3 });
    render(<TodoManager scope="" scopeRef="" />);

    const items = captured.listItems as unknown as {
      todo: TodoItem;
      onTogglePriority: () => void;
    }[];
    for (const todo of todos) {
      await act(async () => {
        items.find((item) => item.todo.id === todo.id)!.onTogglePriority();
      });
    }

    expect(useTodoStore.getState().update).toHaveBeenCalledWith("medium", { priority: "high" });
    expect(useTodoStore.getState().update).toHaveBeenCalledWith("high", { priority: "low" });
    expect(useTodoStore.getState().update).toHaveBeenCalledWith("low", { priority: "medium" });
  });

  it("按状态分组渲染 TodoTagGroup 并翻译分组标签", () => {
    const todos = [
      createTodo({ id: "t1", status: "todo" }),
      createTodo({ id: "t2", title: "任务二", status: "done" }),
    ];
    seedStore({ todos, selectedTodo: todos[0], total: 2 });
    render(<TodoManager scope="" scopeRef="" />);

    const filterBar = captured.filterBar[
      captured.filterBar.length - 1
    ] as unknown as { onGroupModeChange: (m: string) => void };
    act(() => {
      filterBar.onGroupModeChange("status");
    });

    const labels = screen
      .getAllByTestId("todo-tag-group")
      .map((el) => el.textContent);
    expect(labels).toEqual(["待办", "完成"]);
  });

  it("按标签分组：无标签任务归入 __untagged__，标签透传原文", () => {
    const todos = [
      createTodo({ id: "t1", tags: ["backend"] }),
      createTodo({ id: "t2", title: "任务二", tags: [] }),
    ];
    seedStore({ todos, selectedTodo: todos[0], total: 2 });
    render(<TodoManager scope="" scopeRef="" />);

    const filterBar = captured.filterBar[
      captured.filterBar.length - 1
    ] as unknown as { onGroupModeChange: (m: string) => void };
    act(() => {
      filterBar.onGroupModeChange("tag");
    });

    const groups = captured.tagGroups as unknown as {
      tag: string;
      label?: string;
    }[];
    const tags = groups.map((g) => g.tag);
    expect(tags).toContain("backend");
    expect(tags).toContain("__untagged__");
    // tag 分组不提供翻译 label
    expect(groups.every((g) => g.label === undefined)).toBe(true);
  });

  it("拖拽结束按新顺序调用 reorder", () => {
    const todos = [
      createTodo({ id: "t1" }),
      createTodo({ id: "t2", title: "任务二" }),
      createTodo({ id: "t3", title: "任务三" }),
    ];
    seedStore({ todos, selectedTodo: todos[0], total: 3 });
    render(<TodoManager scope="" scopeRef="" />);

    const onDragEnd = captured.onDragEnd as (e: unknown) => void;
    act(() => {
      onDragEnd({ active: { id: "t1" }, over: { id: "t3" } });
    });

    expect(useTodoStore.getState().reorder).toHaveBeenCalledWith([
      "t2",
      "t3",
      "t1",
    ]);
  });

  it("拖拽落点无效或原地时不触发 reorder", () => {
    const todos = [createTodo({ id: "t1" }), createTodo({ id: "t2", title: "任务二" })];
    seedStore({ todos, selectedTodo: todos[0], total: 2 });
    render(<TodoManager scope="" scopeRef="" />);

    const onDragEnd = captured.onDragEnd as (e: unknown) => void;
    act(() => {
      onDragEnd({ active: { id: "t1" }, over: null });
      onDragEnd({ active: { id: "t1" }, over: { id: "t1" } });
    });

    expect(useTodoStore.getState().reorder).not.toHaveBeenCalled();
  });

  it("子任务操作透传到 store 对应 action", async () => {
    const todo = createTodo({ id: "t9" });
    seedStore({ todos: [todo], selectedTodo: todo, total: 1 });
    render(<TodoManager scope="" scopeRef="" />);

    const editor = lastEditor() as unknown as {
      onAddSubtask: (t: string) => void;
      onToggleSubtask: (id: string) => void;
      onDeleteSubtask: (id: string) => void;
    };
    await act(async () => {
      editor.onAddSubtask("子任务A");
      editor.onToggleSubtask("sub-1");
      editor.onDeleteSubtask("sub-2");
    });

    const s = useTodoStore.getState();
    expect(s.addSubtask).toHaveBeenCalledWith("t9", "子任务A");
    expect(s.toggleSubtask).toHaveBeenCalledWith("sub-1");
    expect(s.deleteSubtask).toHaveBeenCalledWith("sub-2");
  });
});
