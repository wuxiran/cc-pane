import { describe, expect, it } from "vitest";
import { deriveWorkspaceTerminals, severityRank } from "./workspaceTerminals";
import type { PanesLayoutSlice } from "./workspaceTerminals";
import type { LayoutEntry, PaneNode, Tab, Workspace } from "@/types";
import type { TerminalStatusInfo } from "@/types";

let tabSeq = 0;
function makeTab(overrides: Partial<Tab> = {}): Tab {
  tabSeq += 1;
  return {
    id: `tab-${tabSeq}`,
    title: `Terminal ${tabSeq}`,
    contentType: "terminal",
    sessionId: `session-${tabSeq}`,
    projectPath: "D:\\repo\\alpha",
    workspaceName: "ws-alpha",
    ...overrides,
  } as Tab;
}

function panel(tabs: Tab[], id = `panel-${tabSeq}`): PaneNode {
  return { type: "panel", id, tabs, activeTabId: tabs[0]?.id ?? "" } as PaneNode;
}

function layout(id: string, rootPane: PaneNode, kind?: string): LayoutEntry {
  return { id, name: id, rootPane, activePaneId: "", kind } as unknown as LayoutEntry;
}

function makeWorkspace(id: string, name: string, projectPath: string): Workspace {
  return {
    id,
    name,
    projects: [{ id: `${id}-p1`, path: projectPath, alias: null }],
  } as unknown as Workspace;
}

function status(status: string, toolName?: string): TerminalStatusInfo {
  return { status, currentToolName: toolName ?? null } as TerminalStatusInfo;
}

const wsAlpha = makeWorkspace("ws-1", "ws-alpha", "D:\\repo\\alpha");
const wsBeta = makeWorkspace("ws-2", "ws-beta", "D:\\repo\\beta");

function slice(layouts: LayoutEntry[], currentLayoutId: string, workingCopy?: PaneNode): PanesLayoutSlice {
  const current = layouts.find((item) => item.id === currentLayoutId);
  return {
    layouts,
    currentLayoutId,
    rootPane: workingCopy ?? current?.rootPane ?? layouts[0].rootPane,
  } as PanesLayoutSlice;
}

describe("deriveWorkspaceTerminals", () => {
  it("groups running terminals by workspaceName", () => {
    const tabA = makeTab({ workspaceName: "ws-alpha" });
    const tabB = makeTab({ workspaceName: "ws-beta", projectPath: "D:\\repo\\beta" });
    const layouts = [layout("l1", panel([tabA, tabB]))];
    const grouped = deriveWorkspaceTerminals(slice(layouts, "l1"), [wsAlpha, wsBeta], new Map());
    expect(grouped.get("ws-1")?.map((row) => row.tabId)).toEqual([tabA.id]);
    expect(grouped.get("ws-2")?.map((row) => row.tabId)).toEqual([tabB.id]);
  });

  it("falls back to projectPath equivalence when workspaceName missing", () => {
    // /mnt/d 形式路径应经 projectPathsEquivalent 归到 D:\repo\alpha 的工作空间
    const tab = makeTab({ workspaceName: undefined, projectPath: "/mnt/d/repo/alpha" });
    const layouts = [layout("l1", panel([tab]))];
    const grouped = deriveWorkspaceTerminals(slice(layouts, "l1"), [wsAlpha], new Map());
    expect(grouped.get("ws-1")?.length).toBe(1);
  });

  it("drops tabs when both attributions fail", () => {
    const tab = makeTab({ workspaceName: undefined, projectPath: "D:\\elsewhere\\repo" });
    const layouts = [layout("l1", panel([tab]))];
    const grouped = deriveWorkspaceTerminals(slice(layouts, "l1"), [wsAlpha], new Map());
    expect(grouped.size).toBe(0);
  });

  it("skips tabs without live sessions and starred layouts", () => {
    const noSession = makeTab({ sessionId: undefined });
    const inStarred = makeTab();
    const layouts = [
      layout("l1", panel([noSession])),
      layout("starred", panel([inStarred]), "starred"),
    ];
    const grouped = deriveWorkspaceTerminals(slice(layouts, "l1"), [wsAlpha], new Map());
    expect(grouped.size).toBe(0);
  });

  it("reads the current layout from the working copy, not the stale layout entry", () => {
    const staleTab = makeTab();
    const liveTab = makeTab();
    const layouts = [layout("l1", panel([staleTab]))];
    const grouped = deriveWorkspaceTerminals(
      slice(layouts, "l1", panel([liveTab])),
      [wsAlpha],
      new Map(),
    );
    expect(grouped.get("ws-1")?.map((row) => row.tabId)).toEqual([liveTab.id]);
  });

  it("aggregates split-pane leaves to the worst status with session count", () => {
    const tab = makeTab({
      sessionId: undefined,
      terminalRootPane: {
        type: "split",
        id: "s",
        direction: "horizontal",
        children: [
          { type: "leaf", id: "leaf-1", sessionId: "sess-a" },
          { type: "leaf", id: "leaf-2", sessionId: "sess-b" },
        ],
      },
    } as Partial<Tab>);
    const layouts = [layout("l1", panel([tab]))];
    const statusMap = new Map([
      ["sess-a", status("idle")],
      ["sess-b", status("waitingInput")],
    ]);
    const grouped = deriveWorkspaceTerminals(slice(layouts, "l1"), [wsAlpha], statusMap);
    const row = grouped.get("ws-1")![0];
    expect(row.sessionCount).toBe(2);
    expect(row.status).toBe("waitingInput");
  });

  it("resolves first prompt via tab/leaf resumeId, ignoring the 'new' sentinel", () => {
    const withResume = makeTab({ resumeId: "cli-session-1" });
    const sentinel = makeTab({ resumeId: "new" });
    const layouts = [layout("l1", panel([withResume, sentinel]))];
    const firstPrompts = new Map([["cli-session-1", "帮我修复恢复日志"]]);
    const grouped = deriveWorkspaceTerminals(slice(layouts, "l1"), [wsAlpha], new Map(), firstPrompts);
    const rows = grouped.get("ws-1")!;
    expect(rows.find((r) => r.tabId === withResume.id)?.firstPrompt).toBe("帮我修复恢复日志");
    expect(rows.find((r) => r.tabId === sentinel.id)?.firstPrompt).toBeNull();
  });

  it("counts restoring tabs whose only id is savedSessionId (not yet attached)", () => {
    // 恢复中：sessionId 还没 attach，只有 savedSessionId——它对应真实 PTY，必须进列表
    const restoring = makeTab({ sessionId: undefined, restoring: true, savedSessionId: "saved-1" });
    const layouts = [layout("l1", panel([restoring]))];
    const grouped = deriveWorkspaceTerminals(slice(layouts, "l1"), [wsAlpha], new Map());
    const row = grouped.get("ws-1")![0];
    expect(row.tabId).toBe(restoring.id);
    expect(row.sessionCount).toBe(1);
  });

  it("dedupes leaf sessionId/savedSessionId pairs in the ×N session count", () => {
    const tab = makeTab({
      sessionId: undefined,
      terminalRootPane: {
        type: "split",
        id: "s2",
        direction: "vertical",
        children: [
          { type: "leaf", id: "leaf-1", sessionId: "sess-live", savedSessionId: "sess-live" },
          { type: "leaf", id: "leaf-2", sessionId: null, savedSessionId: "sess-saved" },
        ],
      },
    } as Partial<Tab>);
    const layouts = [layout("l1", panel([tab]))];
    const statusMap = new Map([["sess-live", status("toolRunning", "Bash")]]);
    const grouped = deriveWorkspaceTerminals(slice(layouts, "l1"), [wsAlpha], statusMap);
    const row = grouped.get("ws-1")![0];
    expect(row.sessionCount).toBe(2);
    expect(row.status).toBe("toolRunning");
  });

  it("keeps rows in stable layout/tree order regardless of status", () => {
    const busy = makeTab();
    const idle = makeTab();
    const layouts = [layout("l1", panel([idle, busy]))];
    const statusMap = new Map([
      [idle.sessionId!, status("idle")],
      [busy.sessionId!, status("error")],
    ]);
    const grouped = deriveWorkspaceTerminals(slice(layouts, "l1"), [wsAlpha], statusMap);
    expect(grouped.get("ws-1")?.map((row) => row.tabId)).toEqual([idle.id, busy.id]);
  });
});

describe("severityRank", () => {
  it("orders error before waitingInput before busy before idle", () => {
    expect(severityRank("error")).toBeLessThan(severityRank("waitingInput"));
    expect(severityRank("waitingInput")).toBeLessThan(severityRank("toolRunning"));
    expect(severityRank("toolRunning")).toBeLessThan(severityRank("idle"));
    expect(severityRank(null)).toBeGreaterThan(severityRank("exited"));
  });
});
