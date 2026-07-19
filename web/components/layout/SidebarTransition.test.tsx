import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SidebarTransition from "./SidebarTransition";

describe("SidebarTransition", () => {
  it("visible=false 初始渲染时不挂载 children", () => {
    render(
      <SidebarTransition visible={false}>
        <div data-testid="sidebar-body" />
      </SidebarTransition>,
    );
    expect(screen.queryByTestId("sidebar-body")).toBeNull();
  });

  it("visible=true 时挂载 children", () => {
    render(
      <SidebarTransition visible>
        <div data-testid="sidebar-body" />
      </SidebarTransition>,
    );
    expect(screen.getByTestId("sidebar-body")).toBeInTheDocument();
  });

  it("隐藏时保持挂载直到过渡结束才卸载（transitionend 后卸载）", () => {
    const { rerender, container } = render(
      <SidebarTransition visible>
        <div data-testid="sidebar-body" />
      </SidebarTransition>,
    );
    rerender(
      <SidebarTransition visible={false}>
        <div data-testid="sidebar-body" />
      </SidebarTransition>,
    );
    // 过渡未结束：仍挂载（watcher/焦点生命周期不被打断）
    expect(screen.getByTestId("sidebar-body")).toBeInTheDocument();

    const wrapper = container.firstElementChild!;
    act(() => {
      fireEvent.transitionEnd(wrapper);
    });
    expect(screen.queryByTestId("sidebar-body")).toBeNull();
  });

  it("过渡途中重新显示不卸载", () => {
    const { rerender, container } = render(
      <SidebarTransition visible>
        <div data-testid="sidebar-body" />
      </SidebarTransition>,
    );
    rerender(
      <SidebarTransition visible={false}>
        <div data-testid="sidebar-body" />
      </SidebarTransition>,
    );
    rerender(
      <SidebarTransition visible>
        <div data-testid="sidebar-body" />
      </SidebarTransition>,
    );
    const wrapper = container.firstElementChild!;
    act(() => {
      fireEvent.transitionEnd(wrapper);
    });
    // visible 已恢复 true：transitionend 不应卸载
    expect(screen.getByTestId("sidebar-body")).toBeInTheDocument();
  });
});
