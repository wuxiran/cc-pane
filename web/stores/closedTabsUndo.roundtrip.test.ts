// 关闭撤销的往返无损（docs/78 批4）。
//
// 观察点是**逐字段 deepEqual**，不是「恢复出一个同项目的标签就算过」：此前
// 快照缺 launchExtras 与分屏结构，撤销出来的是「同一个项目的新标签」——
// YOLO 关了、跳过 MCP 没了、四格工作台变一格，而所有断言照样绿。
import { beforeEach, describe, expect, it } from "vitest";

import { usePanesStore } from "./usePanesStore";
import { useTerminalStatusStore } from "./useTerminalStatusStore";
import { createPanel } from "@/lib/paneTree";
import { collectTerminalLeaves } from "@/lib/paneSessions";
import type { Panel, Tab, TerminalPaneNode } from "@/types";

function resetStore(): string {
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
  return initialPanel.id;
}

function tabsOf(): Tab[] {
  return (usePanesStore.getState().rootPane as Panel).tabs;
}

function findByPath(path: string): Tab | undefined {
  return usePanesStore
    .getState()
    .allPanels()
    .flatMap((p) => p.tabs)
    .find((t) => t.projectPath === path);
}

/** 结构骨架：只留形状与 sizes，id 与运行时字段不参与比较。 */
function shape(node: TerminalPaneNode): unknown {
  if (node.type === "leaf") return { type: "leaf", resumeId: node.resumeId, cliTool: node.cliTool };
  return {
    type: "split",
    direction: node.direction,
    sizes: node.sizes,
    children: node.children.map(shape),
  };
}

describe("关闭撤销往返", () => {
  beforeEach(() => {
    resetStore();
  });

  it("启动身份字段逐字段全等（launchExtras 含在内）", () => {
    const paneId = usePanesStore.getState().rootPane.id;
    usePanesStore.getState().addTab(paneId, {
      projectId: "proj-1",
      projectPath: "/tmp/proj1",
      cliTool: "codex",
      customTitle: "工作台",
      resumeId: "resume-abc",
      workspaceName: "ws",
      workspacePath: "/ws",
      providerId: "prov-1",
      modelId: "model-1",
      launchProfileId: "profile-1",
      machineName: "box",
      wsl: { distro: "Ubuntu", remotePath: "/mnt/d/proj1" },
      launchExtras: { yolo: true, skipMcp: true, appendSystemPrompt: "be brief" },
    });

    const before = tabsOf().find((t) => t.projectPath === "/tmp/proj1")!;
    usePanesStore.getState().removeTabsInternal([before.id], "user-close");
    usePanesStore.getState().reopenClosedTab(paneId);
    const after = findByPath("/tmp/proj1")!;

    const identity = (tab: Tab) => ({
      title: tab.title,
      projectId: tab.projectId,
      projectPath: tab.projectPath,
      cliTool: tab.cliTool,
      resumeId: tab.resumeId,
      workspaceName: tab.workspaceName,
      workspacePath: tab.workspacePath,
      providerId: tab.providerId,
      modelId: tab.modelId,
      launchProfileId: tab.launchProfileId,
      machineName: tab.machineName,
      wsl: tab.wsl,
      launchExtras: tab.launchExtras,
      launchClaude: tab.launchClaude,
    });
    expect(identity(after)).toEqual(identity(before));
  });

  it("initialPrompt 不进快照——撤销出来的会话不得重放首启 prompt", () => {
    const paneId = usePanesStore.getState().rootPane.id;
    usePanesStore.getState().addTab(paneId, {
      projectId: "proj-1",
      projectPath: "/tmp/prompt",
      cliTool: "claude",
      launchExtras: { initialPrompt: "帮我重构", yolo: true },
    });
    const before = tabsOf().find((t) => t.projectPath === "/tmp/prompt")!;
    usePanesStore.getState().removeTabsInternal([before.id], "user-close");

    expect(usePanesStore.getState().closedTabs[0].launchExtras).toEqual({ yolo: true });

    usePanesStore.getState().reopenClosedTab(paneId);
    const after = findByPath("/tmp/prompt")!;
    expect(after.launchExtras?.initialPrompt).toBeUndefined();
    expect(after.launchExtras?.yolo).toBe(true);
  });

  it("starred / parentTabId 往返保留", () => {
    // pinned 不在这条用例里：user-close 尊重 pinned（DESTROY_POLICY），置顶标签
    // 根本关不掉，也就无从进撤销栈——pinned 的往返在 restoreClosedTabIdentity
    // 的单测里覆盖。
    const paneId = usePanesStore.getState().rootPane.id;
    usePanesStore.getState().addTab(paneId, {
      projectId: "proj-1",
      projectPath: "/tmp/identity",
      parentTabId: "tab-parent",
    });
    const before = tabsOf().find((t) => t.projectPath === "/tmp/identity")!;
    usePanesStore.getState().toggleStarTab(before.id);
    usePanesStore.getState().removeTabsInternal([before.id], "user-close");

    const snap = usePanesStore.getState().closedTabs[0];
    expect(snap.starred).toBe(true);
    expect(snap.parentTabId).toBe("tab-parent");

    usePanesStore.getState().reopenClosedTab(paneId);
    const after = findByPath("/tmp/identity")!;
    expect(after.starred).toBe(true);
    expect(after.parentTabId).toBe("tab-parent");
  });

  it("分屏结构往返：三格工作台撤销后仍是三格，且每格的启动身份就位", () => {
    const paneId = usePanesStore.getState().rootPane.id;
    usePanesStore.getState().addTab(paneId, {
      projectId: "proj-1",
      projectPath: "/tmp/split",
      cliTool: "claude",
      resumeId: "resume-root",
    });
    const created = tabsOf().find((t) => t.projectPath === "/tmp/split")!;
    usePanesStore.getState().splitTerminalPane(created.id, created.activeTerminalPaneId!, "right");
    const twoLeaves = findByPath("/tmp/split")!;
    usePanesStore
      .getState()
      .splitTerminalPane(twoLeaves.id, twoLeaves.activeTerminalPaneId!, "down");

    const before = findByPath("/tmp/split")!;
    expect(collectTerminalLeaves(before.terminalRootPane)).toHaveLength(3);

    usePanesStore.getState().removeTabsInternal([before.id], "user-close");
    usePanesStore.getState().reopenClosedTab(paneId);
    const after = findByPath("/tmp/split")!;

    expect(shape(after.terminalRootPane!)).toEqual(shape(before.terminalRootPane!));
    const leaves = collectTerminalLeaves(after.terminalRootPane);
    expect(leaves).toHaveLength(3);
    // activeTerminalPaneId 必须指向恢复后的某个 leaf，否则整棵树在 UI 上无从聚焦
    expect(leaves.some((leaf) => leaf.id === after.activeTerminalPaneId)).toBe(true);
  });

  it("恢复出的每个 leaf 都过了重置清单：无活会话字段、id 与 launchId 全新", () => {
    const paneId = usePanesStore.getState().rootPane.id;
    usePanesStore.getState().addTab(paneId, {
      projectId: "proj-1",
      projectPath: "/tmp/reset",
      cliTool: "claude",
    });
    const created = tabsOf().find((t) => t.projectPath === "/tmp/reset")!;
    usePanesStore.getState().splitTerminalPane(created.id, created.activeTerminalPaneId!, "right");
    const before = findByPath("/tmp/reset")!;
    const beforeLeafIds = collectTerminalLeaves(before.terminalRootPane).map((l) => l.id);
    const beforeLaunchIds = collectTerminalLeaves(before.terminalRootPane).map((l) => l.launchId);

    usePanesStore.getState().removeTabsInternal([before.id], "user-close");
    usePanesStore.getState().reopenClosedTab(paneId);
    const leaves = collectTerminalLeaves(findByPath("/tmp/reset")!.terminalRootPane);

    for (const leaf of leaves) {
      expect(leaf.sessionId).toBeNull();
      expect(leaf.savedSessionId).toBeUndefined();
      expect(leaf.restoring).toBe(false);
      expect(leaf.disconnected).toBe(false);
      expect(leaf.restoreBlockedReason).toBeUndefined();
      expect(leaf.leaseReadOnly).toBe(false);
      expect(leaf.launchError).toBeUndefined();
      expect(leaf.launchAttempt).toBe(0);
      expect(beforeLeafIds).not.toContain(leaf.id);
      // launchId 每次新生成（docs/69）
      expect(beforeLaunchIds).not.toContain(leaf.launchId);
    }
  });

  it("同一条快照重开两次不会撞 id（撤销栈可被重复消费）", () => {
    const paneId = usePanesStore.getState().rootPane.id;
    usePanesStore.getState().addTab(paneId, {
      projectId: "proj-1",
      projectPath: "/tmp/twice",
      cliTool: "claude",
    });
    const created = tabsOf().find((t) => t.projectPath === "/tmp/twice")!;
    usePanesStore.getState().splitTerminalPane(created.id, created.activeTerminalPaneId!, "right");
    const before = findByPath("/tmp/twice")!;
    usePanesStore.getState().removeTabsInternal([before.id], "user-close");

    const snap = usePanesStore.getState().closedTabs[0];
    usePanesStore.getState().reopenClosedTab(paneId);
    const first = findByPath("/tmp/twice")!;
    const firstIds = collectTerminalLeaves(first.terminalRootPane).map((l) => l.id);

    usePanesStore.setState({ closedTabs: [snap] });
    usePanesStore.getState().reopenClosedTab(paneId);
    const all = tabsOf().filter((t) => t.projectPath === "/tmp/twice");
    expect(all).toHaveLength(2);
    const secondIds = collectTerminalLeaves(all[all.length - 1].terminalRootPane).map((l) => l.id);
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
  });

  it("快照里的嵌套对象已脱 draft（set 结束后仍可读）", () => {
    const paneId = usePanesStore.getState().rootPane.id;
    usePanesStore.getState().addTab(paneId, {
      projectId: "proj-1",
      projectPath: "/tmp/detach",
      cliTool: "claude",
      wsl: { distro: "Ubuntu", remotePath: "/mnt/d/x" },
      launchExtras: { yolo: true },
    });
    const created = tabsOf().find((t) => t.projectPath === "/tmp/detach")!;
    usePanesStore.getState().splitTerminalPane(created.id, created.activeTerminalPaneId!, "right");
    const before = findByPath("/tmp/detach")!;
    usePanesStore.getState().removeTabsInternal([before.id], "user-close");

    // revoked proxy 会在这里抛；能读出值即说明快照是普通对象。
    const snap = usePanesStore.getState().closedTabs[0];
    expect(JSON.parse(JSON.stringify(snap.wsl))).toEqual({
      distro: "Ubuntu",
      remotePath: "/mnt/d/x",
    });
    expect(snap.launchExtras).toEqual({ yolo: true });
    expect(JSON.stringify(snap.terminalRootPane)).toContain("split");
  });
});
