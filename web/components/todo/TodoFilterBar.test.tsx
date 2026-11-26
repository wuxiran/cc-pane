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
  it("默认只显示搜索、筛选和更多操作", () => {
    renderBar();

    expect(screen.getByPlaceholderText("搜索任务...")).toBeVisible();
    expect(screen.getByRole("button", { name: "筛选" })).toBeVisible();
    expect(screen.getByRole("button", { name: "更多操作" })).toBeVisible();
    expect(screen.queryByText("进行中")).not.toBeInTheDocument();
  });

  it.each([
    ["状态", "进行中", "onStatusChange", "in_progress"],
    ["优先级", "高", "onPriorityChange", "high"],
    ["类型", "缺陷", "onTypeChange", "bug"],
  ] as const)("从筛选菜单设置%s", async (submenu, option, callback, expected) => {
    const props = renderBar();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "筛选" }));
    await user.hover(await screen.findByRole("menuitem", { name: submenu }));
    fireEvent.click(await screen.findByRole("menuitem", { name: option }));

    expect(props[callback]).toHaveBeenCalledWith(expected);
  });

  it("自定义类型追加在类型菜单且不重复内置项", async () => {
    const { onTypeChange } = renderBar({ customTypes: ["research", "bug"] });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "筛选" }));
    await user.hover(await screen.findByRole("menuitem", { name: "类型" }));
    expect(await screen.findAllByRole("menuitem", { name: "缺陷" })).toHaveLength(1);
    fireEvent.click(await screen.findByRole("menuitem", { name: "research" }));

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
    await user.click(screen.getByRole("button", { name: "更多操作" }));
    await user.hover(await screen.findByRole("menuitem", { name: "分组模式" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "按标签分组" }));

    expect(onGroupModeChange).toHaveBeenCalledWith("tag");
  });

  it("当前激活的筛选以简洁标签显示", () => {
    renderBar({ filterStatus: "done" });

    expect(screen.getByText("完成")).toBeVisible();
    expect(screen.getByRole("button", { name: /^筛选\s*1$/ })).toHaveTextContent("1");
  });
});
