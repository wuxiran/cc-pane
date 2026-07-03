import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TodoSubtask } from "@/types";
import TodoSubtaskList from "./TodoSubtaskList";

function createSubtask(overrides: Partial<TodoSubtask> = {}): TodoSubtask {
  return {
    id: "sub-1",
    todoId: "todo-1",
    title: "子任务一",
    completed: false,
    sortOrder: 0,
    createdAt: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

function renderList(subtasks: TodoSubtask[]) {
  const onToggle = vi.fn();
  const onDelete = vi.fn();
  const onAdd = vi.fn();
  render(
    <TodoSubtaskList
      subtasks={subtasks}
      onToggle={onToggle}
      onDelete={onDelete}
      onAdd={onAdd}
    />,
  );
  return { onToggle, onDelete, onAdd };
}

describe("TodoSubtaskList", () => {
  it("显示完成进度与百分比", () => {
    renderList([
      createSubtask({ id: "s1", completed: true }),
      createSubtask({ id: "s2", title: "子任务二" }),
    ]);

    expect(screen.getByText("1/2 完成")).toBeVisible();
    expect(screen.getByText(/50\s*%/)).toBeVisible();
  });

  it("无子任务时不渲染进度区", () => {
    renderList([]);

    expect(screen.queryByText(/完成/)).not.toBeInTheDocument();
  });

  it("已完成子任务标题带删除线", () => {
    renderList([createSubtask({ completed: true })]);

    expect(screen.getByText("子任务一")).toHaveClass("line-through");
  });

  it("点击 checkbox 触发 onToggle", () => {
    const { onToggle } = renderList([createSubtask({ id: "s1" })]);

    const row = screen.getByText("子任务一").closest("div")!;
    fireEvent.click(row.querySelector("button")!);

    expect(onToggle).toHaveBeenCalledWith("s1");
  });

  it("点击删除按钮触发 onDelete", () => {
    const { onDelete } = renderList([createSubtask({ id: "s1" })]);

    const row = screen.getByText("子任务一").closest("div")!;
    const buttons = row.querySelectorAll("button");
    fireEvent.click(buttons[buttons.length - 1]);

    expect(onDelete).toHaveBeenCalledWith("s1");
  });

  it("回车添加子任务并清空输入、去除首尾空格", () => {
    const { onAdd } = renderList([]);
    const input = screen.getByPlaceholderText("添加子任务 (按回车保存)...");

    fireEvent.change(input, { target: { value: "  新子任务  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onAdd).toHaveBeenCalledWith("新子任务");
    expect(input).toHaveValue("");
  });

  it("输入为空白时添加按钮禁用且回车不触发 onAdd", () => {
    const { onAdd } = renderList([]);
    const input = screen.getByPlaceholderText("添加子任务 (按回车保存)...");

    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onAdd).not.toHaveBeenCalled();
  });

  it("点击加号按钮添加子任务", () => {
    const { onAdd } = renderList([]);
    const input = screen.getByPlaceholderText("添加子任务 (按回车保存)...");

    fireEvent.change(input, { target: { value: "按钮添加" } });
    // 输入后加号按钮是输入区唯一可用按钮
    const addButton = screen.getByRole("button");
    fireEvent.click(addButton);

    expect(onAdd).toHaveBeenCalledWith("按钮添加");
  });
});
