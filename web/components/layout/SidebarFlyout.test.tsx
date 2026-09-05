import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SidebarFlyout from "./SidebarFlyout";

describe("SidebarFlyout", () => {
  it("open=false 时不渲染任何内容", () => {
    render(
      <SidebarFlyout open={false} onClose={() => {}}>
        <div data-testid="panel" />
      </SidebarFlyout>,
    );
    expect(screen.queryByTestId("sidebar-flyout")).toBeNull();
    expect(screen.queryByTestId("panel")).toBeNull();
  });

  it("open=true 时渲染面板与 scrim，点击 scrim 触发 onClose", () => {
    const onClose = vi.fn();
    render(
      <SidebarFlyout open onClose={onClose}>
        <div data-testid="panel" />
      </SidebarFlyout>,
    );
    expect(screen.getByTestId("panel")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("sidebar-flyout-scrim"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("浮出面板宽度受 85vw 上限约束，窄窗不盖满主区", () => {
    render(
      <SidebarFlyout open onClose={() => {}}>
        <div data-testid="panel" />
      </SidebarFlyout>,
    );
    const panel = screen.getByTestId("panel").parentElement as HTMLElement;
    expect(panel.style.maxWidth).toBe("85vw");
  });

  it("入场动画：面板 slide-in-from-left + fade，scrim 仅 fade，统一 --dur-slow + --ease-out", () => {
    render(
      <SidebarFlyout open onClose={() => {}}>
        <div data-testid="panel" />
      </SidebarFlyout>,
    );
    const scrim = screen.getByTestId("sidebar-flyout-scrim");
    expect(scrim.className).toContain("animate-in");
    expect(scrim.className).toContain("fade-in");
    expect(scrim.className).toContain("duration-[var(--dur-slow)]");
    expect(scrim.className).toContain("ease-[var(--ease-out)]");
    // scrim 不做位移（避免遮罩滑动感）
    expect(scrim.className).not.toContain("slide-in-from-left");

    const panel = screen.getByTestId("panel").parentElement as HTMLElement;
    expect(panel.className).toContain("animate-in");
    expect(panel.className).toContain("slide-in-from-left");
    expect(panel.className).toContain("fade-in");
    expect(panel.className).toContain("duration-[var(--dur-slow)]");
    // prefers-reduced-motion 降级由 index.css 全局规则兜底（keyframe 归零），
    // 该规则的存在性由 layoutMotion.test.ts 守护。
  });
});
