import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import useOrchestratorSync from "./useOrchestratorSync";
import { useOrchestratorStore, useWorkspacesStore } from "@/stores";
import { taskBindingService } from "@/services/taskBindingService";
import type { TaskBinding } from "@/types";

type WebviewListener = (event: { payload: unknown }) => void | Promise<void>;

function mockWebviewListeners() {
  const listeners = new Map<string, WebviewListener>();
  vi.mocked(getCurrentWebview().listen).mockImplementation(async (eventName, handler) => {
    listeners.set(eventName, handler as WebviewListener);
    return () => listeners.delete(eventName);
  });
  return listeners;
}

describe("useOrchestratorSync", () => {
  const updatePatch = vi.fn();
  const loadBindings = vi.fn();
  const applyChangedEvent = vi.fn();
  const findBySession = vi.spyOn(taskBindingService, "findBySession");

  const binding = (overrides: Partial<TaskBinding> = {}): TaskBinding => ({
    id: "tb-1",
    title: "worker",
    role: "worker",
    sessionId: "s-1",
    projectPath: "/tmp/project",
    cliTool: "codex",
    status: "running",
    progress: 35,
    sortOrder: 0,
    createdAt: "2026-07-24T00:00:00Z",
    updatedAt: "2026-07-24T00:00:00Z",
    ...overrides,
  });

  beforeEach(() => {
    updatePatch.mockReset().mockResolvedValue(binding());
    findBySession.mockReset().mockResolvedValue(binding());
    loadBindings.mockReset().mockResolvedValue(undefined);
    applyChangedEvent.mockReset();
    vi.mocked(getCurrentWebview().listen).mockReset();
    useOrchestratorStore.setState({ updatePatch, loadBindings, applyChangedEvent });
    useWorkspacesStore.setState({ expandedWorkspaceId: null });
  });

  it("挂载时注册两个事件监听并加载一次 bindings", async () => {
    const listeners = mockWebviewListeners();
    renderHook(() => useOrchestratorSync());

    await waitFor(() => {
      expect(listeners.has("task-binding-changed")).toBe(true);
      expect(listeners.has("terminal-exit")).toBe(true);
    });
    expect(loadBindings).toHaveBeenCalledTimes(1);
  });

  it("task-binding-changed 事件增量应用到 store", async () => {
    const listeners = mockWebviewListeners();
    renderHook(() => useOrchestratorSync());
    await waitFor(() => expect(listeners.has("task-binding-changed")).toBe(true));

    const payload = { kind: "updated", binding: { id: "tb-1" } };
    await act(async () => {
      await listeners.get("task-binding-changed")?.({ payload });
    });

    expect(applyChangedEvent).toHaveBeenCalledWith(payload);
  });

  it("terminal-exit 退出码 0 但无 completionSummary → failed 且不伪造 progress", async () => {
    const listeners = mockWebviewListeners();
    renderHook(() => useOrchestratorSync());
    await waitFor(() => expect(listeners.has("terminal-exit")).toBe(true));

    await act(async () => {
      await listeners.get("terminal-exit")?.({ payload: { sessionId: "s-1", exitCode: 0 } });
    });

    expect(findBySession).toHaveBeenCalledWith("s-1");
    expect(updatePatch).toHaveBeenCalledWith("tb-1", {
      status: "failed",
      exitCode: 0,
    });
  });

  it("worker 已主动写 completed + completionSummary 时退出仍保留 completed", async () => {
    const listeners = mockWebviewListeners();
    findBySession.mockResolvedValue(binding({
      status: "completed",
      progress: 100,
      completionSummary: "实现与测试均完成",
    }));
    renderHook(() => useOrchestratorSync());
    await waitFor(() => expect(listeners.has("terminal-exit")).toBe(true));

    await act(async () => {
      await listeners.get("terminal-exit")?.({ payload: { sessionId: "s-1", exitCode: 0 } });
    });

    expect(updatePatch).toHaveBeenCalledWith("tb-1", {
      exitCode: 0,
    });
  });

  it("terminal-exit 缺省退出码按未知 -1 记录并标 failed", async () => {
    const listeners = mockWebviewListeners();
    findBySession.mockResolvedValue(binding({ sessionId: "s-2" }));
    renderHook(() => useOrchestratorSync());
    await waitFor(() => expect(listeners.has("terminal-exit")).toBe(true));

    await act(async () => {
      await listeners.get("terminal-exit")?.({ payload: { sessionId: "s-2" } });
    });

    expect(updatePatch).toHaveBeenCalledWith("tb-1", {
      status: "failed",
      exitCode: -1,
    });
  });

  it("terminal-exit 非零退出码 → failed，不带 progress", async () => {
    const listeners = mockWebviewListeners();
    renderHook(() => useOrchestratorSync());
    await waitFor(() => expect(listeners.has("terminal-exit")).toBe(true));

    await act(async () => {
      await listeners.get("terminal-exit")?.({ payload: { sessionId: "s-3", exitCode: 137 } });
    });

    expect(updatePatch).toHaveBeenCalledWith("tb-1", {
      status: "failed",
      exitCode: 137,
    });
  });

  it("session 未绑定 TaskBinding 时不更新", async () => {
    const listeners = mockWebviewListeners();
    findBySession.mockResolvedValue(null);
    renderHook(() => useOrchestratorSync());
    await waitFor(() => expect(listeners.has("terminal-exit")).toBe(true));

    await act(async () => {
      await listeners.get("terminal-exit")?.({ payload: { sessionId: "s-x", exitCode: 0 } });
    });
    expect(updatePatch).not.toHaveBeenCalled();
  });

  it("每 10 秒轮询兜底 loadBindings", async () => {
    mockWebviewListeners();
    vi.useFakeTimers();
    try {
      renderHook(() => useOrchestratorSync());
      const initialCalls = loadBindings.mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(loadBindings).toHaveBeenCalledTimes(initialCalls + 1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(loadBindings).toHaveBeenCalledTimes(initialCalls + 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("切换展开的工作空间时重新加载 bindings", async () => {
    mockWebviewListeners();
    renderHook(() => useOrchestratorSync());
    await waitFor(() => expect(loadBindings).toHaveBeenCalledTimes(1));

    act(() => {
      useWorkspacesStore.setState({ expandedWorkspaceId: "ws-2" });
    });
    await waitFor(() => expect(loadBindings).toHaveBeenCalledTimes(2));
  });

  it("卸载后取消监听且停止轮询", async () => {
    const listeners = mockWebviewListeners();
    vi.useFakeTimers();
    try {
      const { unmount } = renderHook(() => useOrchestratorSync());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(listeners.size).toBe(2);
      const callsBeforeUnmount = loadBindings.mock.calls.length;

      unmount();
      expect(listeners.size).toBe(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(loadBindings).toHaveBeenCalledTimes(callsBeforeUnmount);
    } finally {
      vi.useRealTimers();
    }
  });
});
