import "@/i18n";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TodoItem } from "@/types";
import TodoOverview from "./TodoOverview";

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

function renderOverview(
  overrides: Partial<Parameters<typeof TodoOverview>[0]> = {},
) {
  const props = {
    todos: [] as TodoItem[],
    onSelectTodo: vi.fn(),
    onToggleStatus: vi.fn(),
    ...overrides,
  };
  render(<TodoOverview {...props} />);
  return props;
}

describe("TodoOverview", () => {
  it("renders one focused task and compact progress instead of empty category columns", () => {
    renderOverview({
      todos: [
        createTodo({ id: "working", title: "正在处理", status: "in_progress" }),
        createTodo({ id: "next", title: "下一项" }),
        createTodo({ id: "attention", title: "高优任务", priority: "high" }),
        createTodo({ id: "done", title: "刚刚完成", status: "done" }),
      ],
    });

    expect(screen.getByText("任务概览")).toBeVisible();
    expect(screen.getByText("3 个未完成")).toBeVisible();
    expect(screen.getByText("优先处理")).toBeVisible();
    expect(screen.getByText("任务进度")).toBeVisible();
    expect(screen.getByText("其他任务")).toBeVisible();
    expect(screen.queryByText("优先级分布")).not.toBeInTheDocument();
    expect(screen.queryByText("暂无")).not.toBeInTheDocument();
  });

  it("chooses the focus task by status, priority, and due date", () => {
    renderOverview({
      todos: [
        createTodo({ id: "low", title: "低优任务", priority: "low" }),
        createTodo({ id: "late", title: "稍后到期", dueDate: "2099-08-20T00:00:00Z" }),
        createTodo({ id: "early", title: "较早到期", dueDate: "2099-08-10T00:00:00Z" }),
      ],
    });

    expect(screen.getByTestId("todo-overview-focus-title")).toHaveTextContent("较早到期");
  });

  it("opens a task and toggles its status from the overview", () => {
    const todo = createTodo({ title: "可操作任务" });
    const props = renderOverview({ todos: [todo] });
    const focusSection = screen.getByText("优先处理").closest("section")!;

    fireEvent.click(within(focusSection).getByText("可操作任务").closest("button")!);
    expect(props.onSelectTodo).toHaveBeenCalledWith(todo);

    fireEvent.click(within(focusSection).getByRole("button", { name: "切换状态" }));
    expect(props.onToggleStatus).toHaveBeenCalledWith(todo);
  });

  it("shows a quiet empty state when there are no tasks", () => {
    renderOverview();

    expect(screen.getByText("暂无任务")).toBeVisible();
    expect(screen.getByText("0 个未完成")).toBeVisible();
    expect(screen.queryByTestId("todo-overview-task-title")).not.toBeInTheDocument();
  });
});
