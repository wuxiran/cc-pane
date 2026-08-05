// B2-02 上报层测试。
//
// 核心是**与现有三 props 逐字等价**：双写期两条路并存，若映射就不一致，
// B2-06 的漂移断言会一直误报，等于白做。
import { describe, it, expect, beforeEach } from "vitest";
import { paneTabVisibility } from "./useReportPaneVisibility";
import { useTabViewStateStore } from "@/stores/useTabViewStateStore";

beforeEach(() => {
  useTabViewStateStore.setState({ views: {}, aggregate: {} });
});

/** 现状三 props 的算法（Panel.tsx:452-455 原样照抄，作为等价性基准）。 */
function legacyProps(
  tabId: string,
  activeTabId: string | undefined,
  layoutVisible: boolean,
  isActivePane: boolean,
) {
  return {
    isVisible: layoutVisible && tabId === activeTabId,
    isActive: layoutVisible && tabId === activeTabId && isActivePane,
    layoutActive: layoutVisible,
  };
}

describe("paneTabVisibility 与三 props 等价", () => {
  const cases = [
    { layoutVisible: true, isActive: true, isCurrent: true, expected: "active" },
    { layoutVisible: true, isActive: false, isCurrent: true, expected: "visible" },
    { layoutVisible: true, isActive: true, isCurrent: false, expected: "hidden" },
    { layoutVisible: false, isActive: true, isCurrent: true, expected: "hidden" },
    { layoutVisible: false, isActive: false, isCurrent: false, expected: "hidden" },
  ] as const;

  it.each(cases)(
    "layoutVisible=$layoutVisible activePane=$isActive current=$isCurrent → $expected",
    ({ layoutVisible, isActive, isCurrent, expected }) => {
      const activeTabId = isCurrent ? "t1" : "other";
      const got = paneTabVisibility("t1", activeTabId, layoutVisible, isActive);
      expect(got).toBe(expected);

      // 与旧 props 交叉验证：active ⟺ isActive；visible/active ⟺ isVisible
      const legacy = legacyProps("t1", activeTabId, layoutVisible, isActive);
      expect(got === "active").toBe(legacy.isActive);
      expect(got !== "hidden").toBe(legacy.isVisible);
    },
  );

  it("非当前标签恒 hidden，无论 pane 是否聚焦", () => {
    expect(paneTabVisibility("t2", "t1", true, true)).toBe("hidden");
    expect(paneTabVisibility("t2", "t1", true, false)).toBe("hidden");
  });

  it("布局不可见时恒 hidden（layoutActive=false 覆盖一切）", () => {
    expect(paneTabVisibility("t1", "t1", false, true)).toBe("hidden");
  });

  it("activeTabId 缺失（空 pane）时恒 hidden", () => {
    expect(paneTabVisibility("t1", undefined, true, true)).toBe("hidden");
  });
});
