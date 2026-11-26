import { beforeEach, describe, expect, it } from "vitest";
import { usePanesStore } from "./usePanesStore";
import { useTerminalStatusStore } from "./useTerminalStatusStore";
import { createPanel } from "@/lib/paneTree";
import { resetTestDataCounter } from "@/test/utils/testData";
import type { Panel, TerminalPaneLeaf } from "@/types";

function setRunningLeaf(tabId: string, patch: Partial<TerminalPaneLeaf>) {
  usePanesStore.setState((state) => {
    const tab = (state.rootPane as Panel).tabs.find((item) => item.id === tabId)!;
    const leaf = tab.terminalRootPane!;
    if (leaf.type !== "leaf") throw new Error("expected leaf");
    Object.assign(leaf, patch);
    tab.sessionId = patch.sessionId ?? tab.sessionId;
  });
}

function addTerminal(options: Record<string, unknown>, session: Partial<TerminalPaneLeaf>) {
  const paneId = usePanesStore.getState().rootPane.id;
  usePanesStore.getState().addTab(paneId, {
    projectId: "proj-1",
    projectPath: "/tmp/proj1",
    ...options,
  });
  const pane = usePanesStore.getState().rootPane as Panel;
  const tab = pane.tabs[pane.tabs.length - 1];
  setRunningLeaf(tab.id, session);
  return { tabId: tab.id, leafId: (tab.terminalRootPane as { id: string }).id };
}

function leafOf(tabId: string): TerminalPaneLeaf {
  const tab = (usePanesStore.getState().rootPane as Panel).tabs.find((item) => item.id === tabId)!;
  const leaf = tab.terminalRootPane!;
  if (leaf.type !== "leaf") throw new Error("expected leaf");
  return leaf;
}

describe("terminal relaunch actions", () => {
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

  it("只收集本机运行中的 Claude 会话", () => {
    const claude = addTerminal({ cliTool: "claude", resumeId: "r-1" }, { sessionId: "s-1", resumeId: "r-1" });
    addTerminal({ cliTool: "codex" }, { sessionId: "s-2" });
    addTerminal({ cliTool: "claude" }, { sessionId: null });
    addTerminal(
      { cliTool: "claude", wsl: { distro: "Ubuntu", remotePath: "/home/u" } },
      { sessionId: "s-4" },
    );

    const targets = usePanesStore.getState().collectClaudeRelaunchTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      tabId: claude.tabId,
      terminalPaneId: claude.leafId,
      sessionId: "s-1",
      resumeId: "r-1",
    });
    expect(usePanesStore.getState().collectClaudeRelaunchTargets({ tabId: "nope" })).toHaveLength(0);
  });

  it("begin 摘掉 sessionId；成功则原位递增 launchAttempt，leaf id 与 resumeId 不变", () => {
    const { tabId, leafId } = addTerminal(
      { cliTool: "claude", resumeId: "r-1" },
      { sessionId: "s-1", resumeId: "r-1", launchAttempt: 2, launchId: "launch-old" },
    );
    const state = usePanesStore.getState();

    expect(state.beginTerminalRelaunch(tabId, leafId, "other-session")).toBeNull();
    expect(state.beginTerminalRelaunch(tabId, leafId, "s-1")).toBe("s-1");
    expect(leafOf(tabId).sessionId).toBeNull();
    expect(leafOf(tabId).restoring).toBe(true);

    usePanesStore.getState().finishTerminalRelaunch(tabId, leafId, "s-1", true);
    const leaf = leafOf(tabId);
    expect(leaf.id).toBe(leafId);
    expect(leaf.sessionId).toBeNull();
    expect(leaf.resumeId).toBe("r-1");
    expect(leaf.launchAttempt).toBe(3);
    expect(leaf.launchId).not.toBe("launch-old");
    expect(leaf.restoreMode).toBe("resumed");
  });

  it("kill 失败时接回旧 sessionId", () => {
    const { tabId, leafId } = addTerminal(
      { cliTool: "claude", resumeId: "r-1" },
      { sessionId: "s-1", resumeId: "r-1", launchAttempt: 0 },
    );
    expect(usePanesStore.getState().beginTerminalRelaunch(tabId, leafId)).toBe("s-1");
    usePanesStore.getState().finishTerminalRelaunch(tabId, leafId, "s-1", false);
    const leaf = leafOf(tabId);
    expect(leaf.sessionId).toBe("s-1");
    expect(leaf.restoring).toBe(false);
    expect(leaf.launchAttempt).toBe(0);
  });
});
