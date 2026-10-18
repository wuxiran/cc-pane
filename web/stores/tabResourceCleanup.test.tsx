import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useTabResourceBadgeWiring } from "@/hooks/useTabResourceBadgeWiring";
import { usePanesStore } from "./usePanesStore";
import { useTerminalStatusStore } from "./useTerminalStatusStore";
import { useTabResourceBadgeStore } from "./useTabResourceBadgeStore";
import type { Panel, Tab } from "@/types";

vi.mock("@/services/terminalService", () => ({
  killedSessions: new Set<string>(),
  terminalService: {
    detachOutput: vi.fn(), detachExit: vi.fn(), killSession: vi.fn(async () => {}),
    getAllStatus: vi.fn(async () => []),
  },
}));

it("cleans a non-expiring job-memory badge when its owner leaves the tree", async () => {
  const tab: Tab = {
    id: "memory-tab", contentType: "terminal", title: "Memory", projectId: "project", projectPath: "/fixture",
    sessionId: "memory-session", terminalRootPane: { type: "leaf", id: "leaf", sessionId: "memory-session" },
  };
  const panel: Panel = { type: "panel", id: "panel", tabs: [tab], activeTabId: tab.id };
  usePanesStore.setState({
    rootPane: panel, activePaneId: panel.id, currentLayoutId: "layout", poppedOutTabs: new Set(), closedTabs: [],
    layouts: [{ id: "layout", name: "One", kind: "normal", rootPane: panel, activePaneId: panel.id }],
  });
  useTerminalStatusStore.setState({ statusMap: new Map() });
  const hook = renderHook(() => useTabResourceBadgeWiring());
  act(() => {
    useTerminalStatusStore.setState({ statusMap: new Map([["memory-session", {
      sessionId: "memory-session", status: "idle", lastOutputAt: 0, updatedAt: 0,
      jobMemoryWarning: { bytes: 100, limitBytes: 50, at: 1 },
    }]]) });
  });
  expect(useTabResourceBadgeStore.getState().getResourceBadge(tab.id)?.reason).toBe("job-memory");
  act(() => usePanesStore.getState().removeTabsInternal([tab.id], "user-close"));
  await waitFor(() => expect(useTerminalStatusStore.getState().statusMap.has("memory-session")).toBe(false));
  expect(usePanesStore.getState().findTabBySessionAcrossLayouts("memory-session")).toBeNull();
  expect(useTabResourceBadgeStore.getState().hasResourceBadge(tab.id)).toBe(false);
  hook.unmount();
});
