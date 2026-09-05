import { beforeEach, describe, expect, it } from "vitest";
import {
  SIDEBAR_FLYOUT_STORAGE_KEY,
  isSidebarFlyoutWidth,
  loadSidebarFlyoutOpen,
  saveSidebarFlyoutOpen,
} from "./sidebarFlyout";

describe("isSidebarFlyoutWidth", () => {
  it("1024px（lg）及以上为常驻档，以下为浮出档", () => {
    expect(isSidebarFlyoutWidth(1023)).toBe(true);
    expect(isSidebarFlyoutWidth(1024)).toBe(false);
    expect(isSidebarFlyoutWidth(500)).toBe(true);
    expect(isSidebarFlyoutWidth(1280)).toBe(false);
  });
});

describe("浮出层展开偏好持久化", () => {
  beforeEach(() => localStorage.removeItem(SIDEBAR_FLYOUT_STORAGE_KEY));

  it("无记录时默认收起", () => {
    expect(loadSidebarFlyoutOpen()).toBe(false);
  });

  it("写入后可读回，覆盖旧值", () => {
    saveSidebarFlyoutOpen(true);
    expect(loadSidebarFlyoutOpen()).toBe(true);
    saveSidebarFlyoutOpen(false);
    expect(loadSidebarFlyoutOpen()).toBe(false);
  });

  it("非法内容按默认收起处理", () => {
    localStorage.setItem(SIDEBAR_FLYOUT_STORAGE_KEY, "yes");
    expect(loadSidebarFlyoutOpen()).toBe(false);
  });
});
