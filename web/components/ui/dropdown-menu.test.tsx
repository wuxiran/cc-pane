import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";

function renderMenu(trigger: ReactNode) {
  return render(
    <DropdownMenu>
      {trigger}
      <DropdownMenuContent>
        <DropdownMenuItem>Alpha 动作</DropdownMenuItem>
        <DropdownMenuItem>Beta 动作</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>,
  );
}

describe("DropdownMenu 触发器 aria 契约（对照 Radix 官方 a11y 清单）", () => {
  it("默认触发器渲染 button，Radix 自动提供 haspopup/expanded", () => {
    renderMenu(<DropdownMenuTrigger>打开菜单</DropdownMenuTrigger>);

    const trigger = screen.getByRole("button", { name: "打开菜单" });
    expect(trigger).toHaveAttribute("type", "button");
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("双层 asChild（TooltipTrigger > DropdownMenuTrigger > button）合并不丢属性", () => {
    // ThemeQuickMenu 的实际结构：Slot 链必须把 Radix 的 aria 与显式 aria-label
    // 合并到同一个最终 button 上，任何一层丢失都会让 UIA 树里出现无名/无态节点。
    render(
      <TooltipProvider>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button aria-label="选择配色主题">
                  <svg aria-hidden="true" data-testid="palette-icon" />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>选择配色主题</p>
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent>
            <DropdownMenuItem>深色主题</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TooltipProvider>,
    );

    const trigger = screen.getByRole("button", { name: "选择配色主题" });
    expect(trigger).toHaveAttribute("type", "button");
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toContainElement(screen.getByTestId("palette-icon"));
  });

  it("键盘 ArrowDown 打开、aria-expanded 联动、Esc 关闭", async () => {
    renderMenu(<DropdownMenuTrigger>打开菜单</DropdownMenuTrigger>);

    const trigger = screen.getByRole("button", { name: "打开菜单" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("键盘 Enter 打开后 Type-ahead 按首字母聚焦菜单项", async () => {
    renderMenu(<DropdownMenuTrigger>打开菜单</DropdownMenuTrigger>);

    const trigger = screen.getByRole("button", { name: "打开菜单" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    const menu = await screen.findByRole("menu");

    fireEvent.keyDown(menu, { key: "b" });
    await waitFor(() => {
      expect(document.activeElement).toHaveTextContent("Beta 动作");
    });
  });

  it("固化上游行为：合成 click 不打开菜单，pointerdown 才是打开入口", () => {
    // UIA Invoke/AXPress 在 Chromium/WebView2 只派发 click（无 pointerdown 序列），
    // 而 Radix DropdownMenuTrigger 仅在 onPointerDown 打开——这是状态栏下拉对
    // AXPress/AXToggle 不响应、坐标点击正常的根因。若 Radix 上游未来改为 click 也可
    // 打开，本测试会失败，提醒同步更新 docs/accessibility-notes.md。
    renderMenu(<DropdownMenuTrigger>打开菜单</DropdownMenuTrigger>);

    const trigger = screen.getByRole("button", { name: "打开菜单" });
    fireEvent.click(trigger);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    return waitFor(() => {
      expect(screen.getByRole("menu")).toBeInTheDocument();
    });
  });
});
