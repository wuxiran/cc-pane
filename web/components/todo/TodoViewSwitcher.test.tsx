import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import TodoViewSwitcher from "./TodoViewSwitcher";

function renderSwitcher(overrides: Partial<Parameters<typeof TodoViewSwitcher>[0]> = {}) {
  const props = {
    viewMode: "all" as const,
    activeScope: null,
    onViewModeChange: vi.fn(),
    onScopeChange: vi.fn(),
    ...overrides,
  };
  render(<TodoViewSwitcher {...props} />);
  return props;
}

describe("TodoViewSwitcher", () => {
  it("keeps all task views and scopes in the title menu", async () => {
    renderSwitcher();
    const user = userEvent.setup();

    expect(screen.getByRole("button", { name: "全部任务" })).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: "收件箱" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "全部任务" }));

    expect(await screen.findByRole("menuitem", { name: "收件箱" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "我的一天" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "已逾期" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "全局" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "脚本" })).toBeVisible();
  });

  it("selecting all tasks clears the scope", async () => {
    const props = renderSwitcher({ viewMode: "my_day", activeScope: "project" });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "我的一天" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "全部任务" }));

    expect(props.onViewModeChange).toHaveBeenCalledWith("all");
    expect(props.onScopeChange).toHaveBeenCalledWith(null);
  });

  it("selecting a work view keeps the existing scope context", async () => {
    const props = renderSwitcher({ activeScope: "project" });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "项目" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "我的一天" }));

    expect(props.onViewModeChange).toHaveBeenCalledWith("my_day");
    expect(props.onScopeChange).not.toHaveBeenCalled();
  });

  it("selecting a scope switches back to the all view", async () => {
    const props = renderSwitcher({ viewMode: "overdue" });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "已逾期" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "脚本" }));

    expect(props.onViewModeChange).toHaveBeenCalledWith("all");
    expect(props.onScopeChange).toHaveBeenCalledWith("temp_script");
  });

  it("shows counts beside the corresponding views", async () => {
    renderSwitcher({
      stats: { total: 7, inbox: 2, myDay: 1, overdue: 3 } as never,
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "全部任务" }));

    expect(await screen.findByRole("menuitem", { name: /全部任务/ })).toHaveTextContent("7");
    expect(screen.getByRole("menuitem", { name: /收件箱/ })).toHaveTextContent("2");
    expect(screen.getByRole("menuitem", { name: /我的一天/ })).toHaveTextContent("1");
    expect(screen.getByRole("menuitem", { name: /已逾期/ })).toHaveTextContent("3");
  });
});
