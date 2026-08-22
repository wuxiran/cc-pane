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
      sessions: new Map(),
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

  it("polls an explicitly supplied grid terminal session", async () => {
    const query = vi.spyOn(usageStatsService, "queryContextUsage").mockResolvedValue({
      status: "ready",
      usedTokens: 10,
      effectiveUsedTokens: 10,
      windowTokens: 100,
      effectiveWindowTokens: 100,
      usedPercentage: 10,
      remainingPercentage: 90,
      model: "claude-sonnet",
      usageSource: "test",
      windowSource: "test",
      agentSessionId: "agent-1",
      parserVersion: "test",
      observedAt: Date.now(),
      diagnosticCode: null,
    });
    const context = {
      sessionId: "pty-grid",
      cliTool: "claude",
      ssh: false,
      providerId: null,
      modelId: null,
      providerSelection: null,
      launchProfileId: null,
    };

    const { result, unmount } = renderHook(() => useContextUsagePoller(context));
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current).toBe("pty-grid");
    expect(query).toHaveBeenCalledWith("pty-grid");
    unmount();
  });

  it("polls Pi sessions when the backend exposes indexed usage", async () => {
    const query = vi.spyOn(usageStatsService, "queryContextUsage").mockResolvedValue({
      status: "ready",
      usedTokens: 10,
      effectiveUsedTokens: 10,
      windowTokens: 100,
      effectiveWindowTokens: 100,
      usedPercentage: 10,
      remainingPercentage: 90,
      model: "claude-sonnet-4-5",
      usageSource: "pi-session-file",
      windowSource: "pi-session-file",
      agentSessionId: "pi-agent-1",
      parserVersion: "pi-v1",
      observedAt: Date.now(),
      diagnosticCode: null,
    });
    const context = {
      sessionId: "pty-pi",
      cliTool: "pi",
      ssh: false,
      providerId: null,
      modelId: null,
      providerSelection: null,
      launchProfileId: null,
    };

    const { result, unmount } = renderHook(() => useContextUsagePoller(context));
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current).toBe("pty-pi");
    expect(query).toHaveBeenCalledWith("pty-pi");
    unmount();
  });
});
