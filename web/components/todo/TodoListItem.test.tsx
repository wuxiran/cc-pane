import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TodoItem, TodoSubtask } from "@/types";
import TodoListItem, { SortableTodoListItem } from "./TodoListItem";

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

function createSubtask(overrides: Partial<TodoSubtask> = {}): TodoSubtask {
  return {
    id: "sub-1",
    todoId: "todo-1",
    title: "子任务",
    completed: false,
    sortOrder: 0,
    createdAt: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

function createTodo(overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    id: "todo-1",
    title: "写测试",
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

function renderItem(todo: TodoItem, extra: { onToggleMyDay?: () => void } = {}) {
  const onSelect = vi.fn();
  const onToggleStatus = vi.fn();
  render(
    <TodoListItem
      todo={todo}
      isSelected={false}
      onSelect={onSelect}
      onToggleStatus={onToggleStatus}
      onToggleMyDay={extra.onToggleMyDay}
    />,
  );
  return { onSelect, onToggleStatus };
}

describe("TodoListItem", () => {
  it("渲染标题、类型 badge 与前 3 个标签，超出显示 +N", () => {
    renderItem(
      createTodo({
        title: "整理文档",
        todoType: "docs",
        tags: ["a", "b", "c", "d", "e"],
      }),
    );

    expect(screen.getByText("整理文档")).toBeVisible();
    expect(screen.getByText("docs")).toBeVisible();
    expect(screen.getByText("a")).toBeVisible();
    expect(screen.getByText("b")).toBeVisible();
    expect(screen.getByText("c")).toBeVisible();
    expect(screen.queryByText("d")).not.toBeInTheDocument();
    expect(screen.getByText("+2")).toBeVisible();
  });

  it("显示子任务完成进度", () => {
    renderItem(
      createTodo({
        subtasks: [
          createSubtask({ id: "s1", completed: true }),
          createSubtask({ id: "s2" }),
          createSubtask({ id: "s3" }),
        ],
      }),
    );

    expect(screen.getByText("1/3")).toBeVisible();
  });

  it("到期日已过且未完成时以 overdue 样式显示", () => {
    renderItem(createTodo({ dueDate: "2020-01-01T00:00:00Z" }));

    const due = screen.getByText(new Date("2020-01-01T00:00:00Z").toLocaleDateString());
    expect(due).toHaveClass("text-red-500");
  });

  it("已完成任务的过期到期日不标红且标题带删除线", () => {
    renderItem(createTodo({ status: "done", dueDate: "2020-01-01T00:00:00Z" }));

    const due = screen.getByText(new Date("2020-01-01T00:00:00Z").toLocaleDateString());
    expect(due).not.toHaveClass("text-red-500");
    expect(screen.getByText("写测试")).toHaveClass("line-through");
  });

  it("点击条目触发 onSelect", () => {
    const { onSelect } = renderItem(createTodo());

    fireEvent.click(screen.getByText("写测试"));

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("点击状态按钮只触发 onToggleStatus，不冒泡到 onSelect", () => {
    const { onSelect, onToggleStatus } = renderItem(createTodo());

    fireEvent.click(screen.getByTitle("切换状态"));

    expect(onToggleStatus).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("提供 onToggleMyDay 时点击太阳按钮触发且不冒泡", () => {
    const onToggleMyDay = vi.fn();
    const { onSelect } = renderItem(createTodo(), { onToggleMyDay });

    fireEvent.click(screen.getByTitle("添加到我的一天"));

    expect(onToggleMyDay).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("已在我的一天时按钮提示为移除", () => {
    renderItem(createTodo({ myDay: true }), { onToggleMyDay: vi.fn() });

    expect(screen.getByTitle("从我的一天移除")).toBeInTheDocument();
  });

  it("未提供 onToggleMyDay 时不渲染太阳按钮", () => {
    renderItem(createTodo());

    expect(screen.queryByTitle("添加到我的一天")).not.toBeInTheDocument();
  });
});

describe("SortableTodoListItem", () => {
  it("点击删除按钮以 id 触发 onDelete 且不冒泡到 onSelect", () => {
    const onDelete = vi.fn();
    const onSelect = vi.fn();
    const { container } = render(
      <SortableTodoListItem
        todo={createTodo({ id: "todo-9" })}
        isSelected={false}
        onSelect={onSelect}
        onToggleStatus={vi.fn()}
        onDelete={onDelete}
      />,
    );

    const buttons = container.querySelectorAll("button");
    const deleteButton = buttons[buttons.length - 1];
    fireEvent.click(deleteButton);

    expect(onDelete).toHaveBeenCalledWith("todo-9");
    expect(onSelect).not.toHaveBeenCalled();
  });
});
