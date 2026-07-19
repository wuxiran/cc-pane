import { beforeEach, describe, expect, it } from "vitest";
import { TERMINAL_LAYOUT_CHANGED_EVENT, usePanesStore } from "./usePanesStore";
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
  // notifyTerminalLayoutChanged 优先走 requestAnimationFrame（jsdom ~16ms），
  // 只等 setTimeout(0) 会输给 rAF 产生 flaky——两条派发路径都要等到。
  return new Promise((resolve) => {
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => window.setTimeout(resolve, 0));
    } else {
      window.setTimeout(resolve, 0);
    }
  });
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

  it("deleteLayout 不允许删除星标布局", () => {
    const tab = panel(usePanesStore.getState().rootPane).tabs[0];
    usePanesStore.getState().toggleStarTab(tab.id);
    const beforeLayoutIds = usePanesStore.getState().layouts.map((layout) => layout.id);

    usePanesStore.getState().deleteLayout("layout-starred");

    const state = usePanesStore.getState();
    expect(state.layouts.map((layout) => layout.id)).toEqual(beforeLayoutIds);
    expect(state.layouts.some((layout) => layout.kind === "starred")).toBe(true);
    expect(state.layouts.some((layout) => layout.id === "layout-1")).toBe(true);
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

  it("restoreLiveDaemonSessions 能把隐藏布局 restoring tab 重新接回 live daemon session", () => {
    const tab = makeTerminalTab("hidden-tab");
    const leaf = tab.terminalRootPane as TerminalPaneLeaf;
    leaf.sessionId = null;
    leaf.restoring = true;
    leaf.savedSessionId = "daemon-live";
    tab.sessionId = null;
    tab.restoring = true;
    tab.savedSessionId = "daemon-live";
    usePanesStore.setState((state) => {
      state.layouts.push(makeLayout("layout-hidden", "隐藏", tab));
    });

    const restored = usePanesStore.getState().restoreLiveDaemonSessions([{
      sessionId: "daemon-live",
      status: "active",
      lastOutputAt: 10,
      updatedAt: 10,
    }]);

    const hiddenTab = panel(hiddenLayout().rootPane).tabs[0];
    const hiddenLeaf = hiddenTab.terminalRootPane as TerminalPaneLeaf;
    expect(restored).toBe(1);
    expect(hiddenLeaf.sessionId).toBe("daemon-live");
    expect(hiddenTab.sessionId).toBe("daemon-live");
    expect(hiddenLeaf.restoring).toBe(false);
    expect(hiddenLeaf.savedSessionId).toBeUndefined();
  });

  it("restoreLiveDaemonSessions 恢复非 active terminal pane 时不误切 tab 级 session", () => {
    const tab = makeSplitTerminalTab("hidden-tab");
    const root = tab.terminalRootPane as TerminalPaneSplit;
    const left = root.children[0] as TerminalPaneLeaf;
    const right = root.children[1] as TerminalPaneLeaf;
    right.sessionId = null;
    right.restoring = true;
    right.savedSessionId = "daemon-right";
    usePanesStore.setState((state) => {
      state.layouts.push(makeLayout("layout-hidden", "隐藏", tab));
    });

    const restored = usePanesStore.getState().restoreLiveDaemonSessions([{
      sessionId: "daemon-right",
      status: "thinking",
      lastOutputAt: 10,
      updatedAt: 10,
    }]);

    const hiddenTab = panel(hiddenLayout().rootPane).tabs[0];
    const hiddenRoot = hiddenTab.terminalRootPane as TerminalPaneSplit;
    const hiddenLeft = hiddenRoot.children[0] as TerminalPaneLeaf;
    const hiddenRight = hiddenRoot.children[1] as TerminalPaneLeaf;
    expect(restored).toBe(1);
    expect(hiddenRight.sessionId).toBe("daemon-right");
    expect(hiddenRight.restoring).toBe(false);
    expect(hiddenRight.savedSessionId).toBeUndefined();
    expect(hiddenLeft.sessionId).toBe("session-left");
    expect(hiddenTab.sessionId).toBe(left.sessionId);
    expect(hiddenTab.activeTerminalPaneId).toBe(left.id);
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
    // 不上提：保留单 child split 壳，幸存 leaf 留在壳内
    const shell = tabs[0].terminalRootPane as TerminalPaneSplit;
    expect(shell.type).toBe("split");
    expect(shell.children).toHaveLength(1);
    expect((shell.children[0] as TerminalPaneLeaf).sessionId).toBe("session-left");
    expect(tabs).toHaveLength(2);

    usePanesStore.getState().closeTabBySessionId("single-session");
    tabs = panel(hiddenLayout().rootPane).tabs;
    expect(tabs.map((tab) => tab.id)).toEqual(["split-tab"]);
  });

  it("closeTabBySessionId 能关闭星标布局中的标签", () => {
    const starredTab = makeTerminalTab("starred-tab", "session-starred");
    usePanesStore.setState((state) => {
      const starred = state.layouts.find((layout) => layout.kind === "starred");
      panel(starred!.rootPane).tabs.push(starredTab);
    });

    const result = usePanesStore.getState().closeTabBySessionId("session-starred");

    expect(result).toEqual({ closed: 1, blockedByPinned: 0 });
    const starred = usePanesStore.getState().layouts.find((layout) => layout.kind === "starred");
    expect(panel(starred!.rootPane).tabs.map((tab) => tab.id)).not.toContain("starred-tab");
  });

  it("closeTabBySessionId 对同一会话在普通布局和星标布局的镜像各关一次", () => {
    const normalTab = makeTerminalTab("normal-tab", "session-mirrored");
    const keepAlive = makeTerminalTab("keep-normal", "session-other");
    const starredTab = makeTerminalTab("starred-mirror", "session-mirrored");
    usePanesStore.setState((state) => {
      panel(state.rootPane).tabs.push(normalTab, keepAlive);
      const starred = state.layouts.find((layout) => layout.kind === "starred");
      panel(starred!.rootPane).tabs.push(starredTab);
    });

    const result = usePanesStore.getState().closeTabBySessionId("session-mirrored");

    expect(result).toEqual({ closed: 2, blockedByPinned: 0 });
    const state = usePanesStore.getState();
    const normalTabIds = panel(state.rootPane).tabs.map((tab) => tab.id);
    expect(normalTabIds).not.toContain("normal-tab");
    expect(normalTabIds).toContain("keep-normal");
    const starred = state.layouts.find((layout) => layout.kind === "starred");
    expect(panel(starred!.rootPane).tabs.map((tab) => tab.id)).not.toContain("starred-mirror");
  });

  it("closeTabBySessionId 对 pinned 标签不谎报关闭成功", () => {
    const pinnedTab = { ...makeTerminalTab("pinned-tab", "session-pinned"), pinned: true };
    const sibling = makeTerminalTab("sibling-tab", "session-sibling");
    usePanesStore.setState((state) => {
      panel(state.rootPane).tabs.push(pinnedTab, sibling);
    });

    const result = usePanesStore.getState().closeTabBySessionId("session-pinned");

    // 后端 kill 被 pinned 吞掉：标签必须留着，且结果如实反映没关成
    expect(result).toEqual({ closed: 0, blockedByPinned: 1 });
    expect(panel(usePanesStore.getState().rootPane).tabs.map((tab) => tab.id)).toContain(
      "pinned-tab"
    );
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

  it("exportLayoutSnapshotPayload 导出当前布局工作副本", () => {
    const currentRoot = usePanesStore.getState().rootPane;
    usePanesStore.getState().addTab(currentRoot.id, {
      projectId: "snapshot",
      projectPath: "/tmp/snapshot",
    });

    const payload = usePanesStore.getState().exportLayoutSnapshotPayload();

    expect(payload.schemaVersion).toBe(2);
    expect(payload.currentLayoutId).toBe("layout-1");
    const tabs = panel(payload.layouts[0].rootPane).tabs;
    expect(tabs[tabs.length - 1]?.projectPath).toBe("/tmp/snapshot");
  });

  it("applyLayoutSnapshotPayload 导入后把 live session 标记为待恢复", () => {
    const rootPane = createPanel(makeTerminalTab("remote-tab", "session-remote"));
    const applied = usePanesStore.getState().applyLayoutSnapshotPayload({
      schemaVersion: 1,
      layouts: [{
        id: "remote-layout",
        name: "远端布局",
        kind: "normal",
        rootPane,
        activePaneId: rootPane.id,
      }],
      currentLayoutId: "remote-layout",
    });

    expect(applied).toBe(true);
    expect(usePanesStore.getState().currentLayoutId).toBe("remote-layout");
    const tab = panel(usePanesStore.getState().rootPane).tabs[0];
    const leaf = tab.terminalRootPane as TerminalPaneLeaf;
    expect(leaf.sessionId).toBeNull();
    expect(leaf.savedSessionId).toBe("session-remote");
    expect(leaf.restoring).toBe(true);
  });

  it("applyLayoutSnapshotPayload 接受 v1/v2，拒绝未知的更高版本", () => {
    const buildPayload = (schemaVersion: number) => {
      const rootPane = createPanel(makeTerminalTab(`tab-v${schemaVersion}`));
      return {
        schemaVersion,
        layouts: [{
          id: `layout-v${schemaVersion}`,
          name: `v${schemaVersion}`,
          kind: "normal" as const,
          rootPane,
          activePaneId: rootPane.id,
        }],
        currentLayoutId: `layout-v${schemaVersion}`,
      };
    };

    expect(usePanesStore.getState().applyLayoutSnapshotPayload(buildPayload(1))).toBe(true);
    expect(usePanesStore.getState().applyLayoutSnapshotPayload(buildPayload(2))).toBe(true);
    expect(usePanesStore.getState().applyLayoutSnapshotPayload(buildPayload(3))).toBe(false);
    expect(usePanesStore.getState().currentLayoutId).toBe("layout-v2");
  });

  it("快照导出保留 workspaceName / lastActiveAt 绑定字段", () => {
    usePanesStore.getState().bindLayoutWorkspace("layout-1", "ws-a");
    usePanesStore.setState((state) => {
      state.layouts[0].lastActiveAt = 12345;
    });

    const payload = usePanesStore.getState().exportLayoutSnapshotPayload();

    expect(payload.layouts[0].workspaceName).toBe("ws-a");
    expect(payload.layouts[0].lastActiveAt).toBe(12345);
  });

  it("bindLayoutWorkspace / unbindLayoutWorkspace 只作用于普通布局", () => {
    usePanesStore.getState().bindLayoutWorkspace("layout-1", "  ws-a  ");
    usePanesStore.getState().bindLayoutWorkspace("layout-starred", "ws-a");
    usePanesStore.getState().bindLayoutWorkspace("layout-1", "  ");

    let state = usePanesStore.getState();
    expect(state.layouts.find((l) => l.id === "layout-1")?.workspaceName).toBe("ws-a");
    expect(state.layouts.find((l) => l.id === "layout-starred")?.workspaceName).toBeUndefined();

    usePanesStore.getState().unbindLayoutWorkspace("layout-1");
    state = usePanesStore.getState();
    expect(state.layouts.find((l) => l.id === "layout-1")?.workspaceName).toBeUndefined();
  });

  it("createLayout / switchLayout 打 lastActiveAt 最近使用时间", () => {
    const before = Date.now();
    const id = usePanesStore.getState().createLayout("绑定测试");
    const created = usePanesStore.getState().layouts.find((l) => l.id === id);
    expect(created?.lastActiveAt).toBeGreaterThanOrEqual(before);

    usePanesStore.getState().switchLayout("layout-1");
    const switched = usePanesStore.getState().layouts.find((l) => l.id === "layout-1");
    expect(switched?.lastActiveAt).toBeGreaterThanOrEqual(before);
  });

  it("openProject 带 targetLayoutId 时先切到目标布局再落位", () => {
    const hidden = makeLayout("layout-hidden", "隐藏", makeTerminalTab("hidden-tab"));
    usePanesStore.setState((state) => {
      state.layouts.push(hidden);
    });

    usePanesStore.getState().openProject({
      projectId: "proj-target",
      projectPath: "/tmp/proj-target",
      targetLayoutId: "layout-hidden",
    });

    const state = usePanesStore.getState();
    expect(state.currentLayoutId).toBe("layout-hidden");
    expect(panel(state.rootPane).tabs.some((tab) => tab.projectPath === "/tmp/proj-target")).toBe(true);
  });

  it("openProject 的 targetLayoutId 指向星标/不存在布局时留在当前布局", () => {
    usePanesStore.getState().openProject({
      projectId: "proj-starred",
      projectPath: "/tmp/proj-starred",
      targetLayoutId: "layout-starred",
    });
    expect(usePanesStore.getState().currentLayoutId).toBe("layout-1");

    usePanesStore.getState().openProject({
      projectId: "proj-missing",
      projectPath: "/tmp/proj-missing",
      targetLayoutId: "layout-missing",
    });
    expect(usePanesStore.getState().currentLayoutId).toBe("layout-1");
  });

  it("移动端选择 pane/tab 会触发布局快照保存事件", async () => {
    const firstTab = createTab("first", "/tmp/first");
    const secondTab = createTab("second", "/tmp/second");
    const rootPane = createPanel(firstTab);
    rootPane.tabs.push(secondTab);
    const secondPane = createPanel(createTab("other", "/tmp/other"));

    usePanesStore.setState((state) => {
      state.rootPane = {
        type: "split",
        id: "split-root",
        direction: "horizontal",
        children: [rootPane, secondPane],
        sizes: [50, 50],
      };
      state.activePaneId = rootPane.id;
      state.layouts[0].rootPane = state.rootPane;
      state.layouts[0].activePaneId = rootPane.id;
    });

    const reasons: string[] = [];
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ reason?: string }>).detail;
      if (detail?.reason) reasons.push(detail.reason);
    };
    window.addEventListener(TERMINAL_LAYOUT_CHANGED_EVENT, listener);

    usePanesStore.getState().setActivePane(secondPane.id);
    usePanesStore.getState().selectTab(rootPane.id, secondTab.id);
    await waitForMicrotasks();

    window.removeEventListener(TERMINAL_LAYOUT_CHANGED_EVENT, listener);
    expect(reasons).toContain("pane.activate");
    expect(reasons).toContain("tab.select");
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
