import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useResponsiveSidebar } from "./useResponsiveSidebar";
import { SIDEBAR_FLYOUT_STORAGE_KEY } from "@/lib/sidebarFlyout";
import { useActivityBarStore } from "@/stores/useActivityBarStore";

function setWidth(width: number) {
  act(() => {
    window.innerWidth = width;
    window.dispatchEvent(new Event("resize"));
  });
}

function sidebarVisible() {
  return useActivityBarStore.getState().sidebarVisible;
}

describe("useResponsiveSidebar", () => {
  beforeEach(() => {
    localStorage.removeItem(SIDEBAR_FLYOUT_STORAGE_KEY);
    useActivityBarStore.setState({ sidebarVisible: true });
    setWidth(1280);
  });

  afterEach(() => {
    setWidth(1024);
    useActivityBarStore.setState({ sidebarVisible: true });
    localStorage.removeItem(SIDEBAR_FLYOUT_STORAGE_KEY);
  });

  it("宽档不干预既有 sidebarVisible", () => {
    const { result } = renderHook(() => useResponsiveSidebar());
    expect(result.current.isFlyout).toBe(false);
    expect(sidebarVisible()).toBe(true);
  });

  it("进入窄档默认收起（浮出层关闭），宽档偏好被记住", () => {
    const { result } = renderHook(() => useResponsiveSidebar());
    setWidth(800);
    expect(result.current.isFlyout).toBe(true);
    expect(sidebarVisible()).toBe(false);
  });

  it("窄档内的展开/收起写入 localStorage，且再次进入窄档时读回", () => {
    const { result, unmount } = renderHook(() => useResponsiveSidebar());
    setWidth(800);
    // 模拟 ActivityBar 图标点击展开浮出层
    act(() => useActivityBarStore.getState().setSidebarVisible(true));
    expect(localStorage.getItem(SIDEBAR_FLYOUT_STORAGE_KEY)).toBe("1");
    unmount();

    // 新一轮会话（重置 store 模拟宽档偏好被持久化为收起）仍读回窄档展开偏好
    useActivityBarStore.setState({ sidebarVisible: false });
    renderHook(() => useResponsiveSidebar());
    expect(result.current.isFlyout).toBe(true);
    expect(sidebarVisible()).toBe(true);
  });

  it("回到宽档恢复进入窄档前的宽档偏好", () => {
    renderHook(() => useResponsiveSidebar());
    // 宽档现状：展开
    expect(sidebarVisible()).toBe(true);
    setWidth(800);
    expect(sidebarVisible()).toBe(false);
    // 窄档里保持收起，回到宽档应恢复展开
    setWidth(1280);
    expect(sidebarVisible()).toBe(true);
  });

  it("宽档偏好为收起时，往返窄档后仍是收起", () => {
    useActivityBarStore.setState({ sidebarVisible: false });
    renderHook(() => useResponsiveSidebar());
    setWidth(800);
    act(() => useActivityBarStore.getState().setSidebarVisible(true));
    setWidth(1280);
    expect(sidebarVisible()).toBe(false);
  });
});
