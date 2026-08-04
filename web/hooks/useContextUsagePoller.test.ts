import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Panel } from "@/types";
import { usePanesStore } from "@/stores";
import { usageStatsService } from "@/services/usageStatsService";
import { useContextUsageStore } from "@/stores/useContextUsageStore";
import { useContextUsagePoller } from "./useContextUsagePoller";

function setActiveSession(cliTool: string): void {
  const panel: Panel = {
    type: "panel",
    id: "panel-context",
    activeTabId: "tab-context",
    tabs: [{
      id: "tab-context",
      title: "context",
      contentType: "terminal",
      projectId: "project",
      projectPath: "C:/project",
      sessionId: "tab-session",
      activeTerminalPaneId: "leaf-context",
      terminalRootPane: {
        type: "leaf",
        id: "leaf-context",
        sessionId: "pty-session",
        cliTool,
      },
    }],
  };
  usePanesStore.setState({ rootPane: panel, activePaneId: panel.id });
}

describe("useContextUsagePoller", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useContextUsageStore.setState({
      sessionId: null,
      snapshot: null,
      lastReady: null,
      loading: false,
      requestId: 0,
    });
  });

  it("does not query shell sessions or unsupported CLIs", async () => {
    setActiveSession("none");
    const query = vi.spyOn(usageStatsService, "queryContextUsage");
    const { result, unmount } = renderHook(() => useContextUsagePoller());

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBeNull();
    expect(query).not.toHaveBeenCalled();
    unmount();
  });
});
