import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TodoItem } from "@/types";
import TodoTagGroup from "./TodoTagGroup";

function createTodo(overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    id: "todo-1",
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

function renderGroup(overrides: Partial<Parameters<typeof TodoTagGroup>[0]> = {}) {
  const props = {
    tag: "backend",
    todos: [
      createTodo({ id: "t1", title: "任务一", status: "done" }),
      createTodo({ id: "t2", title: "任务二" }),
    ],
    onSelect: vi.fn(),
    onToggleStatus: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
  render(<TodoTagGroup {...props} />);
  return props;
}

describe("TodoTagGroup", () => {
  it("显示分组名与完成计数，默认展开列出任务", () => {
    renderGroup();

    expect(screen.getByText("backend")).toBeVisible();
    expect(screen.getByText("1/2")).toBeVisible();
    expect(screen.getByText("任务一")).toBeInTheDocument();
    expect(screen.getByText("任务二")).toBeInTheDocument();
  });

  it("优先使用传入的 label 显示分组名", () => {
    renderGroup({ tag: "in_progress", label: "进行中" });

    expect(screen.getByText("进行中")).toBeVisible();
    expect(screen.queryByText("in_progress")).not.toBeInTheDocument();
  });

  it("__untagged__ 分组显示为未标记", () => {
    renderGroup({ tag: "__untagged__" });

    expect(screen.getByText("未标记")).toBeVisible();
  });

  it("点击分组头折叠任务列表", () => {
    renderGroup();

    fireEvent.click(screen.getByText("backend"));

    expect(screen.queryByText("任务一")).not.toBeInTheDocument();
  });

  it("defaultOpen 为 false 时初始折叠", () => {
    renderGroup({ defaultOpen: false });

    expect(screen.queryByText("任务一")).not.toBeInTheDocument();
  });

  it("点击任务项回调 onSelect 该任务", () => {
    const { onSelect } = renderGroup();

    fireEvent.click(screen.getByText("任务二"));

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "t2" }));
  });

  it("点击任务的状态按钮回调 onToggleStatus", () => {
    const { onToggleStatus, onSelect } = renderGroup();

    fireEvent.click(screen.getAllByTitle("切换状态")[1]);

    expect(onToggleStatus).toHaveBeenCalledWith(expect.objectContaining({ id: "t2" }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("点击删除按钮回调 onDelete 且不冒泡选中", () => {
    const { onDelete, onSelect } = renderGroup();

    const item = screen.getByText("任务一").closest(".group\\/item")!;
    fireEvent.click(item.querySelector(".absolute button")!);

    expect(onDelete).toHaveBeenCalledWith("t1");
    expect(onSelect).not.toHaveBeenCalled();
  });
});
