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

  it("preserves the preallocated identity of a successfully forked backend chat", () => {
    const id = usePanesStore.getState().openAgentChat("/fork", { tabId: "fork-child-id", parentTabId: "fork-parent", forkReviewId: "review-1" });
    expect(id).toBe("fork-child-id");
    const child = collectPanels(usePanesStore.getState().rootPane).flatMap((panel) => panel.tabs).find((tab) => tab.id === id);
    expect(child?.projectPath).toBe("/fork");
    expect(child?.parentTabId).toBe("fork-parent");
    expect(child?.forkReviewId).toBe("review-1");
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

  it("只剩一套用户布局时即使有 Agent Chat 也不让删", () => {
    const userLayout = usePanesStore.getState().layouts.find(
      (layout) => layout.id !== AGENT_CHAT_LAYOUT_ID && layout.kind !== "starred",
    );
    expect(userLayout).toBeDefined();
    usePanesStore.getState().deleteLayout(userLayout!.id);
    expect(
      usePanesStore.getState().layouts.some((layout) => layout.id === userLayout!.id),
    ).toBe(true);
  });

  it("agent 标签留在专用布局，终端可移入混合工作台", () => {
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
    expect(reservedAfter.tabs.map((t) => t.id)).toEqual([agentId, terminalId]);
    expect(normalAfter.tabs.map((t) => t.id)).toEqual([]);
  });
});

describe("addTab mixed workbench", () => {
  it("keeps terminals in the explicitly selected Agent workspace", () => {
    usePanesStore.getState().switchLayout(AGENT_CHAT_LAYOUT_ID);
    const paneId = usePanesStore.getState().activePaneId;
    usePanesStore.getState().addTab(paneId, { projectId: "p", projectPath: "/repo" });
    expect(collectPanels(usePanesStore.getState().rootPane).flatMap((pane) => pane.tabs)
      .some((item) => item.contentType === "terminal")).toBe(true);
    usePanesStore.getState().switchLayout(usePanesStore.getState().layouts.find((layout) => layout.id !== AGENT_CHAT_LAYOUT_ID)!.id);
    usePanesStore.getState().switchLayout(AGENT_CHAT_LAYOUT_ID);
    expect(collectPanels(usePanesStore.getState().rootPane).flatMap((pane) => pane.tabs)
      .some((item) => item.contentType === "terminal")).toBe(true);
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

  it("保留终端并补一个对话入口，焦点保持在原标签", () => {
    const { reserved, cli } = makeState();
    const panel = collectPanels(reserved.rootPane)[0];
    panel.tabs = [
      { id: "intruder", title: "t", contentType: "terminal", projectId: "", projectPath: "", sessionId: null } as never,
    ];
    panel.activeTabId = "intruder";
    const state = { layouts: [cli, reserved], currentLayoutId: reserved.id, rootPane: reserved.rootPane };

    enforceAgentChatLayoutPurity(state);

    const after = collectPanels(reserved.rootPane)[0];
    expect(after.tabs.map((item) => item.contentType)).toEqual(["terminal", "agent-chat"]);
    expect(after.activeTabId).toBe("intruder");
    expect(collectPanels(cli.rootPane)[0].tabs.map((t) => t.id)).not.toContain("intruder");
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

  it("keeps web, terminal, review and documents in the chat workbench", () => {
    const { reserved, cli } = makeState();
    collectPanels(cli.rootPane)[0].tabs = [];
    const panel = collectPanels(reserved.rootPane)[0];
    const allowed = ["agent-chat", "editor", "file-explorer", "skill-manager", "mcp-config", "terminal", "browser", "review"] as const;
    const rejected = ["dsh"] as const;
    panel.tabs = [...allowed, ...rejected].map((type) => tab(type, type));
    panel.activeTabId = "editor";
    const state = { layouts: [cli, reserved], currentLayoutId: reserved.id, rootPane: reserved.rootPane };
    enforceAgentChatLayoutPurity(state);
    expect(panel.tabs.map((item) => item.contentType)).toEqual(allowed);
    expect(panel.activeTabId).toBe("editor");
    expect(collectPanels(cli.rootPane)[0].tabs.map((item) => item.contentType)).toEqual(rejected);
    enforceAgentChatLayoutPurity(state);
    expect(panel.tabs).toHaveLength(allowed.length);
  });

  it("replenishes the last chat without closing or stealing focus from an open preview", () => {
    const { reserved, cli } = makeState();
    const panel = collectPanels(reserved.rootPane)[0];
    panel.tabs = [tab("image-preview", "editor")];
    panel.activeTabId = "image-preview";
    const state = { layouts: [cli, reserved], currentLayoutId: reserved.id, rootPane: reserved.rootPane };
    enforceAgentChatLayoutPurity(state);
    expect(panel.tabs.map((item) => item.contentType)).toEqual(["editor", "agent-chat"]);
    expect(panel.activeTabId).toBe("image-preview");
  });
});
