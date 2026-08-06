import { describe, expect, it } from "vitest";
import type { PaneNode, Tab, TerminalPaneNode } from "@/types";
import {
  activeTerminalLeaf,
  collectTerminalSessionIds,
  collectTerminalSessionIdsWithSaved,
  collectTerminalSessionIdsWithSavedFromTree,
} from "./paneSessions";

let tabSeq = 0;
function makeTab(overrides: Partial<Tab> = {}): Tab {
  tabSeq += 1;
  return {
    id: `tab-${tabSeq}`,
    title: `Terminal ${tabSeq}`,
    contentType: "terminal",
    projectId: "project-a",
    projectPath: "D:\\repo\\alpha",
    sessionId: null,
    ...overrides,
  } as Tab;
}

function panel(tabs: Tab[], id = `panel-${tabSeq}`): PaneNode {
  return { type: "panel", id, tabs, activeTabId: tabs[0]?.id ?? "" } as PaneNode;
}

function split(children: TerminalPaneNode[]): TerminalPaneNode {
  return {
    type: "split",
    id: "split-root",
    direction: "horizontal",
    children,
    sizes: children.map(() => 1 / children.length),
  };
}

describe("collectTerminalSessionIdsWithSaved", () => {
  it("collects sessionId and savedSessionId from every leaf of a split tree", () => {
    const tab = makeTab({
      terminalRootPane: split([
        { type: "leaf", id: "leaf-1", sessionId: "live-a" },
        { type: "leaf", id: "leaf-2", sessionId: null, restoring: true, savedSessionId: "saved-b" },
        { type: "leaf", id: "leaf-3", sessionId: "live-c", savedSessionId: "saved-c" },
      ]),
    });
    expect(collectTerminalSessionIdsWithSaved(tab).sort()).toEqual(
      ["live-a", "live-c", "saved-b", "saved-c"].sort(),
    );
  });

  it("dedupes when the same id appears as both sessionId and savedSessionId", () => {
    const tab = makeTab({
      terminalRootPane: split([
        { type: "leaf", id: "leaf-1", sessionId: "same-id", savedSessionId: "same-id" },
        { type: "leaf", id: "leaf-2", sessionId: null, savedSessionId: "same-id" },
      ]),
    });
    expect(collectTerminalSessionIdsWithSaved(tab)).toEqual(["same-id"]);
  });

  it("falls back to tab-level ids when there is no terminalRootPane", () => {
    const tab = makeTab({ sessionId: "live-tab", savedSessionId: "saved-tab" });
    expect(collectTerminalSessionIdsWithSaved(tab).sort()).toEqual(["live-tab", "saved-tab"]);
    // restoring 中尚未 attach：只有 savedSessionId
    const restoring = makeTab({ sessionId: null, restoring: true, savedSessionId: "saved-only" });
    expect(collectTerminalSessionIdsWithSaved(restoring)).toEqual(["saved-only"]);
  });

  it("uses the tab-level fallback for non-terminal tabs and drops empty values", () => {
    const editor = makeTab({ contentType: "editor", sessionId: "edit-live", savedSessionId: "" });
    expect(collectTerminalSessionIdsWithSaved(editor)).toEqual(["edit-live"]);
    const empty = makeTab({ sessionId: null });
    expect(collectTerminalSessionIdsWithSaved(empty)).toEqual([]);
  });

  it("keeps the legacy collectTerminalSessionIds narrow (savedSessionId excluded)", () => {
    // 旧口径守护：其他消费者依赖“只算已 attach 会话”的语义，不得被新口径影响
    const tab = makeTab({
      terminalRootPane: split([
        { type: "leaf", id: "leaf-1", sessionId: "live-a", savedSessionId: "saved-a" },
        { type: "leaf", id: "leaf-2", sessionId: null, savedSessionId: "saved-b" },
      ]),
    });
    expect(collectTerminalSessionIds(tab)).toEqual(["live-a"]);
  });
});

describe("collectTerminalSessionIdsWithSavedFromTree", () => {
  it("collects across all terminal tabs in the pane tree, dedupes, skips non-terminals", () => {
    const terminalTab = makeTab({ sessionId: "live-a", savedSessionId: "saved-a" });
    const restoringTab = makeTab({ sessionId: null, savedSessionId: "saved-a" }); // 跨 tab 重复
    const browserTab = makeTab({ contentType: "browser", sessionId: "should-not-count" });
    const tree = panel([terminalTab, restoringTab, browserTab]);
    expect(collectTerminalSessionIdsWithSavedFromTree(tree).sort()).toEqual(
      ["live-a", "saved-a"].sort(),
    );
  });
});

describe("activeTerminalLeaf（批5 绞杀第一段：tab 级运行时读取的唯一投影入口）", () => {
  const leaf = (id: string, sessionId?: string) =>
    ({ type: "leaf", id, sessionId: sessionId ?? null }) as TerminalPaneNode;

  it("activeTerminalPaneId 命中时返回该 leaf", () => {
    const tab = makeTab({
      terminalRootPane: split([leaf("l1", "s1"), leaf("l2", "s2")]),
      activeTerminalPaneId: "l2",
    });
    expect(activeTerminalLeaf(tab)?.id).toBe("l2");
  });

  it("未命中/未设置时回退第一个 leaf", () => {
    const tab = makeTab({
      terminalRootPane: split([leaf("l1", "s1"), leaf("l2", "s2")]),
      activeTerminalPaneId: "gone",
    });
    expect(activeTerminalLeaf(tab)?.id).toBe("l1");
  });

  it("无树（legacy 形态）与非终端返回 null", () => {
    expect(activeTerminalLeaf(makeTab())).toBeNull();
    expect(activeTerminalLeaf(makeTab({ contentType: "browser" } as Partial<Tab>))).toBeNull();
  });
});
