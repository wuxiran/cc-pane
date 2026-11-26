// createPaneRemovalActions 的关闭出口测试（B1-03 起）：removeTabsInternal /
// removeTerminalLeafInternal / removeEmptyPane 的树操作、closedTabs 撤销栈与回收
// 管线（killSession 杀集）契约——重点是 removeEmptyPane 的「非空即拒」硬守卫。
// usePanesStore.test.ts 原 closeTab/closePane 组已不存在，本文件即这些出口的主测试；
// 终端子窗格关闭后的树形（单 child split 壳不上提）见 usePanesStore.test.ts 的 terminal subpanes 组。
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { usePanesStore } from "./usePanesStore";
import { terminalService } from "@/services";
import { useFullscreenStore } from "./useFullscreenStore";
import { createPanel } from "@/lib/paneTree";
import { CLOSED_TABS_LIMIT } from "./closedTabsUndo";
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

/** 带会话的单 leaf 终端标签；saved 写到 leaf.savedSessionId（恢复中）。 */
function makeSessionTab(id: string, sessionId: string | null, saved?: string): Tab {
  const tab = makeTerminalTab(id);
  const leaf = tab.terminalRootPane as TerminalPaneLeaf;
  leaf.sessionId = sessionId;
  if (saved) leaf.savedSessionId = saved;
  return tab;
}

/** 多布局初始状态：第一个布局为当前布局，其 rootPane 即工作副本。 */
function setLayoutsState(layouts: Array<{ id: string; rootPane: PaneNode; activePaneId: string }>) {
  const [current] = layouts;
  usePanesStore.setState({
    rootPane: current.rootPane,
    activePaneId: current.activePaneId,
    layouts: layouts.map((l, i) => ({ ...l, name: `布局 ${i + 1}`, kind: "normal" as const })),
    currentLayoutId: current.id,
    closedTabs: [],
    poppedOutTabs: new Set<string>(),
  });
}

function setPanesState(rootPane: PaneNode, activePaneId: string) {
  setLayoutsState([{ id: "layout-1", rootPane, activePaneId }]);
}

function collectTabIds(node: PaneNode): string[] {
  if (node.type === "panel") return node.tabs.map((t) => t.id);
  return node.children.flatMap(collectTabIds);
}

/** 让出一个宏任务：给「本不该发生」的异步 kill 一个发生的机会。 */
function flushMacrotask() {
  return new Promise((r) => setTimeout(r, 0));
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

describe("批量关闭（removeTabsInternal batch-close）", () => {
  function threeTabs(): Panel {
    return makePanel("p1", [
      makeTerminalTab("t1"),
      makeTerminalTab("t2"),
      makeTerminalTab("t3"),
    ]);
  }

  it("改道后的批量关闭记 closedTabs（batch-close 矩阵，修复撤销失效）", () => {
    setPanesState(threeTabs(), "p1");

    // UI 侧 doBatchClose 的等价调用
    usePanesStore.getState().removeTabsInternal(["t2", "t3"], "batch-close");

    expect(usePanesStore.getState().closedTabs.map((s) => s.projectId).sort())
      .toEqual(["proj-t2", "proj-t3"]);
  });
});

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

  it.each([
    ["不存在的 paneId", "nope"],
    ["split 节点 id（只收 panel）", "s1"],
  ])("%s 静默 no-op", (_label, paneId) => {
    const p1 = makePanel("p1", [makeTerminalTab("t1")]);
    const p2 = makePanel("p2", []);
    setPanesState(makeSplit("s1", [p1, p2]), "p1");
    const before = usePanesStore.getState().rootPane;

    usePanesStore.getState().removeEmptyPane(paneId);

    expect(usePanesStore.getState().rootPane).toBe(before);
    expect((usePanesStore.getState().rootPane as SplitPane).children).toHaveLength(2);
  });
});

describe("removeTabsInternal（骨架：树 splice + closedTabs + 附属清理）", () => {
  it("终端标签关闭时快照进 closedTabs（字段齐全）", () => {
    const tab = makeTerminalTab("t1", {
      title: "自定义标题",
      cliTool: "claude",
      workspaceName: "ws-1",
    });
    setPanesState(makePanel("p1", [tab, makeTerminalTab("t2")]), "p1");

    usePanesStore.getState().removeTabsInternal(["t1"], "user-close");

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

  it("delete-layout：不记 closedTabs、pinned 也移除", () => {
    const tabs = [makeTerminalTab("t1", { pinned: true }), makeTerminalTab("t2")];
    setPanesState(makePanel("p1", tabs), "p1");

    usePanesStore.getState().removeTabsInternal(["t1"], "delete-layout");

    expect(currentPanel("p1").tabs.map((t) => t.id)).toEqual(["t2"]);
    expect(usePanesStore.getState().closedTabs).toHaveLength(0);
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

  it("清理 poppedOutTabs 里被移除 tab 的条目", () => {
    setPanesState(makePanel("p1", [makeTerminalTab("t1"), makeTerminalTab("t2")]), "p1");
    usePanesStore.setState({ poppedOutTabs: new Set(["t1", "t2"]) });

    usePanesStore.getState().removeTabsInternal(["t1"], "delete-layout");

    expect([...usePanesStore.getState().poppedOutTabs]).toEqual(["t2"]);
  });

  it("非当前布局里的 tab 也能移除", () => {
    const current = makePanel("p1", [makeTerminalTab("t1")]);
    const otherPanel = makePanel("p2", [makeTerminalTab("t2"), makeTerminalTab("t3")]);
    setLayoutsState([
      { id: "layout-1", rootPane: current, activePaneId: "p1" },
      { id: "layout-2", rootPane: otherPanel, activePaneId: "p2" },
    ]);

    usePanesStore.getState().removeTabsInternal(["t2"], "delete-layout");

    const other = usePanesStore.getState().layouts.find((l) => l.id === "layout-2")!;
    expect(collectTabIds(other.rootPane)).toEqual(["t3"]);
  });
});

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
    await flushMacrotask();

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
    // 撤销栈也只记被关掉的那个
    expect(usePanesStore.getState().closedTabs.map((t) => t.projectId)).toEqual(["proj-t2"]);
  });

  it("幂等：同一 tabId 连调两次，第二次零 kill 零树变化（React19 dev 双挂载）", async () => {
    const tab = splitTab("t1", ["sess-a"]);
    setPanesState(makePanel("p1", [tab]), "p1");

    usePanesStore.getState().removeTabsInternal(["t1"], "user-close");
    await vi.waitFor(() => expect(killSpy).toHaveBeenCalled());
    const afterFirst = killedIds();
    const rootAfterFirst = usePanesStore.getState().rootPane;

    killSpy.mockClear();
    usePanesStore.getState().removeTabsInternal(["t1"], "user-close");
    await flushMacrotask();

    expect(afterFirst).toEqual(["sess-a"]);
    expect(killSpy).not.toHaveBeenCalled();
    expect(usePanesStore.getState().rootPane).toBe(rootAfterFirst);
    expect(usePanesStore.getState().closedTabs).toHaveLength(1);
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
describe("moveTab 搬走不杀 / 统一出口销毁语义", () => {
  it("moveTab 搬空源 pane：收树但零 kill", async () => {
    const tab = makeSessionTab("t1", "sess-moving");
    const src = makePanel("p1", [tab]);
    const dst = makePanel("p2", [makeTerminalTab("t2")]);
    setPanesState(makeSplit("root", [src, dst]), "p1");

    usePanesStore.getState().moveTab("p1", "p2", "t1");
    await flushMacrotask();

    expect(killSpy).not.toHaveBeenCalled();
    // tab 活着，只是换了 pane
    expect(collectTabIds(usePanesStore.getState().rootPane)).toContain("t1");
  });

  it("关最后一个 tab：杀会话且撤销栈只记一条", async () => {
    const tab = makeSessionTab("t1", "sess-last");
    const src = makePanel("p1", [tab]);
    const dst = makePanel("p2", [makeTerminalTab("t2")]);
    setPanesState(makeSplit("root", [src, dst]), "p1");

    usePanesStore.getState().removeTabsInternal(["t1"], "user-close");
    await vi.waitFor(() => expect(killSpy).toHaveBeenCalled());

    expect(killedIds()).toEqual(["sess-last"]);
    expect(usePanesStore.getState().closedTabs.filter((s) => s.projectId === "proj-t1"))
      .toHaveLength(1);
    // 空 pane 收壳（与 closeTabInTree 同语义）
    const shell = usePanesStore.getState().rootPane as SplitPane;
    expect(shell.children.map((c) => c.id)).toEqual(["p2"]);
  });

  it("close-pane 矩阵销毁 pane 全部内容（不豁免 pinned）", async () => {
    const normal = makeSessionTab("t1", "sess-a");
    const pinned = makeSessionTab("t2", "sess-b");
    pinned.pinned = true;
    const src = makePanel("p1", [normal, pinned]);
    const dst = makePanel("p2", [makeTerminalTab("t3")]);
    setPanesState(makeSplit("root", [src, dst]), "p1");

    usePanesStore.getState().removeTabsInternal(["t1", "t2"], "close-pane");
    await vi.waitFor(() => expect(killSpy).toHaveBeenCalledTimes(2));

    expect(killedIds()).toEqual(["sess-a", "sess-b"]);
  });
});

// ============================================================================
// B1-07：关一格的杀集边界。
// 关一格只该杀一格——用整 tab 的口径会连坐同一个分屏里的其他会话。
// ============================================================================
describe("removeTerminalLeafInternal（改道后：只杀这一格）", () => {
  function twoLeafTab(id: string, a: string, b: string, savedOnB?: string): Tab {
    const tab = makeTerminalTab(id);
    tab.terminalRootPane = {
      type: "split",
      id: `${id}-split`,
      direction: "horizontal",
      children: [
        { type: "leaf", id: `${id}-leaf-a`, sessionId: a },
        {
          type: "leaf",
          id: `${id}-leaf-b`,
          sessionId: savedOnB ? null : b,
          ...(savedOnB ? { savedSessionId: savedOnB } : {}),
        },
      ],
      sizes: [50, 50],
    } as unknown as Tab["terminalRootPane"];
    tab.activeTerminalPaneId = `${id}-leaf-a`;
    return tab;
  }

  it("只杀目标格的会话，同 tab 其他格不受牵连", async () => {
    setPanesState(makePanel("p1", [twoLeafTab("t1", "sess-a", "sess-b")]), "p1");

    usePanesStore.getState().removeTerminalLeafInternal("t1", "t1-leaf-a", "user-close");
    await vi.waitFor(() => expect(killSpy).toHaveBeenCalled());

    expect(killedIds()).toEqual(["sess-a"]);
  });

  it("目标格只有 savedSessionId（恢复中）也杀——改道前这里会漏成孤儿", async () => {
    setPanesState(makePanel("p1", [twoLeafTab("t1", "sess-a", "", "sess-saved")]), "p1");

    usePanesStore.getState().removeTerminalLeafInternal("t1", "t1-leaf-b", "user-close");
    await vi.waitFor(() => expect(killSpy).toHaveBeenCalled());

    expect(killedIds()).toEqual(["sess-saved"]);
  });
});

// ============================================================================
// B1-11：快照覆盖的差集观察（真杀未开闸）。
//
// 最危险的一条路径：跨端同步每 5s 一轮，整树替换后旧树会话失去引用，但它们
// 常常马上被 reconcile 收养回来。差集算错 = 开闸后杀光用户所有活会话。
// ============================================================================
describe("applyLayoutSnapshotPayload（差集观察，本轮不真杀）", () => {
  function payloadWith(tabs: Tab[]) {
    const panel = makePanel("p-new", tabs);
    return {
      schemaVersion: 2 as const,
      currentLayoutId: "layout-new",
      layouts: [
        {
          id: "layout-new",
          name: "新布局",
          kind: "normal" as const,
          rootPane: panel,
          activePaneId: panel.id,
        },
      ],
    };
  }

  it("快照期间绝不 kill——真杀要等批2 后开闸并复核活会话", async () => {
    setPanesState(makePanel("p1", [makeSessionTab("t1", "sess-old")]), "p1");

    usePanesStore.getState().applyLayoutSnapshotPayload(payloadWith([makeSessionTab("t2", "sess-new")]));
    await flushMacrotask();

    expect(killSpy).not.toHaveBeenCalled();
  });

  it("补账2：apply 只登记候选，settle 复核后才出最终 would-kill（含收养扣除）", async () => {
    const { finalizeSnapshotWouldKill, resetSnapshotKillState } =
      await import("./snapshotSessionDiff");
    resetSnapshotKillState();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    setPanesState(
      makePanel("p1", [makeSessionTab("t1", "sess-keep"), makeSessionTab("t3", "sess-gone")]),
      "p1",
    );

    // 新树用 savedSessionId 引用 sess-keep——apply 阶段差集就该排除它
    usePanesStore.getState().applyLayoutSnapshotPayload(
      payloadWith([makeSessionTab("t2", null, "sess-keep"), makeSessionTab("t4", "sess-new")]),
    );

    // apply 阶段不出 would-kill 日志（口径已后置）
    expect(
      info.mock.calls.some((c) => String(c[0]).includes("would-kill")),
    ).toBe(false);

    // settle：后端说 sess-gone 其实还活着（被收养）→ 扣除；此处模拟没活 → 进最终集
    const final = finalizeSnapshotWouldKill(new Set(), new Set());
    expect(final).toContain("sess-gone");
    expect(final).not.toContain("sess-keep");
  });

  it("补账2：apply 只登记候选，settle 复核后才出最终 would-kill（含收养扣除）", async () => {
    const { finalizeSnapshotWouldKill, resetSnapshotKillState } =
      await import("./snapshotSessionDiff");
    resetSnapshotKillState();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    setPanesState(makePanel("p1", [makeSessionTab("t1", "sess-gone")]), "p1");

    usePanesStore.getState().applyLayoutSnapshotPayload(payloadWith([makeSessionTab("t2", "sess-new")]));

    // apply 阶段不出 would-kill 日志（口径已后置）
    expect(
      info.mock.calls.some((c) => String(c[0]).includes("would-kill")),
    ).toBe(false);

    // settle：后端说 sess-gone 其实还活着（被收养）→ 扣除；此处模拟没活 → 进最终集
    const final = finalizeSnapshotWouldKill(new Set(), new Set());
    expect(final).toContain("sess-gone");
  });
});

// ============================================================================
// 自审补漏：销毁标签必须清视图 store（批2 计划项，实施时漏接）。
// 不清的话条目永远残留且大概率停在 active（人总是关当前标签），批3 的
// hidden 上报接线后会把死标签当「可见」上报。
// ============================================================================
describe("销毁标签清理视图 store", () => {
  it("removeTabsInternal 清掉被关标签的 views 与 aggregate 条目", async () => {
    const { useTabViewStateStore } = await import("./useTabViewStateStore");
    useTabViewStateStore.setState({ views: {}, aggregate: {} });
    useTabViewStateStore.getState().reportView("t1", "primary", "active");

    setPanesState(makePanel("p1", [makeTerminalTab("t1"), makeTerminalTab("t2")]), "p1");
    usePanesStore.getState().removeTabsInternal(["t1"], "user-close");

    expect(useTabViewStateStore.getState().aggregate["t1"]).toBeUndefined();
    expect(Object.keys(useTabViewStateStore.getState().views)).toEqual([]);
  });
});

// ============================================================================
// Codex 代码审查 P0 两条的回归锁。
// ============================================================================
describe("Codex 审查 P0 回归", () => {
  it("跨布局同 id 副本：pinned 副本正在用的会话进保护集，不被杀", async () => {
    // 历史快照互覆盖会产生跨布局同 id 的副本（closeTabBySessionId 的注释
    // 即为此扫完全部布局）。pinned 副本留在树上，它显示的会话绝不能被
    // 另一个未 pinned 副本的销毁连坐——否则 pinned 标签里是个死终端。
    const shared = makeSessionTab("t1", "sess-shared");
    const pinnedCopy = { ...shared, pinned: true };

    setLayoutsState([
      { id: "l1", rootPane: makePanel("p1", [shared]), activePaneId: "p1" },
      { id: "l2", rootPane: makePanel("p2", [pinnedCopy]), activePaneId: "p2" },
    ]);

    usePanesStore.getState().removeTabsInternal(["t1"], "user-close");
    await flushMacrotask();

    // pinned 副本的会话被保护——零 kill
    expect(killSpy).not.toHaveBeenCalledWith("sess-shared", expect.anything());
    expect(killSpy).not.toHaveBeenCalledWith("sess-shared");
  });

  it("removeTerminalLeafInternal 最后一格：**零 kill 零树变化**（防「会话死了格子还在」）", async () => {
    setPanesState(makePanel("p1", [makeSessionTab("t1", "sess-only")]), "p1");

    // 调用方应改走 removeTabsInternal
    usePanesStore.getState().removeTerminalLeafInternal("t1", "t1-leaf", "user-close");
    await flushMacrotask();

    expect(killSpy).not.toHaveBeenCalled();
    expect(currentPanel("p1").tabs).toHaveLength(1);
    expect(currentPanel("p1").tabs[0].terminalRootPane?.type).toBe("leaf");
  });
});

// ============================================================================
// 批4 onPersist：browser/editor 的撤销（此前只有终端能撤销）。
// ============================================================================
describe("非终端标签的撤销（persistForUndo）", () => {
  it("关掉 browser 标签 → 撤销栈记 URL；editor 记 filePath", () => {
    const browserTab: Tab = {
      id: "b1", title: "文档", contentType: "browser",
      projectId: "p", projectPath: "/tmp/p", sessionId: null,
      browserUrl: "https://example.com/docs",
    } as Tab;
    const editorTab: Tab = {
      id: "e1", title: "main.rs", contentType: "editor",
      projectId: "p", projectPath: "/tmp/p", sessionId: null,
      filePath: "/tmp/p/src/main.rs",
    } as Tab;
    setPanesState(makePanel("p1", [browserTab, editorTab, makeTerminalTab("t1")]), "p1");

    usePanesStore.getState().removeTabsInternal(["b1", "e1"], "user-close");

    const snaps = usePanesStore.getState().closedTabs;
    expect(snaps.map((s) => s.contentType).sort()).toEqual(["browser", "editor"]);
    expect(snaps.find((s) => s.contentType === "browser")?.browserUrl)
      .toBe("https://example.com/docs");
    expect(snaps.find((s) => s.contentType === "editor")?.filePath)
      .toBe("/tmp/p/src/main.rs");
    expect(currentPanel("p1").tabs.map((t) => t.id)).toEqual(["t1"]);
  });

  it("memory-manager 等无 persistForUndo 的类型不进撤销栈", () => {
    const tool: Tab = {
      id: "m1", title: "Memory", contentType: "memory-manager",
      projectId: "p", projectPath: "/tmp/p", sessionId: null,
    } as Tab;
    setPanesState(makePanel("p1", [tool, makeTerminalTab("t1")]), "p1");

    usePanesStore.getState().removeTabsInternal(["m1"], "user-close");

    expect(usePanesStore.getState().closedTabs).toHaveLength(0);
  });
});
