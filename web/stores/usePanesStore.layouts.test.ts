import { beforeEach, describe, expect, it } from "vitest";
import { usePanesStore } from "./usePanesStore";
import { useFullscreenStore } from "./useFullscreenStore";
import { createPanel, createTab } from "./paneTreeHelpers";
import { mockTauriInvoke, resetTauriInvoke } from "@/test/utils/mockTauriInvoke";
import type { LayoutEntry, Panel, PaneNode, Tab, TerminalPaneLeaf, TerminalPaneSplit } from "@/types";

function resetPanesStore() {
  const rootPane = createPanel();
  const starredRootPane = createPanel();
  usePanesStore.setState({
    rootPane,
    activePaneId: rootPane.id,
    layouts: [
      {
        id: "layout-1",
        name: "布局 1",
        kind: "normal",
        rootPane,
        activePaneId: rootPane.id,
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

function waitForMicrotasks() {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function panel(root: PaneNode): Panel {
  expect(root.type).toBe("panel");
  return root as Panel;
}

function makeTerminalTab(id: string, sessionId: string | null = null): Tab {
  const leaf: TerminalPaneLeaf = {
    type: "leaf",
    id: `${id}-leaf`,
    sessionId,
    resumeId: "resume-old",
  };
  return {
    id,
    title: id,
    contentType: "terminal",
    projectId: id,
    projectPath: `/tmp/${id}`,
    sessionId,
    resumeId: leaf.resumeId,
    terminalRootPane: leaf,
    activeTerminalPaneId: leaf.id,
  };
}

function makeSplitTerminalTab(id: string): Tab {
  const left: TerminalPaneLeaf = {
    type: "leaf",
    id: `${id}-left`,
    sessionId: "session-left",
  };
  const right: TerminalPaneLeaf = {
    type: "leaf",
    id: `${id}-right`,
    sessionId: "session-right",
  };
  const root: TerminalPaneSplit = {
    type: "split",
    id: `${id}-split`,
    direction: "horizontal",
    children: [left, right],
    sizes: [50, 50],
  };
  return {
    id,
    title: id,
    contentType: "terminal",
    projectId: id,
    projectPath: `/tmp/${id}`,
    sessionId: left.sessionId,
    terminalRootPane: root,
    activeTerminalPaneId: left.id,
  };
}

function makeLayout(id: string, name: string, tab: Tab): LayoutEntry {
  const rootPane = createPanel(tab);
  return {
    id,
    name,
    rootPane,
    activePaneId: rootPane.id,
  };
}

function hiddenLayout() {
  return usePanesStore.getState().layouts.find((layout) => layout.id === "layout-hidden")!;
}

function normalLayoutIds() {
  return usePanesStore.getState()
    .layouts
    .filter((layout) => layout.kind !== "starred")
    .map((layout) => layout.id);
}

describe("usePanesStore layouts", () => {
  beforeEach(() => {
    resetTauriInvoke();
    mockTauriInvoke({ exit_fullscreen: undefined });
    useFullscreenStore.setState({
      isFullscreen: false,
      fullscreenPaneId: null,
      fullscreenTabId: null,
    });
    resetPanesStore();
  });

  it("createLayout 创建独立 rootPane 并切换到新布局", () => {
    const previousRoot = usePanesStore.getState().rootPane;

    const id = usePanesStore.getState().createLayout("第二布局");

    const state = usePanesStore.getState();
    expect(state.currentLayoutId).toBe(id);
    expect(state.layouts.filter((layout) => layout.kind !== "starred")).toHaveLength(2);
    expect(state.layouts.find((layout) => layout.id === id)?.name).toBe("第二布局");
    expect(state.rootPane).toBe(state.layouts.find((layout) => layout.id === id)?.rootPane);
    expect(state.rootPane).not.toBe(previousRoot);
    expect(state.layouts[0].rootPane).toBe(previousRoot);
  });

  it("renameLayout 更新名称并忽略空名称", () => {
    usePanesStore.getState().renameLayout("layout-1", "新名称");
    expect(usePanesStore.getState().layouts[0].name).toBe("新名称");

    usePanesStore.getState().renameLayout("layout-1", "  ");
    expect(usePanesStore.getState().layouts[0].name).toBe("新名称");
  });

  it("switchLayout 回写当前工作副本、载入目标布局并退出全屏", async () => {
    const root = usePanesStore.getState().rootPane;
    usePanesStore.getState().addTab(root.id, {
      projectId: "current",
      projectPath: "/tmp/current",
    });
    useFullscreenStore.setState({
      isFullscreen: true,
      fullscreenPaneId: root.id,
      fullscreenTabId: panel(root).activeTabId,
    });
    const hidden = makeLayout("layout-hidden", "隐藏", makeTerminalTab("hidden-tab"));
    usePanesStore.setState((state) => {
      state.layouts.push(hidden);
    });

    usePanesStore.getState().switchLayout("layout-hidden");
    await waitForMicrotasks();

    const state = usePanesStore.getState();
    expect(state.currentLayoutId).toBe("layout-hidden");
    expect(state.rootPane).toBe(hidden.rootPane);
    expect(panel(state.layouts[0].rootPane).tabs).toHaveLength(2);
    expect(useFullscreenStore.getState().isFullscreen).toBe(false);
  });

  it("switchLayoutByIndex 按布局列表顺序切换", () => {
    const layout2 = makeLayout("layout-2", "布局 2", makeTerminalTab("tab-2"));
    usePanesStore.setState((state) => {
      state.layouts.push(layout2);
    });

    usePanesStore.getState().switchLayoutByIndex(2);

    expect(usePanesStore.getState().currentLayoutId).toBe("layout-2");
  });

  it("switchLayoutByIndex 越界索引静默忽略", () => {
    const before = usePanesStore.getState().currentLayoutId;

    expect(() => usePanesStore.getState().switchLayoutByIndex(8)).not.toThrow();

    expect(usePanesStore.getState().currentLayoutId).toBe(before);
  });

  it("reorderLayouts 重排布局顺序且不切换当前工作副本", () => {
    const currentRoot = usePanesStore.getState().rootPane;
    const layout2 = makeLayout("layout-2", "布局 2", makeTerminalTab("tab-2"));
    const layout3 = makeLayout("layout-3", "布局 3", makeTerminalTab("tab-3"));
    usePanesStore.setState((state) => {
      state.layouts.push(layout2, layout3);
    });

    usePanesStore.getState().reorderLayouts(0, 2);

    const state = usePanesStore.getState();
    expect(state.layouts.map((layout) => layout.id)).toEqual(["layout-starred", "layout-2", "layout-1", "layout-3"]);
    expect(state.currentLayoutId).toBe("layout-1");
    expect(state.rootPane).toBe(currentRoot);
  });

  it("reorderLayouts 越界和同位置静默忽略", () => {
    const layout2 = makeLayout("layout-2", "布局 2", makeTerminalTab("tab-2"));
    const layout3 = makeLayout("layout-3", "布局 3", makeTerminalTab("tab-3"));
    usePanesStore.setState((state) => {
      state.layouts.push(layout2, layout3);
    });
    const before = usePanesStore.getState().layouts.map((layout) => layout.id);

    expect(() => usePanesStore.getState().reorderLayouts(0, 5)).not.toThrow();
    expect(() => usePanesStore.getState().reorderLayouts(-1, 0)).not.toThrow();
    expect(() => usePanesStore.getState().reorderLayouts(1, 1)).not.toThrow();

    expect(usePanesStore.getState().layouts.map((layout) => layout.id)).toEqual(before);
  });

  it("reorderLayouts 后 switchLayoutByIndex 按新顺序切换", () => {
    const layout2 = makeLayout("layout-2", "布局 2", makeTerminalTab("tab-2"));
    const layout3 = makeLayout("layout-3", "布局 3", makeTerminalTab("tab-3"));
    usePanesStore.setState((state) => {
      state.layouts.push(layout2, layout3);
    });

    usePanesStore.getState().reorderLayouts(3, 0);
    usePanesStore.getState().switchLayoutByIndex(0);

    expect(usePanesStore.getState().currentLayoutId).toBe("layout-3");
  });

  it("deleteLayout 删除当前布局时切到相邻布局，最后一个布局拒绝删除", () => {
    const layout2 = makeLayout("layout-2", "布局 2", makeTerminalTab("tab-2"));
    const layout3 = makeLayout("layout-3", "布局 3", makeTerminalTab("tab-3"));
    usePanesStore.setState((state) => {
      state.layouts.push(layout2, layout3);
    });
    usePanesStore.getState().switchLayout("layout-3");

    usePanesStore.getState().deleteLayout("layout-3");

    expect(normalLayoutIds()).toEqual(["layout-1", "layout-2"]);
    expect(usePanesStore.getState().currentLayoutId).toBe("layout-2");

    usePanesStore.getState().deleteLayout("layout-1");
    usePanesStore.getState().deleteLayout("layout-2");
    expect(normalLayoutIds()).toHaveLength(1);
    expect(usePanesStore.getState().currentLayoutId).toBe("layout-2");
  });

  it("allPanels 只返回当前布局，allPanelsAcrossLayouts 返回全部布局", () => {
    const hidden = makeLayout("layout-hidden", "隐藏", makeTerminalTab("hidden-tab"));
    usePanesStore.setState((state) => {
      state.layouts.push(hidden);
    });

    expect(usePanesStore.getState().allPanels()).toHaveLength(1);
    expect(usePanesStore.getState().allPanelsAcrossLayouts()).toHaveLength(2);
  });

  it("默认带星标布局，但跨布局 pane 遍历只返回真实布局", () => {
    const state = usePanesStore.getState();

    expect(state.layouts.some((layout) => layout.kind === "starred" && layout.name === "星标")).toBe(true);
    expect(state.allPanelsAcrossLayouts()).toHaveLength(1);
    expect(state.listLayouts().some((layout) => layout.kind === "starred")).toBe(false);
  });

  it("toggleStarTab 后 starredTabs 返回原 tab 位置并可切回原布局", () => {
    const hidden = makeLayout("layout-hidden", "隐藏", makeTerminalTab("hidden-tab"));
    usePanesStore.setState((state) => {
      state.layouts.push(hidden);
    });
    usePanesStore.getState().switchLayout("layout-hidden");

    usePanesStore.getState().toggleStarTab("hidden-tab");
    usePanesStore.getState().switchLayout("layout-1");
    const opened = usePanesStore.getState().openStarredTab("hidden-tab");

    const shortcuts = usePanesStore.getState().starredTabs();
    expect(shortcuts).toHaveLength(1);
    expect(shortcuts[0].layoutId).toBe("layout-hidden");
    expect(shortcuts[0].paneId).toBe(hidden.rootPane.id);
    expect(opened).toBe(true);
    expect(usePanesStore.getState().currentLayoutId).toBe("layout-hidden");
    expect(panel(usePanesStore.getState().rootPane).activeTabId).toBe("hidden-tab");
  });

  it("删除星标布局不会删除真实布局或原 tab，重新打星会恢复星标布局", () => {
    const tab = panel(usePanesStore.getState().rootPane).tabs[0];

    usePanesStore.getState().deleteLayout("layout-starred");
    expect(usePanesStore.getState().layouts.some((layout) => layout.kind === "starred")).toBe(false);
    expect(usePanesStore.getState().layouts.some((layout) => layout.id === "layout-1")).toBe(true);

    usePanesStore.getState().toggleStarTab(tab.id);

    const state = usePanesStore.getState();
    expect(state.layouts.some((layout) => layout.kind === "starred")).toBe(true);
    expect(panel(state.rootPane).tabs[0].id).toBe(tab.id);
    expect(state.starredTabs().map((item) => item.tab.id)).toEqual([tab.id]);
  });

  it("moveTabToLayoutPane 能把当前布局 tab 发送到隐藏布局窗格且不切换布局", () => {
    const currentPaneId = usePanesStore.getState().rootPane.id;
    usePanesStore.getState().addTab(currentPaneId, {
      projectId: "current",
      projectPath: "/tmp/current",
    });
    const tabToMove = panel(usePanesStore.getState().rootPane).tabs[1];
    const hidden = makeLayout("layout-hidden", "隐藏", makeTerminalTab("hidden-tab"));
    const hiddenPaneId = hidden.rootPane.id;
    usePanesStore.setState((state) => {
      state.layouts.push(hidden);
    });

    usePanesStore.getState().moveTabToLayoutPane(
      currentPaneId,
      "layout-hidden",
      tabToMove.id,
      hiddenPaneId,
    );

    const state = usePanesStore.getState();
    expect(state.currentLayoutId).toBe("layout-1");
    expect(state.activePaneId).toBe(currentPaneId);
    expect(panel(state.rootPane).tabs.map((tab) => tab.id)).not.toContain(tabToMove.id);
    expect(panel(hiddenLayout().rootPane).tabs.map((tab) => tab.id)).toEqual([
      "hidden-tab",
      tabToMove.id,
    ]);
    expect(panel(hiddenLayout().rootPane).activeTabId).toBe(tabToMove.id);
    expect(hiddenLayout().activePaneId).toBe(hiddenPaneId);
  });

  it("moveTabToLayoutPane 未指定目标窗格时使用目标布局第一个窗格", () => {
    const currentPaneId = usePanesStore.getState().rootPane.id;
    usePanesStore.getState().addTab(currentPaneId, {
      projectId: "current",
      projectPath: "/tmp/current",
    });
    const tabToMove = panel(usePanesStore.getState().rootPane).tabs[1];
    const hidden = makeLayout("layout-hidden", "隐藏", makeTerminalTab("hidden-tab"));
    const hiddenPaneId = hidden.rootPane.id;
    usePanesStore.setState((state) => {
      state.layouts.push(hidden);
    });

    usePanesStore.getState().moveTabToLayoutPane(currentPaneId, "layout-hidden", tabToMove.id);

    expect(panel(hiddenLayout().rootPane).tabs.map((tab) => tab.id)).toContain(tabToMove.id);
    expect(hiddenLayout().activePaneId).toBe(hiddenPaneId);
  });

  it("updateTabSession 和 clearRestoring 能回写隐藏布局 tab", () => {
    const tab = makeTerminalTab("hidden-tab");
    tab.restoring = true;
    const leaf = tab.terminalRootPane as TerminalPaneLeaf;
    leaf.restoring = true;
    leaf.savedSessionId = "saved-1";
    tab.savedSessionId = "saved-1";
    usePanesStore.setState((state) => {
      state.layouts.push(makeLayout("layout-hidden", "隐藏", tab));
    });

    usePanesStore.getState().updateTabSession("ignored", "hidden-tab", "session-new");
    usePanesStore.getState().clearRestoring("ignored", "hidden-tab", leaf.id);

    const hiddenTab = panel(hiddenLayout().rootPane).tabs[0];
    const hiddenLeaf = hiddenTab.terminalRootPane as TerminalPaneLeaf;
    expect(hiddenLeaf.sessionId).toBe("session-new");
    expect(hiddenTab.sessionId).toBe("session-new");
    expect(hiddenLeaf.restoring).toBe(false);
    expect(hiddenLeaf.savedSessionId).toBeUndefined();
  });

  it("setTabDisconnected、reconnectTab、setTabDirty 能回写隐藏布局", async () => {
    mockTauriInvoke({ create_terminal_session: "session-reconnected" });
    const tab = makeTerminalTab("hidden-tab");
    tab.ssh = {
      host: "example.com",
      port: 22,
      user: "root",
      remotePath: "/tmp/hidden-tab",
    };
    tab.machineName = "远端";
    const leaf = tab.terminalRootPane as TerminalPaneLeaf;
    leaf.ssh = tab.ssh;
    usePanesStore.setState((state) => {
      state.layouts.push(makeLayout("layout-hidden", "隐藏", tab));
    });

    usePanesStore.getState().setTabDisconnected("ignored", "hidden-tab", true, leaf.id);
    usePanesStore.getState().setTabDirty("ignored", "hidden-tab", true);
    const sessionId = await usePanesStore.getState().reconnectTab("ignored", "hidden-tab", leaf.id);

    const hiddenTab = panel(hiddenLayout().rootPane).tabs[0];
    expect(hiddenTab.disconnected).toBe(false);
    expect(hiddenTab.dirty).toBe(true);
    expect(hiddenTab.sessionId).toBe("session-reconnected");
    expect(sessionId).toBe("session-reconnected");
  });

  it("closeTabBySessionId 能删除隐藏布局中的 terminal leaf 或 tab", () => {
    const splitTab = makeSplitTerminalTab("split-tab");
    const singleTab = makeTerminalTab("single-tab", "single-session");
    const hiddenRoot = createPanel(splitTab);
    hiddenRoot.tabs.push(singleTab);
    const hidden: LayoutEntry = {
      id: "layout-hidden",
      name: "隐藏",
      rootPane: hiddenRoot,
      activePaneId: hiddenRoot.id,
    };
    usePanesStore.setState((state) => {
      state.layouts.push(hidden);
    });

    usePanesStore.getState().closeTabBySessionId("session-right");
    let tabs = panel(hiddenLayout().rootPane).tabs;
    expect((tabs[0].terminalRootPane as TerminalPaneLeaf).sessionId).toBe("session-left");
    expect(tabs).toHaveLength(2);

    usePanesStore.getState().closeTabBySessionId("single-session");
    tabs = panel(hiddenLayout().rootPane).tabs;
    expect(tabs.map((tab) => tab.id)).toEqual(["split-tab"]);
  });

  it("updateTabAgentResumeId、markTabReclaimed、getRestorableTabs 能命中隐藏布局", () => {
    const tab = makeTerminalTab("hidden-tab", "session-hidden");
    usePanesStore.setState((state) => {
      state.poppedOutTabs = new Set(["hidden-tab"]);
      state.layouts.push(makeLayout("layout-hidden", "隐藏", tab));
    });

    usePanesStore.getState().updateTabAgentResumeId("session-hidden", "resume-new");
    usePanesStore.getState().markTabReclaimed("hidden-tab");
    const restorable = usePanesStore.getState().getRestorableTabs();

    const hiddenTab = panel(hiddenLayout().rootPane).tabs[0];
    expect(hiddenTab.resumeId).toBe("resume-new");
    expect(hiddenTab.reclaimKey).toBe(1);
    expect(usePanesStore.getState().isTabPoppedOut("hidden-tab")).toBe(false);
    expect(restorable.some((item) => item.tab.id === "hidden-tab")).toBe(true);
  });

  it("findTabAcrossLayouts 返回目标 layoutId", () => {
    usePanesStore.setState((state) => {
      state.layouts.push(makeLayout("layout-hidden", "隐藏", makeTerminalTab("hidden-tab")));
    });

    const location = usePanesStore.getState().findTabAcrossLayouts("hidden-tab");
    expect(location?.layoutId).toBe("layout-hidden");
    expect(location?.tab.id).toBe("hidden-tab");
  });

  it("findPaneAcrossLayouts 返回隐藏布局 pane 位置", () => {
    const hidden = makeLayout("layout-hidden", "隐藏", makeTerminalTab("hidden-tab"));
    usePanesStore.setState((state) => {
      state.layouts.push(hidden);
    });

    const location = usePanesStore.getState().findPaneAcrossLayouts(hidden.rootPane.id);

    expect(location?.layoutId).toBe("layout-hidden");
    expect(location?.pane.id).toBe(hidden.rootPane.id);
  });

  it("migrate v3 到 v4 时把 rootPane 装箱成单 layout", () => {
    const rootPane = createPanel(makeTerminalTab("old-tab"));
    const options = usePanesStore.persist.getOptions();

    const migrated = options.migrate?.({ rootPane, activePaneId: rootPane.id }, 3) as Record<string, unknown>;

    expect(migrated.rootPane).toBeUndefined();
    expect(migrated.activePaneId).toBeUndefined();
    const layouts = migrated.layouts as LayoutEntry[];
    expect(layouts.filter((layout) => layout.kind !== "starred")).toHaveLength(1);
    expect(layouts[0].name).toBe("布局 1");
    expect(layouts[0].kind).toBe("normal");
    expect(layouts[0].rootPane).toBe(rootPane);
    expect(migrated.currentLayoutId).toBe(layouts[0].id);
  });

  it("partialize 投影当前工作副本到 layouts[current]", () => {
    const currentRoot = usePanesStore.getState().rootPane;
    usePanesStore.getState().addTab(currentRoot.id, {
      projectId: "current",
      projectPath: "/tmp/current",
    });

    const partial = usePanesStore.persist.getOptions().partialize?.(usePanesStore.getState()) as {
      layouts: LayoutEntry[];
      currentLayoutId: string;
    };

    expect(partial.currentLayoutId).toBe("layout-1");
    expect(panel(partial.layouts[0].rootPane).tabs).toHaveLength(2);
  });

  it("merge 对空 layouts、无效 currentLayoutId 和 rehydrated terminal 做兜底", () => {
    const currentState = usePanesStore.getState();
    const merged = usePanesStore.persist.getOptions().merge?.(
      {
        layouts: [],
        currentLayoutId: "missing",
      },
      currentState,
    ) as typeof currentState;

    const mergedNormalLayouts = merged.layouts.filter((layout) => layout.kind !== "starred");
    expect(mergedNormalLayouts).toHaveLength(1);
    expect(merged.layouts.some((layout) => layout.kind === "starred")).toBe(true);
    expect(merged.currentLayoutId).toBe(mergedNormalLayouts[0].id);
    expect(merged.rootPane).toBe(mergedNormalLayouts[0].rootPane);

    const rootPane = createPanel(makeTerminalTab("persisted-tab", "old-session"));
    const restored = usePanesStore.persist.getOptions().merge?.(
      {
        layouts: [{
          id: "persisted",
          name: "持久化",
          rootPane,
          activePaneId: rootPane.id,
        }],
        currentLayoutId: "bad",
      },
      currentState,
    ) as typeof currentState;
    const restoredTab = panel(restored.rootPane).tabs[0];
    const restoredLeaf = restoredTab.terminalRootPane as TerminalPaneLeaf;
    expect(restored.currentLayoutId).toBe("persisted");
    expect(restoredLeaf.sessionId).toBeNull();
    expect(restoredLeaf.savedSessionId).toBe("old-session");
    expect(restoredLeaf.restoring).toBe(true);
  });

  it("当前布局回写 action 修改工作副本而不是隐藏 layout 树", () => {
    const tab = createTab("current", "/tmp/current");
    usePanesStore.setState((state) => {
      const rootPane = createPanel(tab);
      state.rootPane = rootPane;
      state.activePaneId = rootPane.id;
      state.layouts[0].rootPane = createPanel(makeTerminalTab("stale-current"));
      state.layouts[0].activePaneId = state.layouts[0].rootPane.id;
    });

    usePanesStore.getState().updateTabSession("ignored", tab.id, "session-current");

    expect(panel(usePanesStore.getState().rootPane).tabs[0].sessionId).toBe("session-current");
    expect(panel(usePanesStore.getState().layouts[0].rootPane).tabs[0].id).toBe("stale-current");
  });
});
