import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SidebarTransition from "./SidebarTransition";

describe("SidebarTransition", () => {
  it("visible=false 时不挂载 children", () => {
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

  it("隐藏当帧即卸载，无过渡等待", () => {
    const { rerender } = render(
      <SidebarTransition visible>
        <div data-testid="sidebar-body" />
      </SidebarTransition>,
    );
    rerender(
      <SidebarTransition visible={false}>
        <div data-testid="sidebar-body" />
      </SidebarTransition>,
    );
    expect(screen.queryByTestId("sidebar-body")).toBeNull();
  });
});
