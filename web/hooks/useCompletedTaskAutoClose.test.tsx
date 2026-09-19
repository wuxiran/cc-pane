import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOrchestratorStore, usePanesStore, useSettingsStore } from "@/stores";
import { terminalService } from "@/services/terminalService";
import { taskBindingService } from "@/services/taskBindingService";
import type { Panel, TaskBinding, TerminalSessionOutput } from "@/types";
import { createTestSettings } from "@/test/utils/testData";
import useCompletedTaskAutoClose from "./useCompletedTaskAutoClose";

const binding: TaskBinding = {
  id: "task", title: "Worker", role: "worker", projectPath: "/repo", cliTool: "codex",
  sessionId: "pty", status: "completed", progress: 100, completionSummary: "Result stays here",
  sortOrder: 0, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  metadata: { ui: { autoCloseCompletedSessionId: "pty", autoCloseCompletedTabId: "tab" } },
};
const panel: Panel = { type: "panel", id: "panel", activeTabId: "tab", tabs: [{
  id: "tab", title: "Worker", contentType: "terminal", projectId: "p", projectPath: "/repo", sessionId: "pty",
}] };
let remove: ReturnType<typeof vi.fn<(tabIds: string[], reason: string) => void>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(60_000);
  remove = vi.fn<(tabIds: string[], reason: string) => void>();
  vi.spyOn(usePanesStore.getState(), "allPanelsAcrossLayouts").mockReturnValue([panel]);
  vi.spyOn(usePanesStore.getState(), "removeTabsInternal").mockImplementation(remove);
  useOrchestratorStore.setState({ bindings: [binding] });
  useSettingsStore.setState({ settings: { ...createTestSettings(),
    terminal: { ...createTestSettings().terminal, autoCloseCompletedTasks: true } } });
  vi.spyOn(terminalService, "getRecentOutput").mockResolvedValue({ sessionId: "pty", lines: ["result"], exited: true, retained: true });
  vi.spyOn(taskBindingService, "get").mockResolvedValue(binding);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

async function flush() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }

describe("auto close integration", () => {
  it("uses the no-kill pipeline and keeps binding/result for review", async () => {
    const kill = vi.spyOn(terminalService, "killSession");
    const { unmount } = renderHook(() => useCompletedTaskAutoClose());
    await flush();
    expect(remove).toHaveBeenCalledWith(["tab"], "task-completed");
    expect(kill).not.toHaveBeenCalled();
    expect(useOrchestratorStore.getState().bindings[0].completionSummary).toBe("Result stays here");
    unmount();
  });
  it.each([{}, { exited: false, retained: true }, { exited: true, retained: false }])("keeps active/unknown/unretained output %o", async (fields) => {
    vi.mocked(terminalService.getRecentOutput).mockResolvedValue({ sessionId: "pty", lines: [], ...fields });
    const { unmount } = renderHook(() => useCompletedTaskAutoClose());
    await flush();
    expect(remove).not.toHaveBeenCalled();
    unmount();
  });
  it("rechecks session identity after the asynchronous read", async () => {
    vi.mocked(taskBindingService.get).mockResolvedValue({ ...binding, sessionId: "new-live" });
    const { unmount } = renderHook(() => useCompletedTaskAutoClose());
    await flush();
    expect(remove).not.toHaveBeenCalled();
    unmount();
  });
  it("rechecks layout copies after asynchronous reads", async () => {
    vi.mocked(taskBindingService.get).mockImplementation(async () => {
      vi.mocked(usePanesStore.getState().allPanelsAcrossLayouts).mockReturnValue([{ ...panel,
        tabs: [{ ...panel.tabs[0], sessionId: "unrelated-live" }] }]);
      return binding;
    });
    const { unmount } = renderHook(() => useCompletedTaskAutoClose());
    await flush();
    expect(remove).not.toHaveBeenCalled();
    unmount();
  });
  it("continues past a failed archive read to later tasks", async () => {
    useOrchestratorStore.setState({ bindings: [{ ...binding, id: "failed-read" }, binding] });
    vi.mocked(terminalService.getRecentOutput).mockRejectedValueOnce(new Error("missing archive"));
    const { unmount } = renderHook(() => useCompletedTaskAutoClose());
    await flush();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(["tab"], "task-completed");
    unmount();
  });
  it("honors disabling the setting while output is being checked", async () => {
    let resolve!: (value: TerminalSessionOutput) => void;
    vi.mocked(terminalService.getRecentOutput).mockReturnValue(new Promise((done) => { resolve = done; }));
    const { unmount } = renderHook(() => useCompletedTaskAutoClose());
    await flush();
    act(() => useSettingsStore.setState((state) => ({ settings: { ...state.settings!,
      terminal: { ...state.settings!.terminal, autoCloseCompletedTasks: false } } })));
    resolve({ sessionId: "pty", lines: [], exited: true, retained: true });
    await flush();
    expect(remove).not.toHaveBeenCalled();
    unmount();
  });
});
