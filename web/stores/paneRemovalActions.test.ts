// B1-03 搬家等价性测试：六个关闭出口迁入 createPaneRemovalActions 后行为必须与
// 迁移前逐字一致（原用例见 usePanesStore.test.ts 的 closeTab/closePane 组，保留继续跑），
// 外加三个新出口骨架的契约——重点是 removeEmptyPane 的「非空即拒」硬守卫。
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { usePanesStore } from "./usePanesStore";
import { terminalService } from "@/services";
import { useFullscreenStore } from "./useFullscreenStore";
import { createPanel } from "./paneTreeHelpers";
import { CLOSED_TABS_LIMIT } from "./closedTabsCap";
import type { ClosedTabSnapshot } from "./panesStoreTypes";
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
  return {
    type: "panel",
    id,
    tabs,
    activeTabId: tabs[0]?.id ?? "",
  };
}

function makeSplit(id: string, children: PaneNode[]): SplitPane {
  return {
    type: "split",
    id,
    direction: "horizontal",
    children,
    sizes: children.map(() => 100 / children.length),
  };
}

function setPanesState(rootPane: PaneNode, activePaneId: string) {
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
    ],
    currentLayoutId: "layout-1",
    closedTabs: [],
    poppedOutTabs: new Set<string>(),
  });
}

function currentPanel(paneId: string): Panel {
  const pane = usePanesStore.getState().findPaneById(paneId);
  expect(pane?.type).toBe("panel");
  return pane as Panel;
}

/** killSession 的观察点：B1-04 起回收由 destroyPipeline 发起，断言打在这里。 */
let killSpy: ReturnType<typeof vi.spyOn>;

/** 杀集（排序后比较，断言的是集合而非调用顺序）。 */
function killedIds(): string[] {
  return killSpy.mock.calls.map((c: unknown[]) => c[0] as string).sort();
}

beforeEach(() => {
  const initialPanel = createPanel();
  setPanesState(initialPanel, initialPanel.id);
  useFullscreenStore.setState({
    isFullscreen: false,
    fullscreenTabId: null,
    fullscreenPaneId: null,
  });
  killSpy = vi.spyOn(terminalService, "killSession").mockResolvedValue(undefined);
  vi.spyOn(terminalService, "detachOutput").mockImplementation(() => {});
  vi.spyOn(terminalService, "detachExit").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ========== 搬家等价：六个既有出口 ==========

describe("closeTab（搬家后行为等价）", () => {
  it("多 tab 面板移除 tab 并收敛 activeTabId", () => {
    const tabs = [makeTerminalTab("t1"), makeTerminalTab("t2"), makeTerminalTab("t3")];
    const panel = makePanel("p1", tabs);
    setPanesState(panel, "p1");

    usePanesStore.getState().closeTab("p1", "t2");

    const after = currentPanel("p1");
    expect(after.tabs.map((t) => t.id)).toEqual(["t1", "t3"]);
  });

  it("关闭激活 tab 后 activeTabId 落到同位次（或末尾）", () => {
    const tabs = [makeTerminalTab("t1"), makeTerminalTab("t2"), makeTerminalTab("t3")];
    const panel = makePanel("p1", tabs);
    panel.activeTabId = "t3";
    setPanesState(panel, "p1");

    usePanesStore.getState().closeTab("p1", "t3");

    expect(currentPanel("p1").activeTabId).toBe("t2");
  });

  it("pinned tab 不可关闭", () => {
    const tabs = [makeTerminalTab("t1", { pinned: true }), makeTerminalTab("t2")];
    setPanesState(makePanel("p1", tabs), "p1");

    usePanesStore.getState().closeTab("p1", "t1");

    expect(currentPanel("p1").tabs).toHaveLength(2);
    expect(usePanesStore.getState().closedTabs).toHaveLength(0);
  });

  it("单 tab 面板触发 closePane（根面板换新）", () => {
    const panel = makePanel("p1", [makeTerminalTab("t1")]);
    setPanesState(panel, "p1");

    usePanesStore.getState().closeTab("p1", "t1");

    const state = usePanesStore.getState();
    expect(state.rootPane.type).toBe("panel");
    expect(state.rootPane.id).not.toBe("p1");
  });

  it("终端标签关闭时快照进 closedTabs（字段齐全）", () => {
    const tab = makeTerminalTab("t1", {
      title: "自定义标题",
      cliTool: "claude",
      workspaceName: "ws-1",
    });
    setPanesState(makePanel("p1", [tab, makeTerminalTab("t2")]), "p1");

    usePanesStore.getState().closeTab("p1", "t1");

    const closed = usePanesStore.getState().closedTabs;
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      projectId: "proj-t1",
      projectPath: "/tmp/t1",
      title: "自定义标题",
      cliTool: "claude",
      workspaceName: "ws-1",
    });
  });

  it("非终端标签不进 closedTabs", () => {
    const editorTab: Tab = {
      id: "e1",
      title: "file.ts",
      contentType: "editor",
      projectId: "",
      projectPath: "/tmp/proj",
      sessionId: null,
      filePath: "/tmp/proj/file.ts",
    };
    setPanesState(makePanel("p1", [editorTab, makeTerminalTab("t2")]), "p1");

    usePanesStore.getState().closeTab("p1", "e1");

    expect(usePanesStore.getState().closedTabs).toHaveLength(0);
    expect(currentPanel("p1").tabs.map((t) => t.id)).toEqual(["t2"]);
  });
});

describe("closeTabsToLeft / closeTabsToRight / closeOtherTabs（搬家后行为等价）", () => {
  function threeTabs(): Panel {
    return makePanel("p1", [
      makeTerminalTab("t1"),
      makeTerminalTab("t2"),
      makeTerminalTab("t3"),
    ]);
  }

  it("closeTabsToLeft 只关目标左侧未 pinned 的 tab", () => {
    const panel = threeTabs();
    panel.tabs[0].pinned = true;
    setPanesState(panel, "p1");

    usePanesStore.getState().closeTabsToLeft("p1", "t3");

    expect(currentPanel("p1").tabs.map((t) => t.id)).toEqual(["t1", "t3"]);
  });

  it("closeTabsToLeft 目标是第一个 tab 时 no-op", () => {
    setPanesState(threeTabs(), "p1");
    usePanesStore.getState().closeTabsToLeft("p1", "t1");
    expect(currentPanel("p1").tabs).toHaveLength(3);
  });

  it("closeTabsToRight 只关目标右侧的 tab，激活 tab 被关时聚焦目标", () => {
    const panel = threeTabs();
    panel.activeTabId = "t3";
    setPanesState(panel, "p1");

    usePanesStore.getState().closeTabsToRight("p1", "t1");

    const after = currentPanel("p1");
    expect(after.tabs.map((t) => t.id)).toEqual(["t1"]);
    expect(after.activeTabId).toBe("t1");
  });

  it("closeOtherTabs 保留目标与 pinned", () => {
    const panel = threeTabs();
    panel.tabs[2].pinned = true;
    setPanesState(panel, "p1");

    usePanesStore.getState().closeOtherTabs("p1", "t2");

    expect(currentPanel("p1").tabs.map((t) => t.id)).toEqual(["t2", "t3"]);
  });

  // 三个 store 出口自 B1-04 起已无调用方（@deprecated），保留用例只为锁住
  // 「搬家没改变它们」；UI 侧批量关闭的真实语义见下条。
  it("废弃出口维持迁移前语义：不记 closedTabs", () => {
    setPanesState(threeTabs(), "p1");
    usePanesStore.getState().closeOtherTabs("p1", "t1");
    expect(usePanesStore.getState().closedTabs).toHaveLength(0);
  });

  it("改道后的批量关闭记 closedTabs（batch-close 矩阵，修复撤销失效）", () => {
    setPanesState(threeTabs(), "p1");

    // UI 侧 doBatchClose 的等价调用
    usePanesStore.getState().removeTabsInternal(["t2", "t3"], "batch-close");

    expect(usePanesStore.getState().closedTabs.map((s) => s.projectId).sort())
      .toEqual(["proj-t2", "proj-t3"]);
  });
});

describe("closePane（搬家后行为等价）", () => {
  it("关闭分屏面板后保留单 child split 壳（幸存面板不 remount）", () => {
    const p1 = makePanel("p1", [makeTerminalTab("t1")]);
    const p2 = makePanel("p2", [makeTerminalTab("t2")]);
    const root = makeSplit("s1", [p1, p2]);
    setPanesState(root, "p2");

    usePanesStore.getState().closePane("p2");

    const state = usePanesStore.getState();
    expect(state.rootPane.type).toBe("split");
    const shell = state.rootPane as SplitPane;
    expect(shell.id).toBe("s1");
    expect(shell.children.map((c) => c.id)).toEqual(["p1"]);
    expect(shell.sizes).toEqual([100]);
    expect(state.activePaneId).toBe("p1");
  });

  it("关闭根面板时创建全新面板", () => {
    const p1 = makePanel("p1", [makeTerminalTab("t1")]);
    setPanesState(p1, "p1");

    usePanesStore.getState().closePane("p1");

    const state = usePanesStore.getState();
    expect(state.rootPane.type).toBe("panel");
    expect(state.rootPane.id).not.toBe("p1");
  });

  it("面板里全部可恢复终端标签进 closedTabs（含 pinned——迁移前语义）", () => {
    const p1 = makePanel("p1", [
      makeTerminalTab("t1"),
      makeTerminalTab("t2", { pinned: true }),
    ]);
    const p2 = makePanel("p2", [makeTerminalTab("t3")]);
    setPanesState(makeSplit("s1", [p1, p2]), "p1");

    usePanesStore.getState().closePane("p1");

    const closed = usePanesStore.getState().closedTabs;
    expect(closed.map((t) => t.projectId)).toEqual(["proj-t1", "proj-t2"]);
  });
});

describe("closeTerminalPane（搬家后行为等价）", () => {
  it("多 leaf 时移除指定 leaf 并保留 split 壳", () => {
    const leafA: TerminalPaneLeaf = { type: "leaf", id: "leaf-a", sessionId: "sess-a" };
    const leafB: TerminalPaneLeaf = { type: "leaf", id: "leaf-b", sessionId: "sess-b" };
    const tab = makeTerminalTab("t1");
    tab.terminalRootPane = {
      type: "split",
      id: "tsplit",
      direction: "horizontal",
      children: [leafA, leafB],
      sizes: [50, 50],
    };
    tab.activeTerminalPaneId = "leaf-b";
    setPanesState(makePanel("p1", [tab]), "p1");

    usePanesStore.getState().closeTerminalPane("t1", "leaf-b");

    const after = currentPanel("p1").tabs[0];
    expect(after.terminalRootPane?.type).toBe("split");
    const shell = after.terminalRootPane as { children: Array<{ id: string }>; sizes: number[] };
    expect(shell.children.map((c) => c.id)).toEqual(["leaf-a"]);
    expect(shell.sizes).toEqual([100]);
    expect(after.activeTerminalPaneId).toBe("leaf-a");
  });

  it("最后一个 leaf 不可关（no-op）", () => {
    const tab = makeTerminalTab("t1");
    setPanesState(makePanel("p1", [tab]), "p1");

    usePanesStore.getState().closeTerminalPane("t1", `t1-leaf`);

    const after = currentPanel("p1").tabs[0];
    expect(after.terminalRootPane?.type).toBe("leaf");
  });
});

// ========== 新出口骨架 ==========

describe("removeEmptyPane（纯树操作，零销毁语义）", () => {
  it("非空 pane 一律拒绝：树不动 + dev 告警", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p1 = makePanel("p1", [makeTerminalTab("t1")]);
    const p2 = makePanel("p2", [makeTerminalTab("t2")]);
    setPanesState(makeSplit("s1", [p1, p2]), "p1");

    usePanesStore.getState().removeEmptyPane("p2");

    const root = usePanesStore.getState().rootPane as SplitPane;
    expect(root.children).toHaveLength(2);
    expect(usePanesStore.getState().findPaneById("p2")).not.toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("removeEmptyPane rejected");
    // 零销毁语义：不记 closedTabs
    expect(usePanesStore.getState().closedTabs).toHaveLength(0);
  });

  it("空 pane 从 split 中移除并归一化 sizes", () => {
    const p1 = makePanel("p1", [makeTerminalTab("t1")]);
    const empty = makePanel("p-empty", []);
    setPanesState(makeSplit("s1", [p1, empty]), "p-empty");

    usePanesStore.getState().removeEmptyPane("p-empty");

    const state = usePanesStore.getState();
    const shell = state.rootPane as SplitPane;
    expect(shell.children.map((c) => c.id)).toEqual(["p1"]);
    expect(shell.sizes).toEqual([100]);
    expect(state.activePaneId).toBe("p1");
  });

  it("空的根 pane 换成全新面板", () => {
    const empty = makePanel("p-empty", []);
    setPanesState(empty, "p-empty");

    usePanesStore.getState().removeEmptyPane("p-empty");

    const state = usePanesStore.getState();
    expect(state.rootPane.type).toBe("panel");
    expect(state.rootPane.id).not.toBe("p-empty");
  });

  it("不存在的 paneId 静默 no-op", () => {
    const before = usePanesStore.getState().rootPane;
    usePanesStore.getState().removeEmptyPane("nope");
    expect(usePanesStore.getState().rootPane).toBe(before);
  });

  it("split 节点 id 不接受（只收 panel）", () => {
    const p1 = makePanel("p1", [makeTerminalTab("t1")]);
    const p2 = makePanel("p2", []);
    setPanesState(makeSplit("s1", [p1, p2]), "p1");

    usePanesStore.getState().removeEmptyPane("s1");

    expect((usePanesStore.getState().rootPane as SplitPane).children).toHaveLength(2);
  });
});

describe("removeTabsInternal（骨架：树 splice + closedTabs + 附属清理）", () => {
  it("user-close：移除 tab、记 closedTabs、尊重 pinned", () => {
    const tabs = [
      makeTerminalTab("t1"),
      makeTerminalTab("t2", { pinned: true }),
      makeTerminalTab("t3"),
    ];
    setPanesState(makePanel("p1", tabs), "p1");

    usePanesStore.getState().removeTabsInternal(["t1", "t2"], "user-close");

    const after = currentPanel("p1");
    expect(after.tabs.map((t) => t.id)).toEqual(["t2", "t3"]);
    expect(usePanesStore.getState().closedTabs.map((t) => t.projectId)).toEqual(["proj-t1"]);
  });

  it("delete-layout：不记 closedTabs、pinned 也移除", () => {
    const tabs = [makeTerminalTab("t1", { pinned: true }), makeTerminalTab("t2")];
    setPanesState(makePanel("p1", tabs), "p1");

    usePanesStore.getState().removeTabsInternal(["t1"], "delete-layout");

    expect(currentPanel("p1").tabs.map((t) => t.id)).toEqual(["t2"]);
    expect(usePanesStore.getState().closedTabs).toHaveLength(0);
  });

  it("最后一个 tab 移除后 pane 收壳（与 closeTabInTree 同语义）", () => {
    const p1 = makePanel("p1", [makeTerminalTab("t1")]);
    const p2 = makePanel("p2", [makeTerminalTab("t2")]);
    setPanesState(makeSplit("s1", [p1, p2]), "p2");

    usePanesStore.getState().removeTabsInternal(["t2"], "user-close");

    const shell = usePanesStore.getState().rootPane as SplitPane;
    expect(shell.children.map((c) => c.id)).toEqual(["p1"]);
  });

  it("closedTabs 裁到上限（trimClosedTabs）", () => {
    const prefill: ClosedTabSnapshot[] = Array.from({ length: 25 }, (_, i) => ({
      projectId: `old-${i}`,
      projectPath: `/tmp/old-${i}`,
      title: `old-${i}`,
    }));
    setPanesState(makePanel("p1", [makeTerminalTab("t1"), makeTerminalTab("t2")]), "p1");
    usePanesStore.setState({ closedTabs: prefill });

    usePanesStore.getState().removeTabsInternal(["t1"], "user-close");

    const closed = usePanesStore.getState().closedTabs;
    expect(closed).toHaveLength(CLOSED_TABS_LIMIT);
    // 尾部保留最近关闭的
    expect(closed[closed.length - 1].projectId).toBe("proj-t1");
  });

  it("找不到的 tabId 静默跳过（幂等：二次调用零副作用）", () => {
    setPanesState(makePanel("p1", [makeTerminalTab("t1"), makeTerminalTab("t2")]), "p1");

    usePanesStore.getState().removeTabsInternal(["t1"], "user-close");
    const snapshotAfterFirst = usePanesStore.getState().rootPane;
    usePanesStore.getState().removeTabsInternal(["t1"], "user-close");

    expect(usePanesStore.getState().rootPane).toBe(snapshotAfterFirst);
    expect(usePanesStore.getState().closedTabs).toHaveLength(1);
  });

  it("清理 poppedOutTabs 里被移除 tab 的条目", () => {
    setPanesState(makePanel("p1", [makeTerminalTab("t1"), makeTerminalTab("t2")]), "p1");
    usePanesStore.setState({ poppedOutTabs: new Set(["t1", "t2"]) });

    usePanesStore.getState().removeTabsInternal(["t1"], "delete-layout");

    expect([...usePanesStore.getState().poppedOutTabs]).toEqual(["t2"]);
  });

  it("非当前布局里的 tab 也能移除", () => {
    const current = makePanel("p1", [makeTerminalTab("t1")]);
    const otherPanel = makePanel("p2", [makeTerminalTab("t2"), makeTerminalTab("t3")]);
    usePanesStore.setState({
      rootPane: current,
      activePaneId: "p1",
      layouts: [
        { id: "layout-1", name: "布局 1", kind: "normal", rootPane: current, activePaneId: "p1" },
        { id: "layout-2", name: "布局 2", kind: "normal", rootPane: otherPanel, activePaneId: "p2" },
      ],
      currentLayoutId: "layout-1",
      closedTabs: [],
      poppedOutTabs: new Set<string>(),
    });

    usePanesStore.getState().removeTabsInternal(["t2"], "delete-layout");

    const other = usePanesStore.getState().layouts.find((l) => l.id === "layout-2")!;
    expect(collectTabIds(other.rootPane)).toEqual(["t3"]);
  });
});

describe("removeTerminalLeafInternal（骨架：关一格）", () => {
  it("多 leaf 时移除指定 leaf（与 closeTerminalLeafInTab 同语义）", () => {
    const leafA: TerminalPaneLeaf = { type: "leaf", id: "leaf-a", sessionId: "sess-a" };
    const leafB: TerminalPaneLeaf = { type: "leaf", id: "leaf-b", sessionId: "sess-b" };
    const tab = makeTerminalTab("t1");
    tab.terminalRootPane = {
      type: "split",
      id: "tsplit",
      direction: "horizontal",
      children: [leafA, leafB],
      sizes: [50, 50],
    };
    tab.activeTerminalPaneId = "leaf-b";
    setPanesState(makePanel("p1", [tab]), "p1");

    usePanesStore.getState().removeTerminalLeafInternal("t1", "leaf-b", "user-close");

    const after = currentPanel("p1").tabs[0];
    const shell = after.terminalRootPane as { children: Array<{ id: string }> };
    expect(shell.children.map((c) => c.id)).toEqual(["leaf-a"]);
  });

  it("最后一个 leaf 不关（no-op，调用方应改走 removeTabsInternal）", () => {
    const tab = makeTerminalTab("t1");
    setPanesState(makePanel("p1", [tab]), "p1");

    usePanesStore.getState().removeTerminalLeafInternal("t1", "t1-leaf", "user-close");

    expect(currentPanel("p1").tabs[0].terminalRootPane?.type).toBe("leaf");
  });
});

function collectTabIds(node: PaneNode): string[] {
  if (node.type === "panel") return node.tabs.map((t) => t.id);
  return node.children.flatMap(collectTabIds);
}

// ============================================================================
// B1-04 改道后的回收断言。
//
// 这一组是批1 的核心防线：多杀 = 用户正在跑的 agent 会话永久丢失，
// 少杀 = 孤儿 PTY 常驻。因此断言的是 killSession 调用集合**精确相等**，
// 不是「至少杀了」或「没多杀」——两侧都必须挂。
// ============================================================================
describe("removeTabsInternal（改道后：回收管线接入）", () => {
  function splitTab(id: string, sessions: Array<string | null>, saved?: string): Tab {
    const children: TerminalPaneLeaf[] = sessions.map((sid, i) => ({
      type: "leaf",
      id: `${id}-leaf-${i}`,
      launchId: `${id}-launch-${i}`,
      restoreMode: "shell",
      sessionId: sid,
      ...(saved && i === sessions.length - 1 ? { savedSessionId: saved } : {}),
    }));
    const tab = makeTerminalTab(id);
    tab.terminalRootPane = {
      type: "split",
      id: `${id}-split`,
      direction: "horizontal",
      children,
      sizes: children.map(() => 100 / children.length),
    } as unknown as Tab["terminalRootPane"];
    tab.activeTerminalPaneId = children[0].id;
    return tab;
  }

  it("分屏 tab：全部 leaf 的会话都被杀，一个不漏一个不多", async () => {
    const tab = splitTab("t1", ["sess-a", "sess-b", "sess-c"]);
    setPanesState(makePanel("p1", [tab]), "p1");

    usePanesStore.getState().removeTabsInternal(["t1"], "user-close");
    await vi.waitFor(() => expect(killSpy).toHaveBeenCalled());

    expect(killedIds()).toEqual(["sess-a", "sess-b", "sess-c"]);
  });

  it("savedSessionId 并入杀集（恢复中的会话是真实 PTY，漏了就是孤儿）", async () => {
    const tab = splitTab("t1", ["sess-live", null], "sess-saved");
    setPanesState(makePanel("p1", [tab]), "p1");

    usePanesStore.getState().removeTabsInternal(["t1"], "user-close");
    await vi.waitFor(() => expect(killSpy).toHaveBeenCalled());

    expect(killedIds()).toEqual(["sess-live", "sess-saved"]);
  });

  it("backend-close 零 kill（PTY 已死，再杀是重杀）", async () => {
    const tab = splitTab("t1", ["sess-a", "sess-b"]);
    setPanesState(makePanel("p1", [tab]), "p1");

    usePanesStore.getState().removeTabsInternal(["t1"], "backend-close");
    await new Promise((r) => setTimeout(r, 0));

    expect(killSpy).not.toHaveBeenCalled();
    // 树操作照常发生：backend-close 不杀，但标签必须收掉（PTY 已经没了）
    expect(collectTabIds(usePanesStore.getState().rootPane)).not.toContain("t1");
  });

  it("pinned 被矩阵豁免时：既不关也不杀（资源与树两处判据必须同口径）", async () => {
    const pinned = splitTab("t1", ["sess-pinned"]);
    pinned.pinned = true;
    const normal = splitTab("t2", ["sess-normal"]);
    setPanesState(makePanel("p1", [pinned, normal]), "p1");

    usePanesStore.getState().removeTabsInternal(["t1", "t2"], "user-close");
    await vi.waitFor(() => expect(killSpy).toHaveBeenCalled());

    expect(killedIds()).toEqual(["sess-normal"]);
    expect(collectTabIds(usePanesStore.getState().rootPane)).toEqual(["t1"]);
  });

  it("幂等：同一 tabId 连调两次，第二次零 kill 零树变化（React19 dev 双挂载）", async () => {
    const tab = splitTab("t1", ["sess-a"]);
    setPanesState(makePanel("p1", [tab]), "p1");

    usePanesStore.getState().removeTabsInternal(["t1"], "user-close");
    await vi.waitFor(() => expect(killSpy).toHaveBeenCalled());
    const afterFirst = killedIds();

    killSpy.mockClear();
    usePanesStore.getState().removeTabsInternal(["t1"], "user-close");
    await new Promise((r) => setTimeout(r, 0));

    expect(afterFirst).toEqual(["sess-a"]);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("protectSessionIds 名单内的会话不杀（snapshot-apply 差集保护）", async () => {
    const tab = splitTab("t1", ["sess-keep", "sess-drop"]);
    setPanesState(makePanel("p1", [tab]), "p1");

    usePanesStore
      .getState()
      .removeTabsInternal(["t1"], "snapshot-apply", {
        protectSessionIds: new Set(["sess-keep"]),
      });
    await vi.waitFor(() => expect(killSpy).toHaveBeenCalled());

    expect(killedIds()).toEqual(["sess-drop"]);
  });
});

// ============================================================================
// B1-05 改道后的关键回归。
//
// 「拖动标签杀掉自己的会话」是本批最容易造成的灾难：moveTab 系搬走 tab 后
// 借道 closePane 收空壳，而 closePane 自 B1-05 起会销毁 pane 内的 tab。
// 这组断言把「搬走 ≠ 销毁」永久钉死。
// ============================================================================
describe("moveTab / closeTab 改道后（搬走不杀、双 push 已修）", () => {
  function tabWithSession(id: string, sessionId: string): Tab {
    const tab = makeTerminalTab(id);
    (tab.terminalRootPane as TerminalPaneLeaf).sessionId = sessionId;
    return tab;
  }

  it("moveTab 搬空源 pane：收树但零 kill", async () => {
    const tab = tabWithSession("t1", "sess-moving");
    const src = makePanel("p1", [tab]);
    const dst = makePanel("p2", [makeTerminalTab("t2")]);
    setPanesState(makeSplit("root", [src, dst]), "p1");

    usePanesStore.getState().moveTab("p1", "p2", "t1");
    await new Promise((r) => setTimeout(r, 0));

    expect(killSpy).not.toHaveBeenCalled();
    // tab 活着，只是换了 pane
    expect(collectTabIds(usePanesStore.getState().rootPane)).toContain("t1");
  });

  it("closeTab 关最后一个 tab：杀会话且撤销栈只记一条（双 push 已修）", async () => {
    const tab = tabWithSession("t1", "sess-last");
    const src = makePanel("p1", [tab]);
    const dst = makePanel("p2", [makeTerminalTab("t2")]);
    setPanesState(makeSplit("root", [src, dst]), "p1");

    usePanesStore.getState().closeTab("p1", "t1");
    await vi.waitFor(() => expect(killSpy).toHaveBeenCalled());

    expect(killedIds()).toEqual(["sess-last"]);
    expect(usePanesStore.getState().closedTabs.filter((s) => s.projectId === "proj-t1"))
      .toHaveLength(1);
  });

  it("closePane 有 tab 时销毁全部内容（close-pane 矩阵：不豁免 pinned）", async () => {
    const normal = tabWithSession("t1", "sess-a");
    const pinned = tabWithSession("t2", "sess-b");
    pinned.pinned = true;
    const src = makePanel("p1", [normal, pinned]);
    const dst = makePanel("p2", [makeTerminalTab("t3")]);
    setPanesState(makeSplit("root", [src, dst]), "p1");

    usePanesStore.getState().closePane("p1");
    await vi.waitFor(() => expect(killSpy).toHaveBeenCalledTimes(2));

    expect(killedIds()).toEqual(["sess-a", "sess-b"]);
  });
});
