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
    const pane = panel([tab("memory", "memory-manager"), tab("mcp", "mcp-config")], "mcp");
    cleanRehydratedPanes(pane);
    expect(pane.tabs.map((item) => item.id)).toEqual(["memory"]);
    expect(pane.activeTabId).toBe("memory");
  });

  it("旧快照里的 skill-manager 标签（项目和工作空间视图）都被移除", () => {
    const workspaceSkills = { ...tab("ws-skill", "skill-manager"), workspaceName: "alpha" } as Tab;
    const pane = panel([tab("a", "file-explorer"), tab("skill", "skill-manager"), workspaceSkills], "skill");
    cleanRehydratedPanes(pane);
    expect(pane.tabs.map((item) => item.id)).toEqual(["a"]);
    expect(pane.activeTabId).toBe("a");
  });

  it("窗格只有已下线标签时变为空窗格，不报错", () => {
    const pane = panel([tab("mcp", "mcp-config"), tab("skill", "skill-manager")], "mcp");
    cleanRehydratedPanes(pane);
    expect(pane.tabs).toEqual([]);
    expect(pane.activeTabId).toBe("");
  });

  it("活动标签仍在时保持不变", () => {
    const pane = panel([tab("a", "file-explorer"), tab("skill", "skill-manager"), tab("b", "memory-manager")], "a");
    cleanRehydratedPanes(pane);
    expect(pane.activeTabId).toBe("a");
    expect(pane.tabs.map((item) => item.id)).toEqual(["a", "b"]);
  });
});
