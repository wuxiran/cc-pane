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

describe("五种无可见性 props 的 contentType 也有记录（B2-08）", () => {
  it("上报覆盖 pane 内全部 tab，与 contentType 无关", () => {
    const { reportView } = useTabViewStateStore.getState();
    // Panel 的上报按 tab 列表逐个走，不看 contentType——
    // editor/file-explorer/mcp-config/skill-manager/memory-manager 收不到
    // 可见性 props，但它们的记录由 Panel 统一写入。
    for (const id of ["editor-1", "explorer-1", "mcp-1", "skill-1", "memory-1"]) {
      reportView(id, "primary", "hidden");
    }
    reportView("terminal-1", "primary", "active");

    const state = useTabViewStateStore.getState();
    for (const id of ["editor-1", "explorer-1", "mcp-1", "skill-1", "memory-1"]) {
      expect(state.getViewVisibility(id, "primary")).toBe("hidden");
      expect(state.aggregate[id]?.anyVisible).toBe(false);
    }
    expect(state.aggregate["terminal-1"]?.anyActive).toBe(true);
  });

  it("缺记录与全部隐藏在聚合上必须可区分", () => {
    const { reportView } = useTabViewStateStore.getState();
    reportView("known", "primary", "hidden");

    // 有记录但隐藏：聚合条目存在
    expect(useTabViewStateStore.getState().aggregate["known"]).toBeDefined();
    // 从未上报：聚合条目不存在（消费方走安全默认）
    expect(useTabViewStateStore.getState().aggregate["unknown"]).toBeUndefined();
  });
});
