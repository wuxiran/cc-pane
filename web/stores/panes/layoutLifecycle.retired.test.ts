import { describe, expect, it } from "vitest";
import type { Panel, Tab } from "@/types";
import { cleanRehydratedPanes } from "./layoutLifecycle";

const tab = (id: string, contentType: string) =>
  ({ id, title: id, contentType, projectId: "", projectPath: "", sessionId: null }) as unknown as Tab;

function panel(tabs: Tab[], activeTabId: string): Panel {
  return { type: "panel", id: "pane", tabs, activeTabId } as Panel;
}

describe("cleanRehydratedPanes 丢弃已下线的标签类型", () => {
  it("旧快照里的 mcp-config 标签被移除，活动标签落到剩余标签", () => {
    const pane = panel([tab("skill", "skill-manager"), tab("mcp", "mcp-config")], "mcp");
    cleanRehydratedPanes(pane);
    expect(pane.tabs.map((item) => item.id)).toEqual(["skill"]);
    expect(pane.activeTabId).toBe("skill");
  });

  it("窗格只有 mcp-config 时变为空窗格，不报错", () => {
    const pane = panel([tab("mcp", "mcp-config")], "mcp");
    cleanRehydratedPanes(pane);
    expect(pane.tabs).toEqual([]);
    expect(pane.activeTabId).toBe("");
  });

  it("活动标签仍在时保持不变", () => {
    const pane = panel([tab("a", "skill-manager"), tab("mcp", "mcp-config"), tab("b", "memory-manager")], "a");
    cleanRehydratedPanes(pane);
    expect(pane.activeTabId).toBe("a");
  });
});
