import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  reconcileTerminalSessions,
  runBackgroundLayoutRestore,
  useTerminalResumeIdBridge,
} from "./useTerminalSessionRestore";
import { usePanesStore, useTerminalStatusStore } from "@/stores";
import { sessionRestoreService, terminalService } from "@/services";
import { listenIfTauri } from "@/services/runtime";

vi.mock("@/stores", () => ({
  usePanesStore: { getState: vi.fn() },
  useTerminalStatusStore: { getState: vi.fn() },
}));

vi.mock("@/services", () => ({
  terminalService: {
    createSession: vi.fn(),
    killSession: vi.fn(),
    getAdoptionSnapshot: vi.fn(),
    adoptSession: vi.fn(),
    releaseSession: vi.fn(),
  },
  sessionRestoreService: {
    load: vi.fn(),
    prune: vi.fn(),
  },
}));

// 队列直通执行，聚焦被测逻辑本身
vi.mock("@/components/panes/terminalRestoreQueue", () => ({
  terminalRestoreLaunchQueue: {
    run: (task: () => Promise<unknown>) => task(),
  },
}));

vi.mock("@/services/runtime", () => ({
  listenIfTauri: vi.fn(),
}));

type RestorableEntry = {
  tab: {
    id: string;
    contentType: string;
    projectPath: string;
    projectId?: string;
    sessionId?: string;
    cliTool?: string;
    terminalRootPane?: unknown;
  };
  paneId?: string;
  layoutId: string;
};

function mockPanesState(overrides: Record<string, unknown>) {
  vi.mocked(usePanesStore.getState).mockReturnValue(overrides as never);
}

describe("runBackgroundLayoutRestore", () => {
  const markSessionLive = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useTerminalStatusStore.getState).mockReturnValue({
      markSessionLive,
    } as never);
  });

  it("逐 leaf 恢复非当前布局中所有未阻断的终端", async () => {
    const entries: RestorableEntry[] = [
      {
        tab: {
          id: "t1",
          contentType: "terminal",
          projectPath: "/p1",
          terminalRootPane: {
            type: "split",
            id: "split-1",
            direction: "horizontal",
            sizes: [50, 50],
            children: [
              { type: "leaf", id: "leaf-a", sessionId: null, cliTool: "claude" },
              { type: "leaf", id: "leaf-b", sessionId: null, cliTool: "codex" },
              {
                type: "leaf",
                id: "leaf-blocked",
                sessionId: null,
                restoreBlockedReason: "claim-conflict",
              },
            ],
          },
        },
        layoutId: "other",
      },
      {
        tab: {
          id: "t2",
          contentType: "terminal",
          projectPath: "/p2",
          terminalRootPane: { type: "leaf", id: "leaf-current", sessionId: null },
        },
        layoutId: "current",
      },
      { tab: { id: "t3", contentType: "terminal", projectPath: "/p3", sessionId: "live" }, layoutId: "other" },
    ];
    const setBackgroundRestoreSession = vi.fn();
    mockPanesState({
      currentLayoutId: "current",
      getRestorableTabs: () => entries,
      setBackgroundRestoreSession,
      canCreateTerminalSession: () => true,
    });
    vi.mocked(terminalService.createSession)
      .mockResolvedValueOnce("new-session-a")
      .mockResolvedValueOnce("new-session-b");

    await runBackgroundLayoutRestore();
    await vi.waitFor(() => {
      expect(setBackgroundRestoreSession).toHaveBeenCalledWith("t1", "leaf-a", "new-session-a");
      expect(setBackgroundRestoreSession).toHaveBeenCalledWith("t1", "leaf-b", "new-session-b");
    });

    expect(terminalService.createSession).toHaveBeenCalledTimes(2);
    expect(markSessionLive).toHaveBeenCalledWith("new-session-a");
    expect(markSessionLive).toHaveBeenCalledWith("new-session-b");
  });

  it("出队重检：期间已恢复或布局已变当前时跳过，不重复建会话", async () => {
    const entries: RestorableEntry[] = [
      { tab: { id: "t1", contentType: "terminal", projectPath: "/p1" }, layoutId: "other" },
    ];
    // 首次调度时可恢复；出队重检时该 tab 已拿到 sessionId（前台已恢复）
    const scheduleState = {
      currentLayoutId: "current",
      getRestorableTabs: () => entries,
    };
    const dequeueState = {
      currentLayoutId: "current",
      getRestorableTabs: () => [
        { tab: { ...entries[0].tab, sessionId: "restored-elsewhere" }, layoutId: "other" },
      ],
      setBackgroundRestoreSession: vi.fn(),
      canCreateTerminalSession: () => false,
    };
    vi.mocked(usePanesStore.getState)
      .mockReturnValueOnce(scheduleState as never)
      .mockReturnValue(dequeueState as never);

    await runBackgroundLayoutRestore();
    await Promise.resolve();

    expect(terminalService.createSession).not.toHaveBeenCalled();
  });
});

describe("reconcileTerminalSessions", () => {
  const setTerminalRestoreBlocked = vi.fn();
  const setSessionLeaseReadOnly = vi.fn();
  const attachSessionToAnchor = vi.fn();
  const replaceLiveStatuses = vi.fn();

  const leaf = {
    type: "leaf",
    id: "leaf-1",
    sessionId: null,
    restoring: true,
    savedSessionId: "session-1",
    cliTool: "claude",
  };
  const entries = [{
    layoutId: "layout-1",
    paneId: "pane-1",
    tab: {
      id: "tab-1",
      contentType: "terminal",
      projectPath: "/mnt/d/work/project",
      cliTool: "claude",
      terminalRootPane: leaf,
    },
  }];
  const provenance = {
    sessionId: "session-1",
    daemonGeneration: 42,
    birthNonce: "birth-1",
    originInstanceId: "app-a",
    originLayoutId: "layout-1",
    originTabId: "tab-1",
    originTerminalPaneId: "leaf-1",
    projectPath: "D:\\work\\project",
    runtimeKind: "local",
    cliTool: "claude",
    resumeId: "resume-1",
    createdAtMs: 1,
  };
  const saved = {
    sessionId: "session-1",
    tabId: "tab-1",
    paneId: "pane-1",
    terminalPaneId: "leaf-1",
    layoutId: "layout-1",
    projectPath: "D:\\work\\project",
    cliTool: "claude",
    runtimeKind: "local",
    resumeId: "resume-1",
    daemonGeneration: 42,
    birthNonce: "birth-1",
    originLayoutId: "layout-1",
    originTabId: "tab-1",
    originTerminalPaneId: "leaf-1",
    createdAt: "",
    savedAt: "",
    hasOutput: false,
  };

  function snapshot(overrides: Record<string, unknown> = {}) {
    return {
      claimsSupported: true,
      daemonGeneration: 42,
      ownerInstanceId: "app-b",
      capturedAtMs: Date.now(),
      complete: true,
      sessions: [{ sessionId: "session-1", status: "idle", lastOutputAt: 1, updatedAt: 1 }],
      claims: {},
      provenance: { "session-1": provenance },
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockPanesState({
      getRestorableTabs: () => entries,
      setTerminalRestoreBlocked,
      setSessionLeaseReadOnly,
      attachSessionToAnchor,
    });
    vi.mocked(useTerminalStatusStore.getState).mockReturnValue({ replaceLiveStatuses } as never);
    vi.mocked(terminalService.getAdoptionSnapshot).mockResolvedValue(snapshot() as never);
    vi.mocked(terminalService.adoptSession).mockResolvedValue(true);
    vi.mocked(terminalService.releaseSession).mockResolvedValue(undefined);
    vi.mocked(sessionRestoreService.load).mockResolvedValue([saved] as never);
    vi.mocked(sessionRestoreService.prune).mockResolvedValue(0);
    attachSessionToAnchor.mockReturnValue(true);
  });

  it("完整出生证据唯一匹配且 claim 成功后才挂载 leaf", async () => {
    const report = await reconcileTerminalSessions({ autoAdopt: true });

    expect(terminalService.adoptSession).toHaveBeenCalledWith("session-1");
    expect(attachSessionToAnchor).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      layoutId: "layout-1",
      tabId: "tab-1",
      terminalPaneId: "leaf-1",
    }));
    expect(terminalService.releaseSession).not.toHaveBeenCalled();
    expect(setSessionLeaseReadOnly).toHaveBeenCalledWith("session-1", false);
    expect(report.attached).toBe(1);
  });

  it("claim 成功但 leaf 挂载失败时立即 release", async () => {
    attachSessionToAnchor.mockReturnValue(false);

    await reconcileTerminalSessions({ autoAdopt: true });

    expect(terminalService.releaseSession).toHaveBeenCalledWith("session-1");
  });

  it("同一锚点存在多个活候选时优先选择 savedSessionId 唯一指向的候选", async () => {
    const secondProvenance = {
      ...provenance,
      sessionId: "session-2",
      birthNonce: "birth-2",
    };
    vi.mocked(terminalService.getAdoptionSnapshot).mockResolvedValue(snapshot({
      sessions: [
        { sessionId: "session-1", status: "idle", lastOutputAt: 1, updatedAt: 1 },
        { sessionId: "session-2", status: "idle", lastOutputAt: 1, updatedAt: 1 },
      ],
      provenance: { "session-1": provenance, "session-2": secondProvenance },
    }) as never);
    vi.mocked(sessionRestoreService.load).mockResolvedValue([
      saved,
      { ...saved, sessionId: "session-2", birthNonce: "birth-2" },
    ] as never);

    await reconcileTerminalSessions({ autoAdopt: true });

    expect(terminalService.adoptSession).toHaveBeenCalledWith("session-1");
    expect(attachSessionToAnchor).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
    }));
    expect(setTerminalRestoreBlocked).not.toHaveBeenCalledWith(
      "tab-1",
      "leaf-1",
      "ambiguous-candidates",
    );
  });

  it("同一锚点存在多个活候选且没有唯一 savedSessionId 时仍阻断", async () => {
    const secondProvenance = {
      ...provenance,
      sessionId: "session-2",
      birthNonce: "birth-2",
    };
    const ambiguousEntries = [{
      ...entries[0],
      tab: {
        ...entries[0].tab,
        terminalRootPane: { ...leaf, savedSessionId: "unrelated-session" },
      },
    }];
    mockPanesState({
      getRestorableTabs: () => ambiguousEntries,
      setTerminalRestoreBlocked,
      setSessionLeaseReadOnly,
      attachSessionToAnchor,
    });
    vi.mocked(terminalService.getAdoptionSnapshot).mockResolvedValue(snapshot({
      sessions: [
        { sessionId: "session-1", status: "idle", lastOutputAt: 1, updatedAt: 1 },
        { sessionId: "session-2", status: "idle", lastOutputAt: 1, updatedAt: 1 },
      ],
      provenance: { "session-1": provenance, "session-2": secondProvenance },
    }) as never);
    vi.mocked(sessionRestoreService.load).mockResolvedValue([
      saved,
      { ...saved, sessionId: "session-2", birthNonce: "birth-2" },
    ] as never);

    await reconcileTerminalSessions({ autoAdopt: true });

    expect(setTerminalRestoreBlocked).toHaveBeenCalledWith(
      "tab-1",
      "leaf-1",
      "ambiguous-candidates",
    );
    expect(terminalService.adoptSession).not.toHaveBeenCalled();
  });

  it("跨布局移动后当前锚点与 daemon 出生锚点不同仍可安全挂载", async () => {
    const movedSaved = {
      ...saved,
      layoutId: "layout-current",
      tabId: "tab-current",
      terminalPaneId: "leaf-current",
      paneId: "pane-current",
    };
    const movedEntries = [{
      layoutId: "layout-current",
      paneId: "pane-current",
      tab: {
        ...entries[0].tab,
        id: "tab-current",
        terminalRootPane: { ...leaf, id: "leaf-current" },
      },
    }];
    mockPanesState({
      getRestorableTabs: () => movedEntries,
      setTerminalRestoreBlocked,
      setSessionLeaseReadOnly,
      attachSessionToAnchor,
    });
    vi.mocked(sessionRestoreService.load).mockResolvedValue([movedSaved] as never);

    const report = await reconcileTerminalSessions({ autoAdopt: true });

    expect(report.attached).toBe(1);
    expect(attachSessionToAnchor).toHaveBeenCalledWith(expect.objectContaining({
      layoutId: "layout-current",
      tabId: "tab-current",
      terminalPaneId: "leaf-current",
    }));
  });

  it("daemon 不支持 claim 时 fail-closed 阻断待恢复 leaf", async () => {
    vi.mocked(terminalService.getAdoptionSnapshot).mockResolvedValue(snapshot({
      claimsSupported: false,
      daemonGeneration: undefined,
    }) as never);

    await reconcileTerminalSessions({ autoAdopt: true });

    expect(setTerminalRestoreBlocked).toHaveBeenCalledWith(
      "tab-1",
      "leaf-1",
      "claims-unsupported",
    );
    expect(sessionRestoreService.load).not.toHaveBeenCalled();
  });

  it("默认关闭自动认领时保留会话并阻断重建", async () => {
    await reconcileTerminalSessions({ autoAdopt: false });

    expect(setTerminalRestoreBlocked).toHaveBeenCalledWith(
      "tab-1",
      "leaf-1",
      "auto-adopt-disabled",
    );
    expect(terminalService.adoptSession).not.toHaveBeenCalled();
  });
});

describe("useTerminalResumeIdBridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(updateResults: boolean[]) {
    let handler: ((event: { payload: unknown }) => void) | undefined;
    const unlisten = vi.fn();
    vi.mocked(listenIfTauri).mockImplementation(async (_event, cb) => {
      handler = cb as typeof handler;
      return unlisten;
    });
    const updateTabAgentResumeId = vi.fn();
    for (const result of updateResults) {
      updateTabAgentResumeId.mockReturnValueOnce(result);
    }
    mockPanesState({ updateTabAgentResumeId });
    return {
      getHandler: () => handler,
      unlisten,
      updateTabAgentResumeId,
    };
  }

  it("收到绑定事件立即回写 resumeId 并广播 history-updated", async () => {
    const { getHandler, updateTabAgentResumeId } = setup([true]);
    const dispatched = vi.fn();
    window.addEventListener("cc-panes:history-updated", dispatched);

    const { unmount } = renderHook(() => useTerminalResumeIdBridge());
    await vi.waitFor(() => expect(getHandler()).toBeDefined());

    getHandler()!({
      payload: { ptySessionId: "pty-1", resumeSessionId: "resume-1", resumeSource: "hook" },
    });

    expect(updateTabAgentResumeId).toHaveBeenCalledWith("pty-1", "resume-1", "hook");
    expect(dispatched).toHaveBeenCalledTimes(1);
    window.removeEventListener("cc-panes:history-updated", dispatched);
    unmount();
  });

  it("tab 未命中时带退避重试，重试成功仍回写", async () => {
    // 前两次未命中（tab.sessionId 尚未写入），第三次命中
    const { getHandler, updateTabAgentResumeId } = setup([false, false, true]);

    const { unmount } = renderHook(() => useTerminalResumeIdBridge());
    await vi.waitFor(() => expect(getHandler()).toBeDefined());

    getHandler()!({
      payload: { ptySessionId: "pty-1", resumeSessionId: "resume-1" },
    });
    expect(updateTabAgentResumeId).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(updateTabAgentResumeId).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(updateTabAgentResumeId).toHaveBeenCalledTimes(3);

    // 已命中，不再重试
    await vi.advanceTimersByTimeAsync(10_000);
    expect(updateTabAgentResumeId).toHaveBeenCalledTimes(3);
    unmount();
  });

  it("卸载后不再重试回写", async () => {
    const { getHandler, unlisten, updateTabAgentResumeId } = setup([false, false]);

    const { unmount } = renderHook(() => useTerminalResumeIdBridge());
    await vi.waitFor(() => expect(getHandler()).toBeDefined());

    getHandler()!({
      payload: { ptySessionId: "pty-1", resumeSessionId: "resume-1" },
    });
    expect(updateTabAgentResumeId).toHaveBeenCalledTimes(1);

    unmount();
    expect(unlisten).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(updateTabAgentResumeId).toHaveBeenCalledTimes(1);
  });
});
