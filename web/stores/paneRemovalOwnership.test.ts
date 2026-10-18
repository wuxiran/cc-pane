import { beforeEach, expect, it, vi } from "vitest";
import { usePanesStore } from "./usePanesStore";
import { useTerminalStatusStore } from "./useTerminalStatusStore";
import { useTerminalInputActivityStore } from "./useTerminalInputActivityStore";
import { terminalService } from "@/services/terminalService";
import { registerSessionScopedResource } from "@/lib/tabLifecycle/sessionScopedResources";
import type { Panel, Tab, TerminalPaneLeaf } from "@/types";

vi.mock("@/services/terminalService", () => ({
  killedSessions: new Set<string>(),
  terminalService: {
    detachOutput: vi.fn(), detachExit: vi.fn(), killSession: vi.fn(async () => {}),
    getAllStatus: vi.fn(async () => []),
  },
}));

const dispose = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  registerSessionScopedResource({ name: "ownership-regression", dispose });
  useTerminalStatusStore.setState({ statusMap: new Map() });
  useTerminalInputActivityStore.setState({ entries: {} });
});

function tab(sessions: string[], pinned = false): Tab {
  const leaves: TerminalPaneLeaf[] = sessions.map((sessionId) => ({
    type: "leaf", id: `leaf-${sessionId}`, sessionId, launchId: `launch-${sessionId}`,
  }));
  return {
    id: "shared-tab", title: "Shared", contentType: "terminal", projectId: "project",
    projectPath: "/fixture", pinned,
    terminalRootPane: leaves.length === 1 ? leaves[0] : {
      type: "split", id: "split", direction: "horizontal", children: leaves, sizes: [50, 50],
    },
    activeTerminalPaneId: leaves[0].id,
  };
}

function install(normal: Tab, pinned: Tab) {
  const panel = (id: string, value: Tab): Panel => ({ type: "panel", id, tabs: [value], activeTabId: value.id });
  const first = panel("p1", normal);
  usePanesStore.setState({
    rootPane: first, activePaneId: "p1", currentLayoutId: "l1", poppedOutTabs: new Set(), closedTabs: [],
    layouts: [
      { id: "l1", name: "One", kind: "normal", rootPane: first, activePaneId: "p1" },
      { id: "l2", name: "Two", kind: "normal", rootPane: panel("p2", pinned), activePaneId: "p2" },
    ],
  });
  useTerminalStatusStore.setState({ statusMap: new Map(["keep", "drop"].map((sessionId) => [
    sessionId, { sessionId, status: "idle" as const, lastOutputAt: 0, updatedAt: 0 },
  ])) });
  useTerminalInputActivityStore.getState().recordInput("keep", "idle");
}

it("keeps subscriptions and state while another pinned owner survives", async () => {
  install(tab(["keep"]), tab(["keep"], true));
  usePanesStore.getState().removeTabsInternal(["shared-tab"], "user-close");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(terminalService.killSession).not.toHaveBeenCalled();
  expect(terminalService.detachOutput).not.toHaveBeenCalled();
  expect(terminalService.detachExit).not.toHaveBeenCalled();
  expect(dispose).not.toHaveBeenCalled();
  expect(useTerminalStatusStore.getState().statusMap.has("keep")).toBe(true);
  expect(useTerminalInputActivityStore.getState().getEntry("keep")).toBeDefined();
  expect((usePanesStore.getState().layouts[1].rootPane as Panel).tabs[0].pinned).toBe(true);
});

it("still retires divergent leaves that no retained owner uses", async () => {
  install(tab(["keep", "drop"]), tab(["keep"], true));
  usePanesStore.getState().removeTabsInternal(["shared-tab"], "user-close");
  await vi.waitFor(() => expect(dispose).toHaveBeenCalledWith("drop"));
  expect(terminalService.killSession).toHaveBeenCalledExactlyOnceWith("drop", "user-close");
  expect(terminalService.detachOutput).toHaveBeenCalledExactlyOnceWith("drop");
  expect(dispose).not.toHaveBeenCalledWith("keep");
  expect(useTerminalStatusStore.getState().statusMap.has("keep")).toBe(true);
  expect(useTerminalStatusStore.getState().statusMap.has("drop")).toBe(false);
});
