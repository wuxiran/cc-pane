import { describe, it, expect, beforeEach, vi } from "vitest";
import { TERMINAL_LAYOUT_CHANGED_EVENT, usePanesStore } from "./usePanesStore";
import { useTerminalStatusStore } from "./useTerminalStatusStore";
import { createPanel } from "./paneTreeHelpers";
import {
  resetTestDataCounter,
} from "@/test/utils/testData";
import type { PaneNode, Panel, SplitPane, Tab } from "@/types";

describe("usePanesStore", () => {
  beforeEach(() => {
    resetTestDataCounter();
    const initialPanel = createPanel();
    usePanesStore.setState({
      rootPane: initialPanel,
      activePaneId: initialPanel.id,
      layouts: [{
        id: "layout-1",
        name: "布局 1",
        rootPane: initialPanel,
        activePaneId: initialPanel.id,
      }],
      currentLayoutId: "layout-1",
      closedTabs: [],
    });
    useTerminalStatusStore.setState({ statusMap: new Map() });
  });

  // ========== 派生方法 ==========

  describe("allPanels", () => {
    it("单面板应返回 1 个面板", () => {
      const panels = usePanesStore.getState().allPanels();
      expect(panels).toHaveLength(1);
      expect(panels[0].type).toBe("panel");
    });

    it("分屏后应返回 2 个面板", () => {
      const { rootPane, splitRight } = usePanesStore.getState();
      splitRight(rootPane.id);

      const panels = usePanesStore.getState().allPanels();
      expect(panels).toHaveLength(2);
    });
  });

  describe("activePane", () => {
    it("应返回当前活动面板", () => {
      const active = usePanesStore.getState().activePane();
      expect(active).not.toBeNull();
      expect(active!.type).toBe("panel");
      expect(active!.id).toBe(usePanesStore.getState().activePaneId);
    });
  });

  describe("findPaneById", () => {
    it("找到面板时应返回节点", () => {
      const { rootPane, findPaneById } = usePanesStore.getState();
      const found = findPaneById(rootPane.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(rootPane.id);
    });

    it("找不到面板时应返回 null", () => {
      const found = usePanesStore.getState().findPaneById("non-existent");
      expect(found).toBeNull();
    });
  });

  // ========== 分屏操作 ==========

  describe("splitRight", () => {
    it("应将 rootPane 变为水平分割并包含 2 个子面板", () => {
      const { rootPane, splitRight } = usePanesStore.getState();
      splitRight(rootPane.id);

      const state = usePanesStore.getState();
      expect(state.rootPane.type).toBe("split");
      const split = state.rootPane as SplitPane;
      expect(split.direction).toBe("horizontal");
      expect(split.children).toHaveLength(2);
      expect(split.sizes).toEqual([50, 50]);
    });
  });

  describe("splitDown", () => {
    it("应将 rootPane 变为垂直分割", () => {
      const { rootPane, splitDown } = usePanesStore.getState();
      splitDown(rootPane.id);

      const state = usePanesStore.getState();
      expect(state.rootPane.type).toBe("split");
      const split = state.rootPane as SplitPane;
      expect(split.direction).toBe("vertical");
      expect(split.children).toHaveLength(2);
    });
  });

  describe("closePane", () => {
    it("关闭分屏中的一个面板后应保留单 child split 壳（幸存面板不 remount）", () => {
      const { rootPane, splitRight } = usePanesStore.getState();
      const originalPanelId = rootPane.id;
      splitRight(rootPane.id);
      const splitId = usePanesStore.getState().rootPane.id;

      const panels = usePanesStore.getState().allPanels();
      expect(panels).toHaveLength(2);

      // 关闭第二个面板（新建的那个，即活动面板）
      const activePaneId = usePanesStore.getState().activePaneId;
      usePanesStore.getState().closePane(activePaneId);

      const stateAfter = usePanesStore.getState();
      // 不上提：split 壳保留（组件类型/key 不变），幸存 panel id 不变
      expect(stateAfter.rootPane.type).toBe("split");
      const shell = stateAfter.rootPane as SplitPane;
      expect(shell.id).toBe(splitId);
      expect(shell.children).toHaveLength(1);
      expect(shell.children[0].id).toBe(originalPanelId);
      expect(shell.sizes).toEqual([100]);
      // activePaneId 应指向存活面板
      expect(stateAfter.activePaneId).toBe(originalPanelId);
    });

    it("关闭嵌套分屏中的一个面板后应保留退化 split 壳并归一化 sizes", () => {
      const store = usePanesStore.getState();
      const firstPaneId = store.rootPane.id;
      store.splitRight(firstPaneId);

      const secondPaneId = usePanesStore.getState().activePaneId;
      store.splitDown(secondPaneId);

      const root = usePanesStore.getState().rootPane as SplitPane;
      expect(root.type).toBe("split");

      const nestedSplit = root.children.find((child) => child.id !== firstPaneId) as SplitPane;
      const nestedActivePaneId = nestedSplit.children[1].id;

      usePanesStore.getState().closePane(nestedActivePaneId);

      const stateAfter = usePanesStore.getState();
      expect(stateAfter.rootPane.type).toBe("split");
      const normalizedRoot = stateAfter.rootPane as SplitPane;
      expect(normalizedRoot.children).toHaveLength(2);
      // 嵌套 split 退化为单 child 壳，幸存 panel 留在壳内
      const survivedShell = normalizedRoot.children.find((child) => child.id === nestedSplit.id) as SplitPane;
      expect(survivedShell.type).toBe("split");
      expect(survivedShell.children).toHaveLength(1);
      expect(survivedShell.children[0].id).toBe(secondPaneId);
      expect(survivedShell.sizes).toEqual([100]);
    });

    it("单 child 壳上再次分屏应复用壳节点（含异方向）", () => {
      const { rootPane, splitRight } = usePanesStore.getState();
      const originalPanelId = rootPane.id;
      splitRight(rootPane.id);
      const splitId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().closePane(usePanesStore.getState().activePaneId);

      // 壳上异方向再分屏：改造壳而非再包一层
      usePanesStore.getState().splitDown(originalPanelId);

      const root = usePanesStore.getState().rootPane as SplitPane;
      expect(root.id).toBe(splitId);
      expect(root.direction).toBe("vertical");
      expect(root.children).toHaveLength(2);
      expect(root.children[0].id).toBe(originalPanelId);
      expect(root.sizes).toEqual([50, 50]);
    });

    it("关闭根面板应重置为新空面板", () => {
      const { rootPane, closePane } = usePanesStore.getState();
      const originalId = rootPane.id;
      closePane(rootPane.id);

      const state = usePanesStore.getState();
      expect(state.rootPane.type).toBe("panel");
      expect(state.rootPane.id).not.toBe(originalId);
    });

    it("关闭面板时应保存可恢复标签到 closedTabs", () => {
      // 先给当前面板添加一个有 projectPath 的终端标签
      const state = usePanesStore.getState();
      const paneId = state.rootPane.id;
      state.addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/project1" });

      // 关闭面板
      usePanesStore.getState().closePane(paneId);

      const closedTabs = usePanesStore.getState().closedTabs;
      // 默认标签没有 projectPath（空字符串），但新添加的有
      expect(closedTabs.length).toBeGreaterThanOrEqual(1);
      expect(closedTabs.some((t) => t.projectPath === "/tmp/project1")).toBe(true);
    });
  });

  describe("resizePanes", () => {
    it("应更新 split 的 sizes 数组", () => {
      const { rootPane, splitRight } = usePanesStore.getState();
      splitRight(rootPane.id);

      const splitId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().resizePanes(splitId, [30, 70]);

      const split = usePanesStore.getState().rootPane as SplitPane;
      expect(split.sizes).toEqual([30, 70]);
    });

    it("应通知终端布局变化", async () => {
      const dispatchEvent = vi.spyOn(window, "dispatchEvent");
      const { rootPane, splitRight } = usePanesStore.getState();
      splitRight(rootPane.id);
      dispatchEvent.mockClear();

      const splitId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().resizePanes(splitId, [35, 65]);
      await new Promise((resolve) => requestAnimationFrame(resolve));

      expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: TERMINAL_LAYOUT_CHANGED_EVENT,
        detail: { reason: "pane.resize" },
      }));
      dispatchEvent.mockRestore();
    });
  });

  // ========== 标签操作 ==========

  describe("addTab", () => {
    it("应增加 tab 数量并设为活动标签", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      const tabsBefore = (usePanesStore.getState().rootPane as Panel).tabs.length;

      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });

      const pane = usePanesStore.getState().rootPane as Panel;
      expect(pane.tabs.length).toBe(tabsBefore + 1);
      expect(pane.activeTabId).toBe(pane.tabs[pane.tabs.length - 1].id);
    });
  });

  describe("adoptSession", () => {
    it("应把无主会话建成当前布局的活动 tab，并写成待 reattach 的 savedSession", () => {
      const tabId = usePanesStore.getState().adoptSession("orphan-session-1", {
        projectPath: "/tmp/proj1",
        workspaceName: "ws-a",
        cliTool: "claude",
      });

      expect(tabId).not.toBeNull();
      const pane = usePanesStore.getState().rootPane as Panel;
      const tab = pane.tabs.find((item) => item.id === tabId);
      expect(pane.activeTabId).toBe(tabId);
      expect(tab?.workspaceName).toBe("ws-a");

      const leaf = tab?.terminalRootPane;
      expect(leaf?.type).toBe("leaf");
      // 关键：写 savedSessionId + restoring 而非 sessionId，交给 TerminalView 重连既有 PTY
      expect(leaf?.type === "leaf" ? leaf.savedSessionId : null).toBe("orphan-session-1");
      expect(leaf?.type === "leaf" ? leaf.restoring : null).toBe(true);
      expect(leaf?.type === "leaf" ? leaf.sessionId : "x").toBeNull();
    });

    it("会话已被 tab 引用时不重复建 tab，返回既有 tabId", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, {
        projectId: "proj-1",
        projectPath: "/tmp/proj1",
        sessionId: "live-session-1",
      });
      const tabsBefore = (usePanesStore.getState().rootPane as Panel).tabs.length;

      const tabId = usePanesStore.getState().adoptSession("live-session-1", {
        projectPath: "/tmp/proj1",
      });

      const pane = usePanesStore.getState().rootPane as Panel;
      expect(pane.tabs.length).toBe(tabsBefore);
      expect(pane.tabs.some((item) => item.id === tabId)).toBe(true);
    });
  });

  describe("canCreateTerminalSession", () => {
    it("仅允许后端复用 expected session 时忽略提前到达的 live 状态", () => {
      const tabId = usePanesStore.getState().adoptSession("expected-session", {
        projectPath: "/tmp/proj1",
      });
      expect(tabId).not.toBeNull();

      const pane = usePanesStore.getState().rootPane as Panel;
      const tab = pane.tabs.find((item) => item.id === tabId)!;
      const leaf = tab.terminalRootPane!;
      expect(leaf.type).toBe("leaf");

      useTerminalStatusStore.getState().markSessionLive("expected-session");

      expect(usePanesStore.getState().canCreateTerminalSession(
        tab.id,
        leaf.id,
        "expected-session",
      )).toBe(false);
      expect(usePanesStore.getState().canCreateTerminalSession(
        tab.id,
        leaf.id,
        "expected-session",
        true,
      )).toBe(true);
      expect(usePanesStore.getState().canCreateTerminalSession(
        tab.id,
        leaf.id,
        "different-session",
        true,
      )).toBe(false);
    });
  });

  describe("closeTab", () => {
    it("多 tab 面板应移除 tab 并更新 activeTabId", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });
      usePanesStore.getState().addTab(paneId, { projectId: "proj-2", projectPath: "/tmp/proj2" });

      const pane = usePanesStore.getState().rootPane as Panel;
      expect(pane.tabs).toHaveLength(3);

      const tabToClose = pane.tabs[1];
      usePanesStore.getState().closeTab(paneId, tabToClose.id);

      const paneAfter = usePanesStore.getState().rootPane as Panel;
      expect(paneAfter.tabs).toHaveLength(2);
      expect(paneAfter.tabs.find((t) => t.id === tabToClose.id)).toBeUndefined();
    });

    it("单 tab 面板应触发 closePane", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      const tab = (usePanesStore.getState().rootPane as Panel).tabs[0];

      usePanesStore.getState().closeTab(paneId, tab.id);

      // closePane 对根面板会创建新面板
      const state = usePanesStore.getState();
      expect(state.rootPane.type).toBe("panel");
      expect(state.rootPane.id).not.toBe(paneId);
    });

    it("pinned tab 不可关闭", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });

      const pane = usePanesStore.getState().rootPane as Panel;
      const tabId = pane.tabs[0].id;

      // 先 pin 该 tab
      usePanesStore.getState().togglePinTab(paneId, tabId);
      // 尝试关闭
      usePanesStore.getState().closeTab(paneId, tabId);

      const paneAfter = usePanesStore.getState().rootPane as Panel;
      expect(paneAfter.tabs.find((t) => t.id === tabId)).toBeDefined();
    });

    it("关闭终端标签时应保存到 closedTabs", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });
      usePanesStore.getState().addTab(paneId, { projectId: "proj-2", projectPath: "/tmp/proj2" });

      const pane = usePanesStore.getState().rootPane as Panel;
      // 关闭第二个 tab（有 projectPath 的终端标签）
      const tabToClose = pane.tabs[1];
      usePanesStore.getState().closeTab(paneId, tabToClose.id);

      const closedTabs = usePanesStore.getState().closedTabs;
      expect(closedTabs).toHaveLength(1);
      expect(closedTabs[0].projectPath).toBe(tabToClose.projectPath);
    });
  });

  describe("togglePinTab", () => {
    it("应切换 pinned 状态", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      const tabId = (usePanesStore.getState().rootPane as Panel).tabs[0].id;

      usePanesStore.getState().togglePinTab(paneId, tabId);
      let tab = (usePanesStore.getState().rootPane as Panel).tabs[0];
      expect(tab.pinned).toBe(true);

      usePanesStore.getState().togglePinTab(paneId, tabId);
      tab = (usePanesStore.getState().rootPane as Panel).tabs[0];
      expect(tab.pinned).toBe(false);
    });
  });

  describe("renameTab", () => {
    it("应更新 title", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      const tabId = (usePanesStore.getState().rootPane as Panel).tabs[0].id;

      usePanesStore.getState().renameTab(paneId, tabId, "新名称");

      const tab = (usePanesStore.getState().rootPane as Panel).tabs[0];
      expect(tab.title).toBe("新名称");
    });
  });

  describe("terminal subpanes", () => {
    it("为调用方预先创建的 PTY 保留同一个 launchId", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, {
        projectId: "stable-project-id",
        projectPath: "/tmp/proj1",
        launchId: "launch-precreated",
        sessionId: "pty-precreated",
      });

      const pane = usePanesStore.getState().rootPane as Panel;
      const tab = pane.tabs[1];
      const leaf = tab.terminalRootPane;
      expect(leaf?.type).toBe("leaf");
      if (leaf?.type !== "leaf") throw new Error("expected terminal leaf");
      expect(leaf.launchId).toBe("launch-precreated");
    });

    it("应拆分终端标签并创建新的活动子窗格", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });

      const pane = usePanesStore.getState().rootPane as Panel;
      const tab = pane.tabs[1];
      const originalTerminalPaneId = tab.activeTerminalPaneId!;

      usePanesStore.getState().splitTerminalPane(tab.id, originalTerminalPaneId, "right");

      const updatedTab = ((usePanesStore.getState().rootPane as Panel).tabs[1]) as Tab;
      expect(updatedTab.terminalRootPane?.type).toBe("split");
      expect(updatedTab.activeTerminalPaneId).not.toBe(originalTerminalPaneId);
      expect(updatedTab.sessionId).toBeNull();
      const leaves = (updatedTab.terminalRootPane as { children: Array<{ launchId?: string }> }).children;
      expect(leaves[0].launchId).toBeTruthy();
      expect(leaves[1].launchId).toBeTruthy();
      expect(leaves[1].launchId).not.toBe(leaves[0].launchId);
    });

    it("关闭活动子窗格后应保留另一个子窗格（split 壳不上提）", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });

      let tab = ((usePanesStore.getState().rootPane as Panel).tabs[1]) as Tab;
      usePanesStore.getState().splitTerminalPane(tab.id, tab.activeTerminalPaneId!, "right");

      tab = ((usePanesStore.getState().rootPane as Panel).tabs[1]) as Tab;
      const closingTerminalPaneId = tab.activeTerminalPaneId!;

      usePanesStore.getState().closeTerminalPane(tab.id, closingTerminalPaneId);

      const updatedTab = ((usePanesStore.getState().rootPane as Panel).tabs[1]) as Tab;
      // 不上提：保留单 child split 壳，幸存 leaf 不 remount
      expect(updatedTab.terminalRootPane?.type).toBe("split");
      const shell = updatedTab.terminalRootPane as { children: Array<{ type: string; id: string }>; sizes: number[] };
      expect(shell.children).toHaveLength(1);
      expect(shell.children[0].type).toBe("leaf");
      expect(shell.sizes).toEqual([100]);
      expect(updatedTab.activeTerminalPaneId).not.toBe(closingTerminalPaneId);
      expect(updatedTab.activeTerminalPaneId).toBe(shell.children[0].id);
    });

    it("终端单 child 壳上再次分屏应复用壳节点（含异方向）", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });

      let tab = ((usePanesStore.getState().rootPane as Panel).tabs[1]) as Tab;
      usePanesStore.getState().splitTerminalPane(tab.id, tab.activeTerminalPaneId!, "right");
      tab = ((usePanesStore.getState().rootPane as Panel).tabs[1]) as Tab;
      usePanesStore.getState().closeTerminalPane(tab.id, tab.activeTerminalPaneId!);

      tab = ((usePanesStore.getState().rootPane as Panel).tabs[1]) as Tab;
      const shellId = tab.terminalRootPane!.id;
      const survivorId = tab.activeTerminalPaneId!;

      usePanesStore.getState().splitTerminalPane(tab.id, survivorId, "down");

      const updatedTab = ((usePanesStore.getState().rootPane as Panel).tabs[1]) as Tab;
      const shell = updatedTab.terminalRootPane as { id: string; direction: string; children: Array<{ id: string }>; sizes: number[] };
      expect(shell.id).toBe(shellId);
      expect(shell.direction).toBe("vertical");
      expect(shell.children).toHaveLength(2);
      expect(shell.children[0].id).toBe(survivorId);
      expect(shell.sizes).toEqual([50, 50]);
    });

    it("更新指定子窗格会话时应同步到活动标签镜像字段", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });

      let tab = ((usePanesStore.getState().rootPane as Panel).tabs[1]) as Tab;
      usePanesStore.getState().splitTerminalPane(tab.id, tab.activeTerminalPaneId!, "right");

      tab = ((usePanesStore.getState().rootPane as Panel).tabs[1]) as Tab;
      const activeTerminalPaneId = tab.activeTerminalPaneId!;
      usePanesStore.getState().updateTabSession(paneId, tab.id, "session-subpane", activeTerminalPaneId);

      const updatedTab = ((usePanesStore.getState().rootPane as Panel).tabs[1]) as Tab;
      expect(updatedTab.sessionId).toBe("session-subpane");
    });
  });

  describe("applyLayoutSnapshotPayload", () => {
    it("导入快照时应压平运行期留下的单 child split 壳链", () => {
      const panel = createPanel();
      const shellChain: SplitPane = {
        type: "split",
        id: "split-outer",
        direction: "horizontal",
        children: [{
          type: "split",
          id: "split-inner",
          direction: "vertical",
          children: [panel],
          sizes: [100],
        }],
        sizes: [100],
      };

      const applied = usePanesStore.getState().applyLayoutSnapshotPayload({
        schemaVersion: 1,
        layouts: [{
          id: "layout-imported",
          name: "布局 1",
          kind: "normal",
          rootPane: shellChain,
          activePaneId: panel.id,
        }],
        currentLayoutId: "layout-imported",
      });

      expect(applied).toBe(true);
      const state = usePanesStore.getState();
      expect(state.rootPane.type).toBe("panel");
      expect(state.rootPane.id).toBe(panel.id);
    });
  });

  describe("reorderTabs", () => {
    it("应改变 tab 顺序", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });
      usePanesStore.getState().addTab(paneId, { projectId: "proj-2", projectPath: "/tmp/proj2" });

      const paneBefore = usePanesStore.getState().rootPane as Panel;
      const firstTabId = paneBefore.tabs[0].id;
      const lastTabId = paneBefore.tabs[2].id;

      usePanesStore.getState().reorderTabs(paneId, 0, 2);

      const paneAfter = usePanesStore.getState().rootPane as Panel;
      expect(paneAfter.tabs[2].id).toBe(firstTabId);
      expect(paneAfter.tabs[1].id).toBe(lastTabId);
    });
  });

  describe("moveTab", () => {
    it("应跨面板移动 tab", () => {
      const { rootPane, splitRight } = usePanesStore.getState();
      const firstPaneId = rootPane.id;

      // 在第一个面板添加额外 tab
      usePanesStore.getState().addTab(firstPaneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });

      splitRight(firstPaneId);

      const panels = usePanesStore.getState().allPanels();
      const secondPaneId = panels.find((p) => p.id !== firstPaneId)!.id;

      // 获取第一个面板的第一个 tab
      const firstPanel = panels.find((p) => p.id === firstPaneId) as Panel;
      const tabToMove = firstPanel.tabs[0].id;

      usePanesStore.getState().moveTab(firstPaneId, secondPaneId, tabToMove);

      const panelsAfter = usePanesStore.getState().allPanels();
      const fromPane = panelsAfter.find((p) => p.id === firstPaneId) as Panel;
      const toPane = panelsAfter.find((p) => p.id === secondPaneId) as Panel;

      expect(fromPane.tabs.find((t) => t.id === tabToMove)).toBeUndefined();
      expect(toPane.tabs.find((t) => t.id === tabToMove)).toBeDefined();
    });

    it("应在关闭空源面板后保持目标面板为活动状态", () => {
      const { rootPane, splitRight } = usePanesStore.getState();
      const firstPaneId = rootPane.id;

      splitRight(firstPaneId);

      const panels = usePanesStore.getState().allPanels();
      const secondPaneId = panels.find((p) => p.id !== firstPaneId)!.id;
      const firstPane = panels.find((p) => p.id === firstPaneId) as Panel;
      const tabToMove = firstPane.tabs[0].id;

      usePanesStore.getState().moveTab(firstPaneId, secondPaneId, tabToMove);

      const stateAfter = usePanesStore.getState();
      const targetPane = stateAfter.findPaneById(secondPaneId) as Panel;

      expect(stateAfter.activePaneId).toBe(secondPaneId);
      expect(stateAfter.findPaneById(firstPaneId)).toBeNull();
      expect(targetPane.activeTabId).toBe(tabToMove);
      expect(targetPane.tabs.some((t) => t.id === tabToMove)).toBe(true);
    });
  });

  describe("minimizeTab", () => {
    it("应将 tab 设为 minimized 并切换活动标签", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });

      const pane = usePanesStore.getState().rootPane as Panel;
      const firstTabId = pane.tabs[0].id;
      const secondTabId = pane.tabs[1].id;

      // 选中第一个 tab，然后最小化它
      usePanesStore.getState().selectTab(paneId, firstTabId);
      usePanesStore.getState().minimizeTab(paneId, firstTabId);

      const paneAfter = usePanesStore.getState().rootPane as Panel;
      const minimizedTab = paneAfter.tabs.find((t) => t.id === firstTabId)!;
      expect(minimizedTab.minimized).toBe(true);
      // 活动标签应切换到第二个
      expect(paneAfter.activeTabId).toBe(secondTabId);
    });
  });

  describe("restoreTab", () => {
    it("应恢复 minimized 状态并设为活动标签", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });

      const pane = usePanesStore.getState().rootPane as Panel;
      const firstTabId = pane.tabs[0].id;

      // 最小化后恢复
      usePanesStore.getState().minimizeTab(paneId, firstTabId);
      usePanesStore.getState().restoreTab(paneId, firstTabId);

      const paneAfter = usePanesStore.getState().rootPane as Panel;
      const restoredTab = paneAfter.tabs.find((t) => t.id === firstTabId)!;
      expect(restoredTab.minimized).toBe(false);
      expect(paneAfter.activeTabId).toBe(firstTabId);
    });
  });

  describe("selectTab", () => {
    it("应更新 activeTabId 和 activePaneId", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });

      const pane = usePanesStore.getState().rootPane as Panel;
      const firstTabId = pane.tabs[0].id;

      usePanesStore.getState().selectTab(paneId, firstTabId);

      const stateAfter = usePanesStore.getState();
      expect((stateAfter.rootPane as Panel).activeTabId).toBe(firstTabId);
      expect(stateAfter.activePaneId).toBe(paneId);
    });
  });

  describe("setActivePane", () => {
    it("应更新 activePaneId 到存在的面板", () => {
      const { rootPane, splitRight } = usePanesStore.getState();
      const originalPaneId = rootPane.id;
      // 分屏后新建面板成为活动面板，再切回原面板验证更新生效
      splitRight(originalPaneId);
      expect(usePanesStore.getState().activePaneId).not.toBe(originalPaneId);

      usePanesStore.getState().setActivePane(originalPaneId);
      expect(usePanesStore.getState().activePaneId).toBe(originalPaneId);
    });

    it("忽略不存在的面板 id", () => {
      const originalPaneId = usePanesStore.getState().activePaneId;
      usePanesStore.getState().setActivePane("custom-pane-id");
      expect(usePanesStore.getState().activePaneId).toBe(originalPaneId);
    });
  });

  describe("updateTabSession", () => {
    it("应更新 tab 的 sessionId", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      const tabId = (usePanesStore.getState().rootPane as Panel).tabs[0].id;

      usePanesStore.getState().updateTabSession(paneId, tabId, "session-123");

      const tab = (usePanesStore.getState().rootPane as Panel).tabs[0];
      expect(tab.sessionId).toBe("session-123");
    });

    it("应持久记录结构化启动错误，并在重试时清除错误和递增 attempt", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, {
        projectId: "proj-launch-error",
        projectPath: "/tmp/launch-error",
      });
      let tab = (usePanesStore.getState().rootPane as Panel).tabs[1];
      const leafId = tab.activeTerminalPaneId!;

      usePanesStore.getState().setTerminalLaunchError(tab.id, leafId, {
        code: "PATH_NOT_FOUND",
        message: "Launch directory does not exist",
        params: { path: "/tmp/launch-error" },
      });

      tab = (usePanesStore.getState().rootPane as Panel).tabs[1];
      expect(tab.launchError).toMatchObject({ code: "PATH_NOT_FOUND" });
      expect(tab.terminalRootPane).toMatchObject({
        type: "leaf",
        launchError: { code: "PATH_NOT_FOUND" },
      });

      usePanesStore.getState().retryTerminalLaunch(tab.id, leafId);

      tab = (usePanesStore.getState().rootPane as Panel).tabs[1];
      expect(tab.launchError).toBeUndefined();
      expect(tab.launchAttempt).toBe(1);
      expect(tab.terminalRootPane).toMatchObject({
        type: "leaf",
        launchError: undefined,
        launchAttempt: 1,
      });
    });

    it("单终端启动失败时移除整个标签", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, {
        projectId: "proj-remove-error",
        projectPath: "/tmp/remove-error",
      });
      const tab = (usePanesStore.getState().rootPane as Panel).tabs[1];

      usePanesStore.getState().removeTerminalLaunch(tab.id, tab.activeTerminalPaneId!);

      expect((usePanesStore.getState().rootPane as Panel).tabs).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: tab.id })]),
      );
    });

    it("分屏中的终端启动失败时只移除对应子窗格", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, {
        projectId: "proj-remove-leaf-error",
        projectPath: "/tmp/remove-leaf-error",
      });
      let tab = (usePanesStore.getState().rootPane as Panel).tabs[1];
      usePanesStore.getState().splitTerminalPane(tab.id, tab.activeTerminalPaneId!, "right");
      tab = (usePanesStore.getState().rootPane as Panel).tabs[1];
      const failedLeafId = tab.activeTerminalPaneId!;

      usePanesStore.getState().removeTerminalLaunch(tab.id, failedLeafId);

      tab = (usePanesStore.getState().rootPane as Panel).tabs[1];
      expect(tab.id).toBeDefined();
      expect(tab.activeTerminalPaneId).not.toBe(failedLeafId);
      expect(tab.terminalRootPane).toMatchObject({
        type: "split",
        children: [expect.not.objectContaining({ id: failedLeafId })],
      });
    });
  });

  // ========== 项目打开 ==========

  describe("openProjectInPane", () => {
    it("无 resumeId 时应复用已有同 projectId 的 tab", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });

      const pane = usePanesStore.getState().rootPane as Panel;
      const existingTabId = pane.tabs.find((t) => t.projectId === "proj-1")!.id;

      usePanesStore.getState().openProjectInPane(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });

      const paneAfter = usePanesStore.getState().rootPane as Panel;
      // 不应创建新 tab
      expect(paneAfter.tabs.filter((t) => t.projectId === "proj-1")).toHaveLength(1);
      expect(paneAfter.activeTabId).toBe(existingTabId);
    });

    it("有 resumeId 时应总是新建 tab", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });

      const tabCountBefore = (usePanesStore.getState().rootPane as Panel).tabs.length;

      usePanesStore.getState().openProjectInPane(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1", resumeId: "resume-1" });

      const paneAfter = usePanesStore.getState().rootPane as Panel;
      expect(paneAfter.tabs.length).toBe(tabCountBefore + 1);
    });

    it("无 projectPath 的活动 tab 应被替换", () => {
      // 初始面板有一个默认 tab，其 projectPath 为 ""
      const paneId = usePanesStore.getState().rootPane.id;
      const pane = usePanesStore.getState().rootPane as Panel;
      const originalTabCount = pane.tabs.length;

      usePanesStore.getState().openProjectInPane(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });

      const paneAfter = usePanesStore.getState().rootPane as Panel;
      // tab 数量不变（替换了空标签）
      expect(paneAfter.tabs.length).toBe(originalTabCount);
      expect(paneAfter.tabs[0].projectId).toBe("proj-1");
    });
  });

  describe("openProject", () => {
    it("应委托给 openProjectInPane 使用活动面板", () => {
      const activePaneId = usePanesStore.getState().activePaneId;

      usePanesStore.getState().openProject({ projectId: "proj-1", projectPath: "/tmp/proj1" });

      const pane = usePanesStore.getState().findPaneById(activePaneId) as Panel;
      expect(pane.tabs.some((t) => t.projectId === "proj-1")).toBe(true);
    });
  });

  // ========== 特殊标签打开 ==========

  describe("openMcpConfig", () => {
    it("应创建 mcp-config 类型的 tab", () => {
      usePanesStore.getState().openMcpConfig("/tmp/project", "MyProject");

      const pane = usePanesStore.getState().activePane()!;
      const mcpTab = pane.tabs.find((t) => t.contentType === "mcp-config");
      expect(mcpTab).toBeDefined();
      expect(mcpTab!.title).toBe("MCP - MyProject");
      expect(mcpTab!.projectPath).toBe("/tmp/project");
    });

    it("重复打开应复用已有 tab", () => {
      usePanesStore.getState().openMcpConfig("/tmp/project", "MyProject");
      const tabCountAfterFirst = usePanesStore.getState().activePane()!.tabs.length;

      usePanesStore.getState().openMcpConfig("/tmp/project", "MyProject");
      const tabCountAfterSecond = usePanesStore.getState().activePane()!.tabs.length;

      expect(tabCountAfterSecond).toBe(tabCountAfterFirst);
    });
  });

  describe("openSkillManager", () => {
    it("应创建 skill-manager 类型的 tab", () => {
      usePanesStore.getState().openSkillManager("/tmp/project", "MyProject");

      const pane = usePanesStore.getState().activePane()!;
      const skillTab = pane.tabs.find((t) => t.contentType === "skill-manager");
      expect(skillTab).toBeDefined();
      expect(skillTab!.title).toBe("Skill - MyProject");
    });

    it("重复打开应复用已有 tab", () => {
      usePanesStore.getState().openSkillManager("/tmp/project", "MyProject");
      const count1 = usePanesStore.getState().activePane()!.tabs.length;

      usePanesStore.getState().openSkillManager("/tmp/project", "MyProject");
      const count2 = usePanesStore.getState().activePane()!.tabs.length;

      expect(count2).toBe(count1);
    });
  });

  describe("openMemoryManager", () => {
    it("应创建 memory-manager 类型的 tab", () => {
      usePanesStore.getState().openMemoryManager("/tmp/project", "MyProject");

      const pane = usePanesStore.getState().activePane()!;
      const memTab = pane.tabs.find((t) => t.contentType === "memory-manager");
      expect(memTab).toBeDefined();
      expect(memTab!.title).toBe("Memory - MyProject");
    });

    it("重复打开应复用已有 tab", () => {
      usePanesStore.getState().openMemoryManager("/tmp/project", "MyProject");
      const count1 = usePanesStore.getState().activePane()!.tabs.length;

      usePanesStore.getState().openMemoryManager("/tmp/project", "MyProject");
      const count2 = usePanesStore.getState().activePane()!.tabs.length;

      expect(count2).toBe(count1);
    });
  });

  describe("openBrowser", () => {
    it("creates an active browser tab and updates its URL and title metadata", () => {
      usePanesStore.getState().openBrowser("http://localhost:5173/", "Preview", "browser-tab-1");

      const pane = usePanesStore.getState().activePane()!;
      const browserTab = pane.tabs.find((tab) => tab.contentType === "browser")!;
      expect(browserTab).toMatchObject({
        id: "browser-tab-1",
        title: "Preview",
        browserUrl: "http://localhost:5173/",
        projectPath: "",
        sessionId: null,
      });
      expect(pane.activeTabId).toBe(browserTab.id);

      usePanesStore.getState().updateBrowserTab(browserTab.id, {
        browserUrl: "https://example.com/",
        title: "Example",
      });
      expect(usePanesStore.getState().findTabAcrossLayouts(browserTab.id)?.tab).toMatchObject({
        browserUrl: "https://example.com/",
        title: "Example",
      });
    });

    it("reuses an existing tab for the same URL instead of stacking duplicates", () => {
      const store = usePanesStore.getState();
      const createdId = store.openBrowser(
        "http://localhost:5173/app",
        "Preview",
        "browser-tab-1",
      );
      const reusedId = store.openBrowser(
        "http://localhost:5173/app",
        "Preview again",
        "browser-tab-2",
      );

      const pane = usePanesStore.getState().activePane()!;
      const browsers = pane.tabs.filter((tab) => tab.contentType === "browser");
      expect(browsers).toHaveLength(1);
      expect(browsers[0].id).toBe("browser-tab-1");
      expect(pane.activeTabId).toBe("browser-tab-1");
      expect(createdId).toBe("browser-tab-1");
      expect(reusedId).toBe("browser-tab-1");
    });

    it("treats hash and trailing slash as the same page, but query as different", () => {
      const store = usePanesStore.getState();
      store.openBrowser("http://localhost:5173/app/", "A", "b1");
      store.openBrowser("http://localhost:5173/app#section", "B", "b2");
      store.openBrowser("http://localhost:5173/app?id=2", "C", "b3");

      const browsers = usePanesStore
        .getState()
        .activePane()!
        .tabs.filter((tab) => tab.contentType === "browser");
      expect(browsers.map((tab) => tab.id)).toEqual(["b1", "b3"]);
    });

    it("forces a new tab when reuse is disabled", () => {
      const store = usePanesStore.getState();
      store.openBrowser("http://localhost:5173/app", "A", "b1");
      store.openBrowser("http://localhost:5173/app", "B", "b2", { reuse: false });

      const browsers = usePanesStore
        .getState()
        .activePane()!
        .tabs.filter((tab) => tab.contentType === "browser");
      expect(browsers.map((tab) => tab.id)).toEqual(["b1", "b2"]);
    });

    it("honors an explicit paneId and falls back to the active pane when it is unknown", () => {
      const originPaneId = usePanesStore.getState().activePaneId;
      usePanesStore.getState().splitRight(originPaneId);

      // 分屏后活动窗格换成了新窗格，把标签指名投回原窗格
      const activeAfterSplit = usePanesStore.getState().activePaneId;
      expect(activeAfterSplit).not.toBe(originPaneId);

      usePanesStore.getState().openBrowser("http://a.test/", "A", "b1", { paneId: originPaneId });
      const target = usePanesStore.getState().findPaneById(originPaneId);
      expect(target?.type === "panel" && target.tabs.some((tab) => tab.id === "b1")).toBe(true);

      // 未知 paneId 不得静默丢弃这次打开，应回落到活动窗格
      usePanesStore
        .getState()
        .openBrowser("http://b.test/", "B", "b2", { paneId: "pane-does-not-exist" });
      expect(usePanesStore.getState().findTabAcrossLayouts("b2")).toBeTruthy();
    });
  });

  // ========== 标签导航 ==========

  describe("reopenClosedTab", () => {
    it("应从 closedTabs 恢复标签", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });
      usePanesStore.getState().addTab(paneId, { projectId: "proj-2", projectPath: "/tmp/proj2" });

      // 关闭一个 tab
      const pane = usePanesStore.getState().rootPane as Panel;
      const tabToClose = pane.tabs[1];
      usePanesStore.getState().closeTab(paneId, tabToClose.id);

      expect(usePanesStore.getState().closedTabs).toHaveLength(1);

      // 恢复
      usePanesStore.getState().reopenClosedTab(paneId);

      const paneAfter = usePanesStore.getState().rootPane as Panel;
      // 恢复的标签应出现在面板中
      expect(paneAfter.tabs.some((t) => t.projectPath === tabToClose.projectPath)).toBe(true);
      expect(usePanesStore.getState().closedTabs).toHaveLength(0);
    });

    it("无已关闭标签时应无操作", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      const tabCountBefore = (usePanesStore.getState().rootPane as Panel).tabs.length;

      usePanesStore.getState().reopenClosedTab(paneId);

      const tabCountAfter = (usePanesStore.getState().rootPane as Panel).tabs.length;
      expect(tabCountAfter).toBe(tabCountBefore);
    });

    it("应往返保留 title 与 cliTool（此前丢字段：标题被重算、CLI 配置丢失）", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, {
        projectId: "proj-1",
        projectPath: "/tmp/proj1",
        cliTool: "codex",
        customTitle: "我的自定义标题",
      });

      const pane = usePanesStore.getState().rootPane as Panel;
      const tabToClose = pane.tabs[pane.tabs.length - 1];
      expect(tabToClose.title).toBe("我的自定义标题");
      usePanesStore.getState().closeTab(paneId, tabToClose.id);

      usePanesStore.getState().reopenClosedTab(usePanesStore.getState().activePaneId);

      const restored = usePanesStore
        .getState()
        .allPanels()
        .flatMap((p) => p.tabs)
        .find((t) => t.projectPath === "/tmp/proj1");
      expect(restored).toBeTruthy();
      expect(restored!.title).toBe("我的自定义标题");
      expect(restored!.cliTool).toBe("codex");
    });

    it("旧快照只有 launchClaude 时应恢复为 claude（对齐 handleCloneTab 的回退表达式）", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.setState({
        closedTabs: [{
          projectId: "proj-legacy",
          projectPath: "/tmp/legacy",
          title: "Legacy (Claude)",
          launchClaude: true,
        }],
      });

      usePanesStore.getState().reopenClosedTab(paneId);

      const restored = usePanesStore
        .getState()
        .allPanels()
        .flatMap((p) => p.tabs)
        .find((t) => t.projectPath === "/tmp/legacy");
      expect(restored).toBeTruthy();
      expect(restored!.title).toBe("Legacy (Claude)");
      expect(restored!.cliTool).toBe("claude");
    });

    it("reopen 后应把 closedTabs 裁剪到上限 20（push 点上限由 B1-05 收口）", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      const snapshots = Array.from({ length: 30 }, (_, i) => ({
        projectId: `proj-${i}`,
        projectPath: `/tmp/proj-${i}`,
        title: `Tab ${i}`,
      }));
      usePanesStore.setState({ closedTabs: snapshots });

      // 弹出最新的一个（proj-29），剩 29 条，裁剪后应只留最近的 20 条
      usePanesStore.getState().reopenClosedTab(paneId);

      const closed = usePanesStore.getState().closedTabs;
      expect(closed).toHaveLength(20);
      // 保尾不保头：最旧的被丢弃，栈顶是 proj-28
      expect(closed[closed.length - 1].projectId).toBe("proj-28");
      expect(closed[0].projectId).toBe("proj-9");
    });
  });

  describe("nextTab", () => {
    it("应循环切换到下一个标签", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });
      usePanesStore.getState().addTab(paneId, { projectId: "proj-2", projectPath: "/tmp/proj2" });

      const pane = usePanesStore.getState().rootPane as Panel;
      const firstTabId = pane.tabs[0].id;

      // 选中第一个 tab
      usePanesStore.getState().selectTab(paneId, firstTabId);
      // 切换到下一个
      usePanesStore.getState().nextTab(paneId);

      const paneAfter = usePanesStore.getState().rootPane as Panel;
      expect(paneAfter.activeTabId).toBe(pane.tabs[1].id);
    });

    it("最后一个标签时应循环到第一个", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });

      const pane = usePanesStore.getState().rootPane as Panel;
      const lastTabId = pane.tabs[pane.tabs.length - 1].id;
      const firstTabId = pane.tabs[0].id;

      usePanesStore.getState().selectTab(paneId, lastTabId);
      usePanesStore.getState().nextTab(paneId);

      const paneAfter = usePanesStore.getState().rootPane as Panel;
      expect(paneAfter.activeTabId).toBe(firstTabId);
    });
  });

  describe("prevTab", () => {
    it("应反向循环切换到上一个标签", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });
      usePanesStore.getState().addTab(paneId, { projectId: "proj-2", projectPath: "/tmp/proj2" });

      const pane = usePanesStore.getState().rootPane as Panel;
      const secondTabId = pane.tabs[1].id;
      const firstTabId = pane.tabs[0].id;

      usePanesStore.getState().selectTab(paneId, secondTabId);
      usePanesStore.getState().prevTab(paneId);

      const paneAfter = usePanesStore.getState().rootPane as Panel;
      expect(paneAfter.activeTabId).toBe(firstTabId);
    });

    it("第一个标签时应循环到最后一个", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });

      const pane = usePanesStore.getState().rootPane as Panel;
      const firstTabId = pane.tabs[0].id;
      const lastTabId = pane.tabs[pane.tabs.length - 1].id;

      usePanesStore.getState().selectTab(paneId, firstTabId);
      usePanesStore.getState().prevTab(paneId);

      const paneAfter = usePanesStore.getState().rootPane as Panel;
      expect(paneAfter.activeTabId).toBe(lastTabId);
    });
  });

  describe("switchToTab", () => {
    it("应切换到指定索引的标签", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });
      usePanesStore.getState().addTab(paneId, { projectId: "proj-2", projectPath: "/tmp/proj2" });

      const pane = usePanesStore.getState().rootPane as Panel;
      const targetTabId = pane.tabs[1].id;

      usePanesStore.getState().switchToTab(paneId, 1);

      const paneAfter = usePanesStore.getState().rootPane as Panel;
      expect(paneAfter.activeTabId).toBe(targetTabId);
    });

    it("索引越界时应无操作", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      const activeTabBefore = (usePanesStore.getState().rootPane as Panel).activeTabId;

      usePanesStore.getState().switchToTab(paneId, 99);

      const activeTabAfter = (usePanesStore.getState().rootPane as Panel).activeTabId;
      expect(activeTabAfter).toBe(activeTabBefore);
    });

    it("负数索引时应无操作", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      const activeTabBefore = (usePanesStore.getState().rootPane as Panel).activeTabId;

      usePanesStore.getState().switchToTab(paneId, -1);

      const activeTabAfter = (usePanesStore.getState().rootPane as Panel).activeTabId;
      expect(activeTabAfter).toBe(activeTabBefore);
    });
  });

  describe("openSessionBesidePane", () => {
    /** 找到包含 paneId 的最近一层 split 的方向 */
    const parentDirectionOf = (node: PaneNode, paneId: string): SplitPane["direction"] | null => {
      if (node.type !== "split") return null;
      if (node.children.some((child) => child.id === paneId)) return node.direction;
      for (const child of node.children) {
        const found = parentDirectionOf(child, paneId);
        if (found) return found;
      }
      return null;
    };

    it("新窗格只应有会话标签本身，不带多余的空 Terminal 标签", () => {
      const rootId = usePanesStore.getState().rootPane.id;

      usePanesStore.getState().openSessionBesidePane(rootId, "right", {
        projectId: "proj-1",
        projectPath: "/tmp/proj1",
        customTitle: "worker-1",
      });

      const newPaneId = usePanesStore.getState().activePaneId;
      const newPane = usePanesStore.getState().findPaneById(newPaneId) as Panel;
      expect(newPane.type).toBe("panel");
      expect(newPane.tabs).toHaveLength(1);
      expect(newPane.tabs[0].projectPath).toBe("/tmp/proj1");
      expect(newPane.activeTabId).toBe(newPane.tabs[0].id);
    });

    it("auto 方向应按父容器取反，连续分屏形成螺旋", () => {
      const openAuto = (paneId: string, index: number) =>
        usePanesStore.getState().openSessionBesidePane(paneId, "auto", {
          projectId: `proj-${index}`,
          projectPath: `/tmp/proj${index}`,
        });

      // 1. 根 panel 无 split 祖先 → 默认横向（right）
      openAuto(usePanesStore.getState().rootPane.id, 1);
      const pane1 = usePanesStore.getState().activePaneId;
      expect(parentDirectionOf(usePanesStore.getState().rootPane, pane1)).toBe("horizontal");

      // 2. 父容器 horizontal → 取反为 down（vertical）
      openAuto(pane1, 2);
      const pane2 = usePanesStore.getState().activePaneId;
      expect(parentDirectionOf(usePanesStore.getState().rootPane, pane2)).toBe("vertical");

      // 3. 父容器 vertical → 取反回 right（horizontal）
      openAuto(pane2, 3);
      const pane3 = usePanesStore.getState().activePaneId;
      expect(parentDirectionOf(usePanesStore.getState().rootPane, pane3)).toBe("horizontal");
    });
  });
});

describe("attachSessionToAnchor", () => {
  // 本 describe 在外层 describe 之外，拿不到那边的 beforeEach，必须自己重置，
  // 否则会带着前面用例留下的分屏 rootPane 跑。
  beforeEach(() => {
    resetTestDataCounter();
    const initialPanel = createPanel();
    usePanesStore.setState({
      rootPane: initialPanel,
      activePaneId: initialPanel.id,
      layouts: [{
        id: "layout-1",
        name: "布局 1",
        rootPane: initialPanel,
        activePaneId: initialPanel.id,
      }],
      currentLayoutId: "layout-1",
      closedTabs: [],
    });
  });

  function splitTerminalTab(paneId: string) {
    usePanesStore.getState().addTab(paneId, {
      projectId: "proj-1",
      projectPath: "D:\\work\\proj",
    });
    const pane = usePanesStore.getState().rootPane as Panel;
    return pane.tabs[pane.tabs.length - 1];
  }

  it("按 terminalPaneId 挂到指定分屏格子，而不是活动格子", () => {
    const paneId = usePanesStore.getState().rootPane.id;
    const tab = splitTerminalTab(paneId);
    const rootPane = tab.terminalRootPane;
    const rootLeafId = rootPane?.type === "leaf" ? rootPane.id : "";

    const attached = usePanesStore.getState().attachSessionToAnchor({
      sessionId: "pty-1",
      layoutId: "layout-1",
      tabId: tab.id,
      terminalPaneId: rootLeafId,
      expectedProjectPath: "D:\\work\\proj",
    });

    expect(attached).toBe(true);
    const pane = usePanesStore.getState().rootPane as Panel;
    const leaf = pane.tabs.find((item) => item.id === tab.id)!.terminalRootPane!;
    expect(leaf.type === "leaf" ? leaf.savedSessionId : null).toBe("pty-1");
    expect(leaf.type === "leaf" ? leaf.restoring : null).toBe(true);
  });

  it("项目路径不等价时拒绝挂载——认领错会话比不认领严重得多", () => {
    const paneId = usePanesStore.getState().rootPane.id;
    const tab = splitTerminalTab(paneId);

    const attached = usePanesStore.getState().attachSessionToAnchor({
      sessionId: "pty-1",
      layoutId: "layout-1",
      tabId: tab.id,
      terminalPaneId: tab.terminalRootPane?.id,
      expectedProjectPath: "D:\\work\\OTHER-PROJECT",
    });

    expect(attached).toBe(false);
  });

  it("跨 Windows / mnt 形式的同一项目视为等价", () => {
    const paneId = usePanesStore.getState().rootPane.id;
    const tab = splitTerminalTab(paneId);

    const attached = usePanesStore.getState().attachSessionToAnchor({
      sessionId: "pty-1",
      layoutId: "layout-1",
      tabId: tab.id,
      terminalPaneId: tab.terminalRootPane?.id,
      expectedProjectPath: "/mnt/d/work/proj",
    });

    expect(attached).toBe(true);
  });

  it("锚点 leaf 已有活会话时不覆盖", () => {
    const paneId = usePanesStore.getState().rootPane.id;
    usePanesStore.getState().addTab(paneId, {
      projectId: "proj-1",
      projectPath: "D:\\work\\proj",
      sessionId: "existing-pty",
    });
    const pane = usePanesStore.getState().rootPane as Panel;
    const tab = pane.tabs[pane.tabs.length - 1];

    const attached = usePanesStore.getState().attachSessionToAnchor({
      sessionId: "pty-new",
      layoutId: "layout-1",
      tabId: tab.id,
      terminalPaneId: tab.terminalRootPane?.id,
      expectedProjectPath: "D:\\work\\proj",
    });

    expect(attached).toBe(false);
  });

  it("会话已被本实例引用时不重复挂", () => {
    const paneId = usePanesStore.getState().rootPane.id;
    usePanesStore.getState().addTab(paneId, {
      projectId: "proj-1",
      projectPath: "D:\\work\\proj",
      sessionId: "pty-dup",
    });
    const tab = splitTerminalTab(paneId);

    const attached = usePanesStore.getState().attachSessionToAnchor({
      sessionId: "pty-dup",
      layoutId: "layout-1",
      tabId: tab.id,
      terminalPaneId: tab.terminalRootPane?.id,
      expectedProjectPath: "D:\\work\\proj",
    });

    expect(attached).toBe(false);
  });

  it("锚点 tab 不存在时返回 false", () => {
    expect(
      usePanesStore.getState().attachSessionToAnchor({
        sessionId: "pty-1",
        layoutId: "layout-1",
        tabId: "tab-does-not-exist",
        terminalPaneId: "leaf-does-not-exist",
        expectedProjectPath: "D:\\work\\proj",
      }),
    ).toBe(false);
  });

  it("缺 layoutId 或 terminalPaneId 的历史锚点只允许人工接管", () => {
    const paneId = usePanesStore.getState().rootPane.id;
    const tab = splitTerminalTab(paneId);
    const terminalPaneId = tab.terminalRootPane?.id;

    expect(usePanesStore.getState().attachSessionToAnchor({
      sessionId: "pty-1",
      tabId: tab.id,
      terminalPaneId,
      expectedProjectPath: tab.projectPath,
    })).toBe(false);
    expect(usePanesStore.getState().attachSessionToAnchor({
      sessionId: "pty-1",
      layoutId: "layout-1",
      tabId: tab.id,
      expectedProjectPath: tab.projectPath,
    })).toBe(false);
  });

  it("租约丢失后把引用该 session 的 leaf 持久标成只读", () => {
    const paneId = usePanesStore.getState().rootPane.id;
    usePanesStore.getState().addTab(paneId, {
      projectId: "proj-1",
      projectPath: "D:\\work\\proj",
      sessionId: "pty-readonly",
    });

    usePanesStore.getState().setSessionLeaseReadOnly("pty-readonly", true);

    const pane = usePanesStore.getState().rootPane as Panel;
    const tab = pane.tabs.find((item) => item.sessionId === "pty-readonly")!;
    expect(tab.terminalRootPane?.type === "leaf" && tab.terminalRootPane.leaseReadOnly).toBe(true);
    expect(tab.leaseReadOnly).toBe(true);
  });
});
