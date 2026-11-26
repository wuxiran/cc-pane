// 上报层测试：paneTabVisibility 的三档真值表是**规格本身**——
// 它是 primary 视图的唯一写侧，读侧（TerminalView/Browser/状态栏）全按
// 「hidden 即不可见、active 即焦点」消费，这张表变了整条可见性链一起变。
import { describe, it, expect, beforeEach } from "vitest";
import { paneTabVisibility } from "./useReportPaneVisibility";
import { useTabViewStateStore } from "@/stores/useTabViewStateStore";

beforeEach(() => {
  useTabViewStateStore.setState({ views: {}, aggregate: {} });
});

describe("paneTabVisibility 三档真值表", () => {
  const cases = [
    { layoutVisible: true, isActive: true, isCurrent: true, expected: "active" },
    { layoutVisible: true, isActive: false, isCurrent: true, expected: "visible" },
    { layoutVisible: true, isActive: true, isCurrent: false, expected: "hidden" },
    { layoutVisible: true, isActive: false, isCurrent: false, expected: "hidden" },
    { layoutVisible: false, isActive: true, isCurrent: true, expected: "hidden" },
    { layoutVisible: false, isActive: false, isCurrent: false, expected: "hidden" },
  ] as const;

  it.each(cases)(
    "layoutVisible=$layoutVisible activePane=$isActive current=$isCurrent → $expected",
    ({ layoutVisible, isActive, isCurrent, expected }) => {
      const activeTabId = isCurrent ? "t1" : "other";
      const got = paneTabVisibility("t1", activeTabId, layoutVisible, isActive);
      expect(got).toBe(expected);
    },
  );

  it("activeTabId 缺失（空 pane）时恒 hidden", () => {
    expect(paneTabVisibility("t1", undefined, true, true)).toBe("hidden");
  });
});

// B2-08「非终端 contentType 也有 primary 记录」由 Panel.test 的可见性用例在真实挂载下断言
describe("聚合条目的存在性", () => {
  it("缺记录与全部隐藏在聚合上必须可区分", () => {
    const { reportView } = useTabViewStateStore.getState();
    reportView("known", "primary", "hidden");

    // 有记录但隐藏：聚合条目存在
    expect(useTabViewStateStore.getState().aggregate["known"]).toBeDefined();
    // 从未上报：聚合条目不存在（消费方走安全默认）
    expect(useTabViewStateStore.getState().aggregate["unknown"]).toBeUndefined();
  });
});
