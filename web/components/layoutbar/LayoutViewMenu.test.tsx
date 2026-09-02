import "@/i18n";
import type { ReactElement } from "react";
import { fireEvent, render as rtlRender, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import LayoutViewMenu from "./LayoutViewMenu";
import { useActivityBarStore, useCanvasDisplayStore, useLayoutUiStore } from "@/stores";

const render = (ui: ReactElement) => rtlRender(<TooltipProvider>{ui}</TooltipProvider>);

function resetStores() {
  useLayoutUiStore.setState({
    switcherMode: "topbar",
    layoutBarDensity: "comfortable",
  });
  useCanvasDisplayStore.setState({ mode: "panel", animationIntensity: "full" });
  useActivityBarStore.setState({
    activeView: "explorer",
    sidebarVisible: true,
    activityBarVisible: true,
    appViewMode: "home",
    orchestrationOverlayOpen: false,
  });
}

function trigger() {
  return screen.getByTestId("layout-view-trigger");
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(trigger());
  return screen.findByRole("menu", { name: /布局视图选项|Layout view options/i });
}

describe("LayoutViewMenu", () => {
  beforeEach(() => {
    resetStores();
  });

  it("打开后列出三个低频视图动作，再次点击触发器关闭", async () => {
    const user = userEvent.setup();
    render(<LayoutViewMenu />);

    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    const menu = await openMenu(user);
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(3);

    await user.click(trigger());
    expect(screen.queryByRole("menu", { name: /布局视图选项|Layout view options/i })).not.toBeInTheDocument();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });

  it("点击浮层外关闭，并把 Escape 关闭后的焦点还给触发器", async () => {
    const user = userEvent.setup();
    render(
      <>
        <LayoutViewMenu />
        <button type="button">外部按钮</button>
      </>,
    );

    const menu = await openMenu(user);
    expect(menu).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();

    await openMenu(user);
    await user.click(screen.getByRole("button", { name: "外部按钮" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("用上下方向键循环菜单项，Home/End 可跳到首尾", async () => {
    const user = userEvent.setup();
    render(<LayoutViewMenu />);

    const menu = await openMenu(user);
    const items = within(menu).getAllByRole("menuitem");
    expect(menu).toHaveFocus();

    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(items[2]).toHaveFocus();
    fireEvent.keyDown(document, { key: "Home" });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(document, { key: "End" });
    expect(items[2]).toHaveFocus();
  });

  it("切换布局条位置动作更新 store 并在菜单关闭后反映下一条文案", async () => {
    const user = userEvent.setup();
    render(<LayoutViewMenu />);

    let menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: /切回左下角布局器|Move back to corner switcher/i }));
    expect(useLayoutUiStore.getState().switcherMode).toBe("corner");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    menu = await openMenu(user);
    expect(within(menu).getByRole("menuitem", { name: /切到顶部布局条|Switch to top layout bar/i })).toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitem", { name: /切到顶部布局条|Switch to top layout bar/i }));
    expect(useLayoutUiStore.getState().switcherMode).toBe("topbar");
  });

  it("密度动作在舒适/紧凑两档之间切换", async () => {
    const user = userEvent.setup();
    render(<LayoutViewMenu />);

    let menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: /切换到紧凑档|Switch to compact density/i }));
    expect(useLayoutUiStore.getState().layoutBarDensity).toBe("compact");

    menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: /切换到舒适档|Switch to comfortable density/i }));
    expect(useLayoutUiStore.getState().layoutBarDensity).toBe("comfortable");
  });

  it("Canvas 动作切换显示模式并确保回到 panes 主视图", async () => {
    const user = userEvent.setup();
    useActivityBarStore.setState({ appViewMode: "home" });
    render(<LayoutViewMenu />);

    let menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: /显示终端画布|Show terminal canvas/i }));
    expect(useCanvasDisplayStore.getState().mode).toBe("canvas");
    expect(useActivityBarStore.getState().appViewMode).toBe("panes");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: /隐藏终端画布|Hide terminal canvas/i }));
    expect(useCanvasDisplayStore.getState().mode).toBe("panel");
    expect(useActivityBarStore.getState().appViewMode).toBe("panes");
  });
});
