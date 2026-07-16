import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runBackgroundLayoutRestore,
  useTerminalResumeIdBridge,
} from "./useTerminalSessionRestore";
import { usePanesStore, useTerminalStatusStore } from "@/stores";
import { terminalService } from "@/services";
import { listenIfTauri } from "@/services/runtime";

vi.mock("@/stores", () => ({
  usePanesStore: { getState: vi.fn() },
  useTerminalStatusStore: { getState: vi.fn() },
}));

vi.mock("@/services", () => ({
  terminalService: { createSession: vi.fn() },
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
  };
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

  it("只恢复非当前布局、无会话的终端 tab", async () => {
    const entries: RestorableEntry[] = [
      { tab: { id: "t1", contentType: "terminal", projectPath: "/p1" }, layoutId: "other" },
      { tab: { id: "t2", contentType: "terminal", projectPath: "/p2" }, layoutId: "current" },
      { tab: { id: "t3", contentType: "terminal", projectPath: "/p3", sessionId: "live" }, layoutId: "other" },
    ];
    const setBackgroundRestoreSession = vi.fn();
    mockPanesState({
      currentLayoutId: "current",
      getRestorableTabs: () => entries,
      setBackgroundRestoreSession,
    });
    vi.mocked(terminalService.createSession).mockResolvedValue("new-session");

    await runBackgroundLayoutRestore();
    await vi.waitFor(() => {
      expect(setBackgroundRestoreSession).toHaveBeenCalledWith("t1", "new-session");
    });

    expect(terminalService.createSession).toHaveBeenCalledTimes(1);
    expect(markSessionLive).toHaveBeenCalledWith("new-session");
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
    };
    vi.mocked(usePanesStore.getState)
      .mockReturnValueOnce(scheduleState as never)
      .mockReturnValue(dequeueState as never);

    await runBackgroundLayoutRestore();
    await Promise.resolve();

    expect(terminalService.createSession).not.toHaveBeenCalled();
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
