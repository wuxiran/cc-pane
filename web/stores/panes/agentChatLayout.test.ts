// Agent Chat 专用固定布局契约：供给/归拢纯函数 + openAgentChat 路由 +
// 删除/跨布局移动守卫。
import { beforeEach, describe, expect, it } from "vitest";
import { usePanesStore } from "../usePanesStore";
import { collectPanels } from "@/lib/paneTree";
import { createDefaultLayout } from "./layoutLifecycle";
import { AGENT_CHAT_LAYOUT_ID, type LayoutEntry, type Tab } from "@/types";
import {
  createAgentChatLayout,
  ensureAgentChatLayout,
  enforceAgentChatLayoutPurity,
  isAgentChatLayout,
  sweepAgentChatTabsToReservedLayout,
} from "./agentChatLayout";

function tab(id: string, contentType: Tab["contentType"]): Tab {
  return {
    id,
    title: id,
    contentType,
    projectId: "",
    projectPath: "",
    sessionId: null,
  } as Tab;
}

function layoutWith(id: string, tabs: Tab[]): LayoutEntry {
  const entry = createAgentChatLayout();
  entry.id = id;
  entry.name = id;
  const panel = collectPanels(entry.rootPane)[0];
  panel.tabs = tabs;
  panel.activeTabId = tabs[0]?.id ?? panel.activeTabId;
  return entry;
}

describe("ensureAgentChatLayout", () => {
  it("缺失即供给，重复调用幂等", () => {
    const layouts: LayoutEntry[] = [layoutWith("a", [])];
    ensureAgentChatLayout(layouts);
    ensureAgentChatLayout(layouts);
    expect(layouts.filter(isAgentChatLayout)).toHaveLength(1);
  });
});

describe("sweepAgentChatTabsToReservedLayout", () => {
  it("把散落的 agent 标签搬进专用布局，源面板活跃标签落到剩余首个", () => {
    const reserved = createAgentChatLayout();
    const other = layoutWith("other", [tab("t1", "terminal"), tab("a1", "agent-chat")]);
    other.rootPane = other.rootPane;
    const panel = collectPanels(other.rootPane)[0];
    panel.activeTabId = "a1";
    const layouts = [other, reserved];

    expect(sweepAgentChatTabsToReservedLayout(layouts)).toBe(1);

    const movedTo = collectPanels(reserved.rootPane)[0];
    expect(movedTo.tabs.map((t) => t.id)).toContain("a1");
    expect(collectPanels(other.rootPane)[0].tabs.map((t) => t.id)).toEqual(["t1"]);
    expect(collectPanels(other.rootPane)[0].activeTabId).toBe("t1");
  });

  it("幂等：二次归拢返回 0", () => {
    const layouts = [layoutWith("other", [tab("a1", "agent-chat")]), createAgentChatLayout()];
    sweepAgentChatTabsToReservedLayout(layouts);
    expect(sweepAgentChatTabsToReservedLayout(layouts)).toBe(0);
  });
});

describe("openAgentChat 路由", () => {
  beforeEach(() => {
    const state = usePanesStore.getState();
    const normal = state.layouts.find(
      (layout) => layout.id !== AGENT_CHAT_LAYOUT_ID && layout.kind !== "starred",
    );
    if (normal) state.switchLayout(normal.id);
  });

  it("无论当前在哪个布局，都开进专用布局并切过去", () => {
    const normalId = usePanesStore.getState().currentLayoutId;
    const tabId = usePanesStore.getState().openAgentChat("C:/proj");
    expect(tabId).not.toBeNull();
    const state = usePanesStore.getState();
    expect(state.currentLayoutId).toBe(AGENT_CHAT_LAYOUT_ID);
    // 工作副本（画面渲染真源）里必须有——immer 分叉回归锁。
    expect(
      collectPanels(state.rootPane).some((panel) => panel.tabs.some((t) => t.id === tabId)),
    ).toBe(true);
    // 切出时工作副本写回专用布局条目（switch 的 sync 口径）。
    usePanesStore.getState().switchLayout(normalId);
    const reservedAfter = usePanesStore.getState().layouts.find(isAgentChatLayout);
    expect(
      collectPanels(reservedAfter!.rootPane).some((panel) =>
        panel.tabs.some((t) => t.id === tabId),
      ),
    ).toBe(true);
  });
});

describe("专用布局守卫", () => {
  it("deleteLayout 对专用布局 no-op", () => {
    usePanesStore.getState().deleteLayout(AGENT_CHAT_LAYOUT_ID);
    expect(
      usePanesStore.getState().layouts.some((layout) => layout.id === AGENT_CHAT_LAYOUT_ID),
    ).toBe(true);
  });

  it("agent 标签移不出专用布局，其他标签移不进来", () => {
    const agentId = "guard-agent";
    const terminalId = "guard-term";
    // 自包含播种：整体重置 layouts，避免跨用例的工作副本别名干扰。
    usePanesStore.setState((state) => {
      const reserved = createAgentChatLayout();
      const normal = createDefaultLayout("guard-normal");
      collectPanels(reserved.rootPane)[0].tabs = [tab(agentId, "agent-chat")];
      collectPanels(normal.rootPane)[0].tabs = [tab(terminalId, "terminal")];
      state.layouts = [normal, reserved];
      state.currentLayoutId = normal.id;
      state.rootPane = normal.rootPane;
      state.activePaneId = collectPanels(normal.rootPane)[0].id;
    });
    const seeded = usePanesStore.getState();
    const reservedPanel = collectPanels(
      seeded.layouts.find(isAgentChatLayout)!.rootPane,
    )[0];
    const normalLayout = seeded.layouts.find((layout) => layout.id !== AGENT_CHAT_LAYOUT_ID)!;
    const normalPanel = collectPanels(normalLayout.rootPane)[0];

    const s = usePanesStore.getState();
    s.moveTabToLayoutPane(reservedPanel.id, normalLayout.id, agentId, normalPanel.id);
    s.moveTabToLayoutPane(normalPanel.id, AGENT_CHAT_LAYOUT_ID, terminalId, reservedPanel.id);

    const after = usePanesStore.getState();
    const reservedAfter = collectPanels(
      after.layouts.find(isAgentChatLayout)!.rootPane,
    )[0];
    const normalAfter = collectPanels(
      after.layouts.find((layout) => layout.id === normalLayout.id)!.rootPane,
    )[0];
    expect(reservedAfter.tabs.map((t) => t.id)).toEqual([agentId]);
    expect(normalAfter.tabs.map((t) => t.id)).toEqual([terminalId]);
  });
});

describe("addTab 守卫", () => {
  it("终端标签不进专用布局：回退第一个普通布局", () => {
    usePanesStore.getState().switchLayout(AGENT_CHAT_LAYOUT_ID);
    const reservedTabsBefore = collectPanels(
      usePanesStore.getState().layouts.find(isAgentChatLayout)!.rootPane,
    ).flatMap((panel) => panel.tabs);

    usePanesStore
      .getState()
      .addTab("nonexistent-pane", { projectId: "p", projectPath: "C:/x" } as never);

    const state = usePanesStore.getState();
    const reserved = state.layouts.find(isAgentChatLayout)!;
    const reservedTabsAfter = collectPanels(reserved.rootPane).flatMap((panel) => panel.tabs);
    expect(reservedTabsAfter).toHaveLength(reservedTabsBefore.length);
    expect(reservedTabsAfter.some((tab) => tab.contentType === "terminal")).toBe(false);
    const normal = state.layouts.find(
      (layout) => layout.id !== AGENT_CHAT_LAYOUT_ID && layout.kind !== "starred",
    )!;
    expect(
      collectPanels(normal.rootPane).some((panel) =>
        panel.tabs.some((tab) => tab.contentType === "terminal"),
      ),
    ).toBe(true);
  });
});

describe("enforceAgentChatLayoutPurity", () => {
  function makeState() {
    const reserved = createAgentChatLayout();
    const cli = createAgentChatLayout();
    cli.id = "cli-1";
    cli.name = "cli";
    return { reserved, cli };
  }

  it("混入的终端标签搬去 CLI 布局，原面板补新 agent 标签", () => {
    const { reserved, cli } = makeState();
    const panel = collectPanels(reserved.rootPane)[0];
    panel.tabs = [
      { id: "intruder", title: "t", contentType: "terminal", projectId: "", projectPath: "", sessionId: null } as never,
    ];
    panel.activeTabId = "intruder";
    const state = { layouts: [cli, reserved], currentLayoutId: reserved.id, rootPane: reserved.rootPane };

    enforceAgentChatLayoutPurity(state);

    const after = collectPanels(reserved.rootPane)[0];
    expect(after.tabs).toHaveLength(1);
    expect(after.tabs[0].contentType).toBe("agent-chat");
    expect(collectPanels(cli.rootPane)[0].tabs.map((t) => t.id)).toContain("intruder");
  });

  it("空面板补一个新 agent 标签（永不空白）", () => {
    const { reserved, cli } = makeState();
    collectPanels(reserved.rootPane)[0].tabs = [];
    const state = { layouts: [cli, reserved], currentLayoutId: reserved.id, rootPane: reserved.rootPane };

    enforceAgentChatLayoutPurity(state);

    const after = collectPanels(reserved.rootPane)[0];
    expect(after.tabs).toHaveLength(1);
    expect(after.tabs[0].contentType).toBe("agent-chat");
    expect(after.activeTabId).toBe(after.tabs[0].id);
  });
});
