import { beforeEach, describe, expect, it } from "vitest";
import { collectPanels, createPanel } from "@/lib/paneTree";
import { usePanesStore } from "./usePanesStore";

beforeEach(() => {
  const cli = createPanel();
  const other = createPanel();
  usePanesStore.setState({
    rootPane: cli,
    activePaneId: cli.id,
    currentLayoutId: "cli",
    closedTabs: [],
    layouts: [
      { id: "cli", name: "CLI", kind: "normal", rootPane: cli, activePaneId: cli.id },
      { id: "other", name: "Other", kind: "normal", rootPane: other, activePaneId: other.id },
    ],
  });
});

describe("openAgentChat", () => {
  it("opens next to the terminal in the current layout's active pane without switching layouts", () => {
    const tabId = usePanesStore.getState().openAgentChat("/repo")!;
    const state = usePanesStore.getState();
    expect(state.currentLayoutId).toBe("cli");
    const panel = collectPanels(state.rootPane)[0];
    expect(panel.tabs.map((tab) => tab.contentType)).toEqual(["terminal", "agent-chat"]);
    expect(panel.activeTabId).toBe(tabId);
    expect(state.layouts.some((layout) => layout.id === "layout-agent-chat")).toBe(false);
  });

  it("honours an explicit layoutId without changing the visible layout", () => {
    const tabId = usePanesStore.getState().openAgentChat("/repo", { layoutId: "other" })!;
    const state = usePanesStore.getState();
    expect(state.currentLayoutId).toBe("cli");
    const location = state.findTabAcrossLayouts(tabId);
    expect(location?.layoutId).toBe("other");
  });

  it("lets agent-chat tabs move to any layout", () => {
    const s = usePanesStore.getState();
    const chatId = s.openAgentChat("/repo")!;
    const from = collectPanels(usePanesStore.getState().rootPane)[0];
    const target = collectPanels(usePanesStore.getState().layouts.find((layout) => layout.id === "other")!.rootPane)[0];
    usePanesStore.getState().moveTabToLayoutPane(from.id, "other", chatId, target.id);
    expect(usePanesStore.getState().findTabAcrossLayouts(chatId)?.layoutId).toBe("other");
  });
});
