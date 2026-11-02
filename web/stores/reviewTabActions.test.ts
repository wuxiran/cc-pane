import { beforeEach, describe, expect, it } from "vitest";
import { collectPanels, createPanel } from "@/lib/paneTree";
import { AGENT_CHAT_LAYOUT_ID } from "@/types";
import { usePanesStore } from "./usePanesStore";
import { createAgentChatLayout } from "./panes/agentChatLayout";

beforeEach(() => {
  const panel = createPanel();
  const agent = createAgentChatLayout();
  usePanesStore.setState({ rootPane: panel, activePaneId: panel.id, currentLayoutId: "cli", closedTabs: [],
    layouts: [{ id: "cli", name: "CLI", rootPane: panel, activePaneId: panel.id }, agent] });
});

describe("review workbench tabs", () => {
  it("reuses the same source but keeps CLI and Agent review identities separate", () => {
    const store = usePanesStore.getState();
    const workspace = store.openReviewTab("/repo");
    expect(store.openReviewTab("/repo")).toBe(workspace);
    const cli = store.openReviewTab("/repo", { checkpointChatId: "cli:pty", cliSessionId: "pty" });
    const agent = store.openReviewTab("/repo", { checkpointChatId: "chat" });
    expect(new Set([workspace, cli, agent]).size).toBe(3);
    expect(store.openReviewTab("")).toBeNull();
  });

  it("places a review in the requested pane without changing another layout's view", () => {
    const store = usePanesStore.getState();
    const reserved = store.layouts.find((layout) => layout.id === AGENT_CHAT_LAYOUT_ID)!;
    const id = store.openReviewTab("/repo/worktree", { layoutId: reserved.id, paneId: reserved.activePaneId, checkpointChatId: "chat" });
    const after = usePanesStore.getState();
    expect(after.currentLayoutId).toBe("cli");
    const pane = collectPanels(after.layouts.find((layout) => layout.id === reserved.id)!.rootPane)[0];
    expect(pane.activeTabId).toBe(id);
    expect(pane.tabs.find((tab) => tab.id === id)).toMatchObject({ contentType: "review", projectPath: "/repo/worktree", reviewChatId: "chat" });
  });

  it("persists a mixed Agent workbench without migrating pages or stopping the terminal", () => {
    const store = usePanesStore.getState();
    store.switchLayout(AGENT_CHAT_LAYOUT_ID);
    const paneId = usePanesStore.getState().activePaneId;
    store.addTab(paneId, { projectId: "", projectPath: "/repo", cliTool: "none" });
    store.openBrowser("https://example.com", undefined, "browser", { paneId });
    const reviewId = store.openReviewTab("/repo", { paneId, checkpointChatId: "chat" });
    const current = usePanesStore.getState();
    const snapshot = JSON.parse(JSON.stringify(current.exportLayoutSnapshotPayload()));
    const restored = usePanesStore.persist.getOptions().merge!(snapshot, current);
    const tabs = collectPanels(restored.rootPane).flatMap((panel) => panel.tabs);
    expect(tabs.map((tab) => tab.contentType)).toEqual(expect.arrayContaining(["terminal", "browser", "review", "agent-chat"]));
    expect(tabs.find((tab) => tab.id === reviewId)?.reviewChatId).toBe("chat");
    expect(tabs.find((tab) => tab.id === "browser")?.browserUrl).toBe("https://example.com");
  });
});
