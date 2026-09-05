import "@/i18n";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ResponsiveRightDock from "./ResponsiveRightDock";
import { useRightDockStore } from "@/stores/useRightDockStore";

// RightDock 本体有大量 store/视图依赖，这里桩掉，只验证外壳的分档渲染形态与传参。
const rightDockProps = vi.hoisted(() => ({ current: null as null | { overlay?: boolean } }));
vi.mock("@/components/rightdock/RightDock", () => ({
  default: (props: { overlay?: boolean }) => {
    rightDockProps.current = props;
    return <div data-testid="right-dock-stub" data-overlay={String(props.overlay === true)} />;
  },
}));

function setWidth(width: number) {
  act(() => {
    window.innerWidth = width;
    window.dispatchEvent(new Event("resize"));
  });
}

describe("ResponsiveRightDock", () => {
  beforeEach(() => {
    useRightDockStore.setState({ visible: false, width: 340 });
  });

  afterEach(() => {
    setWidth(1024);
    useRightDockStore.setState({ visible: false });
  });

  it("宽档（>=1024）：常驻渲染，非浮层模式", () => {
    setWidth(1280);
    useRightDockStore.setState({ visible: true });
    render(<ResponsiveRightDock onOpenTerminal={() => {}} />);
    expect(screen.getByTestId("right-dock-stub")).toBeInTheDocument();
    expect(rightDockProps.current?.overlay).not.toBe(true);
  });

  it("窄档（<1024）：visible=false 时不渲染面板（等触发）", () => {
    setWidth(800);
    render(<ResponsiveRightDock onOpenTerminal={() => {}} />);
    expect(screen.queryByTestId("right-dock-stub")).toBeNull();
  });

  it("窄档：visible=true 时以浮层 Sheet 打开，RightDock 收到 overlay", () => {
    setWidth(800);
    useRightDockStore.setState({ visible: true });
    render(<ResponsiveRightDock onOpenTerminal={() => {}} />);
    expect(screen.getByTestId("right-dock-stub")).toBeInTheDocument();
    expect(rightDockProps.current?.overlay).toBe(true);
  });

  it("窄档 Sheet 宽度跟随已持久化的面板宽度且不超过 85vw", () => {
    setWidth(800);
    useRightDockStore.setState({ visible: true, width: 400 });
    render(<ResponsiveRightDock onOpenTerminal={() => {}} />);
    const sheet = document.querySelector("[data-slot='sheet-content']") as HTMLElement;
    expect(sheet.style.width).toBe("400px");
    expect(sheet.style.maxWidth).toBe("85vw");
  });
});
