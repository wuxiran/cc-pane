import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GroupMode } from "./TodoFilterBar";
import TodoFilterBar from "./TodoFilterBar";

function renderBar(overrides: Partial<Parameters<typeof TodoFilterBar>[0]> = {}) {
  const props = {
    filterStatus: null,
    filterPriority: null,
    filterType: null,
    customTypes: [] as string[],
    searchText: "",
    groupMode: "none" as GroupMode,
    onStatusChange: vi.fn(),
    onPriorityChange: vi.fn(),
    onTypeChange: vi.fn(),
    onSearchChange: vi.fn(),
    onGroupModeChange: vi.fn(),
    ...overrides,
  };
  render(<TodoFilterBar {...props} />);
  return props;
}

describe("TodoFilterBar", () => {
  it("渲染状态、优先级与内置类型药丸", () => {
    renderBar();

    expect(screen.getByText("待办")).toBeVisible();
    expect(screen.getByText("进行中")).toBeVisible();
    expect(screen.getByText("完成")).toBeVisible();
    expect(screen.getByText("高")).toBeVisible();
    expect(screen.getByText("中")).toBeVisible();
    expect(screen.getByText("低")).toBeVisible();
    expect(screen.getByText("功能")).toBeVisible();
    expect(screen.getByText("缺陷")).toBeVisible();
    expect(screen.getByText("文档")).toBeVisible();
    expect(screen.getByText("杂务")).toBeVisible();
  });

  it("点击状态药丸回调对应的状态值", () => {
    const { onStatusChange } = renderBar();

    fireEvent.click(screen.getByText("进行中"));

    expect(onStatusChange).toHaveBeenCalledWith("in_progress");
  });

  it("点击优先级药丸回调对应的优先级值", () => {
    const { onPriorityChange } = renderBar();

    fireEvent.click(screen.getByText("高"));

    expect(onPriorityChange).toHaveBeenCalledWith("high");
  });

  it("点击类型药丸回调原始类型值而非翻译文案", () => {
    const { onTypeChange } = renderBar();

    fireEvent.click(screen.getByText("缺陷"));

    expect(onTypeChange).toHaveBeenCalledWith("bug");
  });

  it("自定义类型追加在内置类型之后且不重复内置项", () => {
    const { onTypeChange } = renderBar({ customTypes: ["research", "bug"] });

    // 内置 bug 只按翻译显示一次
    expect(screen.getAllByText("缺陷")).toHaveLength(1);
    fireEvent.click(screen.getByText("research"));

    expect(onTypeChange).toHaveBeenCalledWith("research");
  });

  it("输入搜索文本回调 onSearchChange", () => {
    const { onSearchChange } = renderBar();

    fireEvent.change(screen.getByPlaceholderText("搜索任务..."), {
      target: { value: "重构" },
    });

    expect(onSearchChange).toHaveBeenCalledWith("重构");
  });

  it("分组菜单选择后回调对应模式", async () => {
    const { onGroupModeChange } = renderBar();

    const user = userEvent.setup();
    await user.click(screen.getByTitle("分组模式"));
    await user.click(await screen.findByRole("menuitem", { name: "按标签分组" }));

    expect(onGroupModeChange).toHaveBeenCalledWith("tag");
  });

  it("当前激活的筛选药丸使用高亮样式", () => {
    renderBar({ filterStatus: "done" });

    expect(screen.getByText("完成")).toHaveClass("text-primary");
    expect(screen.getByText("待办")).not.toHaveClass("text-primary");
  });
});
