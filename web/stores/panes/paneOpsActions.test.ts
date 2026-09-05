// 窗格级操作（批 2 新增：布局操作一等公民）：
// closePane / equalizePaneSizes / togglePaneZoom / splitAndDropTab 的契约。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { usePanesStore } from "../usePanesStore";
import { terminalService } from "@/services";
import { createPanel, findPane } from "@/lib/paneTree";
import type { PaneNode, Panel, SplitPane, Tab, TerminalPaneLeaf } from "@/types";

function makeTerminalTab(id: string, overrides?: Partial<Tab>): Tab {
  const leaf: TerminalPaneLeaf = {
    type: "leaf",
    id: `${id}-leaf`,
    launchId: `${id}-launch`,
    restoreMode: "shell",
    sessionId: null,
  };
  return {
    id,
    title: `Tab ${id}`,
    contentType: "terminal",
    projectId: `proj-${id}`,
    projectPath: `/tmp/${id}`,
    sessionId: null,
    terminalRootPane: leaf,
    activeTerminalPaneId: leaf.id,
    ...overrides,
  };
}

function makePanel(id: string, tabs: Tab[]): Panel {
  return { type: "panel", id, tabs, activeTabId: tabs[0]?.id ?? "" };
}

function makeSplit(id: string, children: PaneNode[], sizes?: number[]): SplitPane {
  return {
    type: "split",
    id,
    direction: "horizontal",
    children,
    sizes: sizes ?? children.map(() => 100 / children.length),
  };
}

function setPanesState(rootPane: PaneNode, activePaneId: string) {
  usePanesStore.setState({
    rootPane,
    activePaneId,
    layouts: [{ id: "layout-1", name: "布局 1", kind: "normal", rootPane, activePaneId }],
    currentLayoutId: "layout-1",
    closedTabs: [],
    poppedOutTabs: new Set<string>(),
    zoomedPaneId: null,
  });
}

beforeEach(() => {
  const initialPanel = createPanel();
  setPanesState(initialPanel, initialPanel.id);
  vi.spyOn(terminalService, "killSession").mockResolvedValue(undefined);
  vi.spyOn(terminalService, "detachOutput").mockImplementation(() => {});
  vi.spyOn(terminalService, "detachExit").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("closePane", () => {
  it("关闭全部标签并收编空 pane（幸存 pane 保留）", () => {
    const p1 = makePanel("p1", [makeTerminalTab("t1")]);
    const p2 = makePanel("p2", [makeTerminalTab("t2")]);
    setPanesState(makeSplit("s1", [p1, p2]), "p1");

    usePanesStore.getState().closePane("p1");

    const state = usePanesStore.getState();
    expect(findPane(state.rootPane, "p1")).toBeNull();
    expect(findPane(state.rootPane, "p2")).not.toBeNull();
    expect(state.closedTabs.map((s) => s.projectId)).toEqual(["proj-t1"]);
  });

  it("close-pane 矩阵不豁免 pinned：整 pane 关闭（逐格锁定语义，非 user-close）", () => {
    const p1 = makePanel("p1", [makeTerminalTab("t1", { pinned: true }), makeTerminalTab("t2")]);
    const p2 = makePanel("p2", [makeTerminalTab("t3")]);
    setPanesState(makeSplit("s1", [p1, p2]), "p1");

    usePanesStore.getState().closePane("p1");

    const state = usePanesStore.getState();
    expect(findPane(state.rootPane, "p1")).toBeNull();
    expect(state.closedTabs.map((s) => s.projectId).sort()).toEqual(["proj-t1", "proj-t2"]);
  });

  it("zoom 中的 pane 被关掉后清理 zoom 态", () => {
    const p1 = makePanel("p1", [makeTerminalTab("t1")]);
    const p2 = makePanel("p2", [makeTerminalTab("t2")]);
    setPanesState(makeSplit("s1", [p1, p2]), "p1");
    usePanesStore.setState({ zoomedPaneId: "p1" });

    usePanesStore.getState().closePane("p1");

    expect(usePanesStore.getState().zoomedPaneId).toBeNull();
  });
});

describe("equalizePaneSizes", () => {
  it("递归归一所有 split 节点的 sizes", () => {
    const p1 = makePanel("p1", []);
    const p2 = makePanel("p2", []);
    const p3 = makePanel("p3", []);
    const inner = makeSplit("s2", [p2, p3], [80, 20]);
    const root = makeSplit("s1", [p1, inner], [70, 30]);
    setPanesState(root, "p1");

    usePanesStore.getState().equalizePaneSizes();

    const state = usePanesStore.getState();
    const s1 = findPane(state.rootPane, "s1") as SplitPane;
    const s2 = findPane(state.rootPane, "s2") as SplitPane;
    expect(s1.sizes).toEqual([50, 50]);
    expect(s2.sizes).toEqual([50, 50]);
  });
});

describe("togglePaneZoom", () => {
  it("设置/还原 zoom 态", () => {
    const p1 = makePanel("p1", []);
    const p2 = makePanel("p2", []);
    setPanesState(makeSplit("s1", [p1, p2]), "p1");

    usePanesStore.getState().togglePaneZoom("p1");
    expect(usePanesStore.getState().zoomedPaneId).toBe("p1");

    usePanesStore.getState().togglePaneZoom("p1");
    expect(usePanesStore.getState().zoomedPaneId).toBeNull();
  });

  it("单 pane 布局 no-op", () => {
    const p1 = makePanel("p1", []);
    setPanesState(p1, "p1");

    usePanesStore.getState().togglePaneZoom("p1");
    expect(usePanesStore.getState().zoomedPaneId).toBeNull();
  });

  it("switchLayout 清理 zoom 态", () => {
    const p1 = makePanel("p1", []);
    const p2 = makePanel("p2", []);
    setPanesState(makeSplit("s1", [p1, p2]), "p1");
    usePanesStore.setState({ zoomedPaneId: "p1" });
    const other = makePanel("px", []);
    usePanesStore.setState((state) => ({
      layouts: [
        ...state.layouts,
        { id: "layout-2", name: "布局 2", kind: "normal" as const, rootPane: other, activePaneId: other.id },
      ],
    }));

    usePanesStore.getState().switchLayout("layout-2");
    expect(usePanesStore.getState().zoomedPaneId).toBeNull();
  });
});

describe("splitAndDropTab", () => {
  it("跨 pane：在目标旁开新窗格并搬入 tab", () => {
    const p1 = makePanel("p1", [makeTerminalTab("t1")]);
    const p2 = makePanel("p2", [makeTerminalTab("t2")]);
    setPanesState(makeSplit("s1", [p1, p2]), "p1");

    usePanesStore.getState().splitAndDropTab("p2", "p1", "t1", "right");

    const state = usePanesStore.getState();
    // 源 pane（单 tab 被搬走）收壳，tab 落在 p2 旁的新 pane
    expect(findPane(state.rootPane, "p1")).toBeNull();
    const panels = state.allPanels();
    expect(panels).toHaveLength(2);
    const newPane = panels.find((p) => p.id !== "p2");
    expect(newPane?.tabs.map((t) => t.id)).toEqual(["t1"]);
  });

  it("落到本 pane 边缘：拆自己（splitAndMoveTab 语义）", () => {
    const p1 = makePanel("p1", [makeTerminalTab("t1"), makeTerminalTab("t2")]);
    setPanesState(p1, "p1");

    usePanesStore.getState().splitAndDropTab("p1", "p1", "t2", "down");

    const state = usePanesStore.getState();
    const panels = state.allPanels();
    expect(panels).toHaveLength(2);
    const moved = panels.find((p) => p.id !== "p1");
    expect(moved?.tabs.map((t) => t.id)).toEqual(["t2"]);
    const root = state.rootPane as SplitPane;
    expect(root.direction).toBe("vertical");
  });

  it("本 pane 单 tab 落本 pane 边缘：no-op", () => {
    const p1 = makePanel("p1", [makeTerminalTab("t1")]);
    setPanesState(p1, "p1");

    usePanesStore.getState().splitAndDropTab("p1", "p1", "t1", "right");

    expect(usePanesStore.getState().allPanels()).toHaveLength(1);
  });
});
