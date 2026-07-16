import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTodoStore } from "@/stores";
import type { TodoItem, TodoStats } from "@/types";
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

const STATS: TodoStats = {
  total: 10,
  byStatus: { todo: 4, in_progress: 3, done: 3 },
  byScope: { global: 10 },
  byPriority: { high: 2, medium: 5, low: 3 },
  overdue: 1,
};

function renderOverview(
  overrides: Partial<Parameters<typeof TodoOverview>[0]> = {},
) {
  const props = {
    todos: [] as TodoItem[],
    onSelectTodo: vi.fn(),
    onCreateNew: vi.fn(),
    ...overrides,
  };
  render(<TodoOverview {...props} />);
  return props;
}

describe("TodoOverview", () => {
  beforeEach(() => {
    useTodoStore.setState({ stats: STATS, loadStats: vi.fn() });
  });

  it("挂载时调用 loadStats", () => {
    renderOverview();

    expect(useTodoStore.getState().loadStats).toHaveBeenCalledTimes(1);
  });

  it("按 stats 渲染各状态数量卡片", () => {
    renderOverview();

    expect(screen.getByText("任务概览")).toBeVisible();
    expect(screen.getByText("总计")).toBeVisible();
    expect(screen.getByText("10")).toBeVisible();
    expect(screen.getByText("4")).toBeVisible();
    // in_progress 与 low 均为 3，出现在卡片与优先级条两处
    expect(screen.getAllByText("3").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("已逾期")).toBeVisible();
    expect(screen.getByText("1")).toBeVisible();
  });

  it("stats 为 null 时总计回退为 todos 长度，其余为 0", () => {
    useTodoStore.setState({ stats: null });
    renderOverview({ todos: [createTodo(), createTodo({ id: "t2" })] });

    const totalCard = screen.getByText("总计").parentElement!;
    expect(totalCard.querySelector("p")!.textContent).toBe("2");
  });

  it("优先级分布条按 count/total 计算宽度", () => {
    renderOverview();

    expect(screen.getByText("优先级分布")).toBeVisible();
    const highLabel = screen.getByText("高");
    const bar = highLabel.parentElement!.querySelector(
      "[class*='--app-status-danger']",
    ) as HTMLElement;
    expect(bar.style.width).toBe("20%"); // 2/10
  });

  it("最近更新按 updatedAt 倒序取前 5 条，点击回调 onSelectTodo", () => {
    const todos = Array.from({ length: 7 }, (_, i) =>
      createTodo({
        id: `t${i}`,
        title: `任务${i}`,
        updatedAt: `2026-06-0${i + 1}T00:00:00Z`,
      }),
    );
    const props = renderOverview({ todos });

    const recentSection = screen.getByText("最近更新").parentElement!;
    const buttons = recentSection.querySelectorAll("button");
    expect(buttons).toHaveLength(5);
    // 最新的 t6 排第一
    expect(buttons[0].textContent).toBe("任务6");
    expect(buttons[4].textContent).toBe("任务2");

    fireEvent.click(buttons[0]);
    expect(props.onSelectTodo).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t6" }),
    );
  });

  it("todos 为空时不渲染最近更新区块", () => {
    renderOverview({ todos: [] });

    expect(screen.queryByText("最近更新")).not.toBeInTheDocument();
  });

  it("点击新建任务按钮回调 onCreateNew", () => {
    const props = renderOverview();

    fireEvent.click(screen.getByText("新建任务"));

    expect(props.onCreateNew).toHaveBeenCalledTimes(1);
  });
});
