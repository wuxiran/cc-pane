import { beforeEach, describe, expect, it } from "vitest";
import { matchLayoutPreset, usePanesStore } from "./usePanesStore";
import { createPanel, generateId } from "./paneTreeHelpers";
import type { Panel, PaneNode, SplitPane, Tab, TerminalPaneLeaf } from "@/types";

function makeTerminalTab(id: string): Tab {
  const leaf: TerminalPaneLeaf = {
    type: "leaf",
    id: `${id}-leaf`,
    sessionId: null,
  };
  return {
    id,
    title: id,
    contentType: "terminal",
    projectId: id,
    projectPath: `/tmp/${id}`,
    sessionId: null,
    terminalRootPane: leaf,
    activeTerminalPaneId: leaf.id,
  };
}

function makePanel(id: string, tabs: Tab[], activeTabId?: string): Panel {
  return {
    type: "panel",
    id,
    tabs,
    activeTabId: activeTabId ?? tabs[0]?.id ?? "",
  };
}

function setRootPane(rootPane: PaneNode, activePaneId: string) {
  const starredRootPane = createPanel();
  usePanesStore.setState({
    rootPane,
    activePaneId,
    layouts: [
      {
        id: "layout-1",
        name: "布局 1",
        kind: "normal",
        rootPane,
        activePaneId,
      },
      {
        id: "layout-starred",
        name: "星标",
        kind: "starred",
        rootPane: starredRootPane,
        activePaneId: starredRootPane.id,
      },
    ],
    currentLayoutId: "layout-1",
    closedTabs: [],
    poppedOutTabs: new Set<string>(),
  });
}

function panels(): Panel[] {
  const collect = (node: PaneNode): Panel[] =>
    node.type === "panel" ? [node] : node.children.flatMap(collect);
  return collect(usePanesStore.getState().rootPane);
}

describe("applyLayoutPreset", () => {
  beforeEach(() => {
    const rootPane = createPanel();
    setRootPane(rootPane, rootPane.id);
  });

  it("单 panel 多 tabs → grid-2x2：tabs 保序顺序填充，多余的全进最后一格", () => {
    const tabs = ["t1", "t2", "t3", "t4", "t5"].map(makeTerminalTab);
    const pane = makePanel("pane-a", tabs, "t3");
    setRootPane(pane, pane.id);

    usePanesStore.getState().applyLayoutPreset("grid-2x2");

    const result = panels();
    expect(result).toHaveLength(4);
    expect(result.map((p) => p.tabs.map((tab) => tab.id))).toEqual([
      ["t1"],
      ["t2"],
      ["t3"],
      ["t4", "t5"],
    ]);
    // 现有 Panel id 按序复用
    expect(result[0].id).toBe("pane-a");
    // 结构：vertical 根，两行各为 horizontal 两格
    const root = usePanesStore.getState().rootPane as SplitPane;
    expect(root.type).toBe("split");
    expect(root.direction).toBe("vertical");
    expect(root.children).toHaveLength(2);
    for (const row of root.children) {
      expect(row.type).toBe("split");
      expect((row as SplitPane).direction).toBe("horizontal");
      expect((row as SplitPane).children).toHaveLength(2);
    }
    // 焦点跟随重排前的激活 tab（t3 落在第 3 格）
    expect(usePanesStore.getState().activePaneId).toBe(result[2].id);
    expect(result[2].activeTabId).toBe("t3");
    expect(matchLayoutPreset(usePanesStore.getState().rootPane)).toBe("grid-2x2");
  });

  it("多 panel → two-col：Panel id 按序复用，原激活标签尽量保持激活", () => {
    const a1 = makeTerminalTab("a1");
    const a2 = makeTerminalTab("a2");
    const b1 = makeTerminalTab("b1");
    const paneA = makePanel("pane-a", [a1, a2], "a1");
    const paneB = makePanel("pane-b", [b1], "b1");
    const root: SplitPane = {
      type: "split",
      id: "split-root",
      direction: "vertical",
      children: [paneA, paneB],
      sizes: [50, 50],
    };
    setRootPane(root, "pane-b");

    usePanesStore.getState().applyLayoutPreset("two-col");

    const result = panels();
    expect(result.map((p) => p.id)).toEqual(["pane-a", "pane-b"]);
    expect(result[0].tabs.map((tab) => tab.id)).toEqual(["a1"]);
    expect(result[1].tabs.map((tab) => tab.id)).toEqual(["a2", "b1"]);
    // pane-b 原激活标签 b1 被分进同一格，保持激活
    expect(result[1].activeTabId).toBe("b1");
    // 根 split id 复用，减少整树 remount
    const newRoot = usePanesStore.getState().rootPane as SplitPane;
    expect(newRoot.id).toBe("split-root");
    expect(newRoot.direction).toBe("horizontal");
    expect(matchLayoutPreset(newRoot)).toBe("two-col");
  });

  it("tabs 少于格子数 → 多余格子为空 Panel（精确 N 格）", () => {
    const t1 = makeTerminalTab("t1");
    const pane = makePanel("pane-a", [t1]);
    setRootPane(pane, pane.id);

    usePanesStore.getState().applyLayoutPreset("three-col");

    const result = panels();
    expect(result).toHaveLength(3);
    expect(result[0].tabs.map((tab) => tab.id)).toEqual(["t1"]);
    expect(result[1].tabs).toHaveLength(0);
    expect(result[2].tabs).toHaveLength(0);
    expect(result[1].activeTabId).toBe("");
    expect(matchLayoutPreset(usePanesStore.getState().rootPane)).toBe("three-col");
  });

  it("空布局（无 tabs）也允许应用预设", () => {
    const pane = makePanel("pane-empty", []);
    setRootPane(pane, pane.id);

    usePanesStore.getState().applyLayoutPreset("two-row");

    const result = panels();
    expect(result).toHaveLength(2);
    expect(result.every((p) => p.tabs.length === 0)).toBe(true);
    expect(result[0].id).toBe("pane-empty");
    expect(usePanesStore.getState().activePaneId).toBe("pane-empty");
  });

  it("single：全部 tabs 合并进一格，根为 split 时保留单 child 壳", () => {
    const t1 = makeTerminalTab("t1");
    const t2 = makeTerminalTab("t2");
    const paneA = makePanel("pane-a", [t1]);
    const paneB = makePanel("pane-b", [t2]);
    const root: SplitPane = {
      type: "split",
      id: "split-root",
      direction: "horizontal",
      children: [paneA, paneB],
      sizes: [50, 50],
    };
    setRootPane(root, "pane-a");

    usePanesStore.getState().applyLayoutPreset("single");

    const newRoot = usePanesStore.getState().rootPane;
    // 保留壳：root 仍是 split（id 复用），仅剩一个 child panel
    expect(newRoot.type).toBe("split");
    expect(newRoot.id).toBe("split-root");
    expect((newRoot as SplitPane).children).toHaveLength(1);
    const only = (newRoot as SplitPane).children[0] as Panel;
    expect(only.id).toBe("pane-a");
    expect(only.tabs.map((tab) => tab.id)).toEqual(["t1", "t2"]);
    expect(matchLayoutPreset(newRoot)).toBe("single");
  });

  it("main-side：左大右两小，多余 tabs 落最后一格", () => {
    const tabs = ["t1", "t2", "t3", "t4"].map(makeTerminalTab);
    const pane = makePanel("pane-a", tabs);
    setRootPane(pane, pane.id);

    usePanesStore.getState().applyLayoutPreset("main-side");

    const root = usePanesStore.getState().rootPane as SplitPane;
    expect(root.direction).toBe("horizontal");
    expect(root.children).toHaveLength(2);
    expect(root.children[0].type).toBe("panel");
    const side = root.children[1] as SplitPane;
    expect(side.type).toBe("split");
    expect(side.direction).toBe("vertical");
    const result = panels();
    expect(result.map((p) => p.tabs.map((tab) => tab.id))).toEqual([
      ["t1"],
      ["t2"],
      ["t3", "t4"],
    ]);
    expect(matchLayoutPreset(root)).toBe("main-side");
  });

  it("当前是星标布局时切到首个普通布局再应用", () => {
    const normalPane = makePanel(`pane-${generateId("x")}`, [makeTerminalTab("t1")]);
    setRootPane(normalPane, normalPane.id);
    usePanesStore.setState({ currentLayoutId: "layout-starred" });

    usePanesStore.getState().applyLayoutPreset("two-col");

    expect(usePanesStore.getState().currentLayoutId).toBe("layout-1");
    expect(panels()).toHaveLength(2);
  });
});
