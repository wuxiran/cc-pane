import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import useOrchestratorSync from "./useOrchestratorSync";
import { useOrchestratorStore, useWorkspacesStore } from "@/stores";

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
  const loadBindings = vi.fn();
  const applyChangedEvent = vi.fn();

  beforeEach(() => {
    loadBindings.mockReset().mockResolvedValue(undefined);
    applyChangedEvent.mockReset();
    vi.mocked(getCurrentWebview().listen).mockReset();
    useOrchestratorStore.setState({ loadBindings, applyChangedEvent });
    useWorkspacesStore.setState({ expandedWorkspaceId: null });
  });

  it("挂载时注册 TaskBinding 事件监听并加载一次 bindings", async () => {
    const listeners = mockWebviewListeners();
    renderHook(() => useOrchestratorSync());

    await waitFor(() => {
      expect(listeners.has("task-binding-changed")).toBe(true);
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
      expect(listeners.size).toBe(1);
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
