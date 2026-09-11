import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOrphanSessionReconciler } from "./useOrphanSessionReconciler";
import { usePanesStore } from "@/stores/usePanesStore";
import { terminalService } from "@/services/terminalService";
import { runnerService } from "@/services/runnerService";
import { taskBindingService } from "@/services/taskBindingService";
import { notificationService } from "@/services/notificationService";
import { isTauriRuntime } from "@/services/runtime";
import type { TerminalStatusInfo } from "@/types";

const settingsState = vi.hoisted(() => ({ available: true, reapingDisabled: false }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/stores/usePanesStore", () => ({
  usePanesStore: {
    getState: vi.fn(),
  },
}));

vi.mock("@/stores/useSelfChatStore", () => ({
  useSelfChatStore: {
    getState: vi.fn(() => ({ activeSession: null })),
  },
}));

vi.mock("@/stores/useSettingsStore", () => ({
  useSettingsStore: {
    getState: () => ({
      settings: settingsState.available
        ? {
            terminal: {
              daemonOrphanReaperDisabled: settingsState.reapingDisabled,
            },
          }
        : null,
    }),
  },
}));

vi.mock("@/services/terminalService", () => ({
  terminalService: {
    getAllStatus: vi.fn(),
    killSession: vi.fn(),
    getDaemonClientInfo: vi.fn(),
  },
}));

vi.mock("@/services/runnerService", () => ({
  runnerService: {
    listActiveInstances: vi.fn(),
  },
}));

vi.mock("@/services/taskBindingService", () => ({
  taskBindingService: {
    query: vi.fn(),
  },
}));

vi.mock("@/services/notificationService", () => ({
  notificationService: {
    trigger: vi.fn(),
  },
}));

vi.mock("@/services/runtime", () => ({
  isTauriRuntime: vi.fn(),
}));

vi.mock("@/utils", () => ({
  waitForTauri: vi.fn(async () => true),
}));

const FIRST_SWEEP_DELAY_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/** 默认 exited：那是唯一可回收的孤儿状态，活着的孤儿只观测不杀。 */
function status(
  sessionId: string,
  ageMs: number,
  sessionStatus: TerminalStatusInfo["status"] = "exited",
): TerminalStatusInfo {
  const at = Date.now() - ageMs;
  return { sessionId, status: sessionStatus, lastOutputAt: at, updatedAt: at };
}

describe("useOrphanSessionReconciler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    settingsState.available = true;
    settingsState.reapingDisabled = false;
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    vi.mocked(usePanesStore.getState).mockReturnValue({
      collectReferencedSessionIds: () => new Set<string>(),
    } as unknown as ReturnType<typeof usePanesStore.getState>);
    vi.mocked(terminalService.getAllStatus).mockReset().mockResolvedValue([]);
    vi.mocked(terminalService.killSession).mockReset().mockResolvedValue();
    vi.mocked(terminalService.getDaemonClientInfo)
      .mockReset()
      .mockResolvedValue({ mode: "daemon", desktopClientCount: 1 });
    vi.mocked(runnerService.listActiveInstances).mockReset().mockResolvedValue([]);
    vi.mocked(taskBindingService.query)
      .mockReset()
      .mockResolvedValue({ items: [], total: 0, hasMore: false });
    vi.mocked(notificationService.trigger)
      .mockReset()
      .mockResolvedValue({ sent: true, skipped: false, reason: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing outside the Tauri runtime", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(false);
    renderHook(() => useOrphanSessionReconciler());

    await vi.advanceTimersByTimeAsync(FIRST_SWEEP_DELAY_MS + SWEEP_INTERVAL_MS);
    expect(terminalService.getAllStatus).not.toHaveBeenCalled();
  });

  it("does not sweep when orphan reaping is disabled", async () => {
    settingsState.reapingDisabled = true;
    renderHook(() => useOrphanSessionReconciler());

    await vi.advanceTimersByTimeAsync(FIRST_SWEEP_DELAY_MS + SWEEP_INTERVAL_MS);

    expect(runnerService.listActiveInstances).not.toHaveBeenCalled();
    expect(terminalService.getAllStatus).not.toHaveBeenCalled();
  });

  it("fails closed while settings are unavailable", async () => {
    settingsState.available = false;
    renderHook(() => useOrphanSessionReconciler());

    await vi.advanceTimersByTimeAsync(FIRST_SWEEP_DELAY_MS + SWEEP_INTERVAL_MS);

    expect(runnerService.listActiveInstances).not.toHaveBeenCalled();
    expect(terminalService.getAllStatus).not.toHaveBeenCalled();
  });

  it("waits for the first-sweep delay, then sweeps periodically", async () => {
    renderHook(() => useOrphanSessionReconciler());

    await vi.advanceTimersByTimeAsync(FIRST_SWEEP_DELAY_MS - 1);
    expect(terminalService.getAllStatus).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(terminalService.getAllStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    expect(terminalService.getAllStatus).toHaveBeenCalledTimes(2);
  });

  it("kills unreferenced exited sessions and sends one aggregated notification", async () => {
    vi.mocked(terminalService.getAllStatus).mockResolvedValue([
      status("orphan-1", 60 * 60 * 1000),
      status("orphan-2", 30 * 60 * 1000),
    ]);
    renderHook(() => useOrphanSessionReconciler());

    await vi.advanceTimersByTimeAsync(FIRST_SWEEP_DELAY_MS);

    expect(terminalService.killSession).toHaveBeenCalledWith("orphan-1", "orphan-reclaim");
    expect(terminalService.killSession).toHaveBeenCalledWith("orphan-2", "orphan-reclaim");
    expect(notificationService.trigger).toHaveBeenCalledTimes(1);
  });

  // 活着的孤儿只观测不杀：CLI 跑完一轮停在提示符上就是 idle，失去前端引用多半是
  // 布局恢复/收养失败，10 分钟后把它杀掉 = 用户眼里的「CLI 被异常卸载」。
  it("observes but never kills live orphans (idle CLI at a prompt)", async () => {
    vi.mocked(terminalService.getAllStatus).mockResolvedValue([
      status("live-orphan", 60 * 60 * 1000, "idle"),
    ]);
    renderHook(() => useOrphanSessionReconciler());

    await vi.advanceTimersByTimeAsync(FIRST_SWEEP_DELAY_MS);

    expect(terminalService.getAllStatus).toHaveBeenCalled();
    expect(terminalService.killSession).not.toHaveBeenCalled();
    expect(notificationService.trigger).not.toHaveBeenCalled();
  });

  it("kills exited orphans while leaving live ones alone in the same sweep", async () => {
    vi.mocked(terminalService.getAllStatus).mockResolvedValue([
      status("dead", 60 * 60 * 1000, "exited"),
      status("alive", 60 * 60 * 1000, "idle"),
    ]);
    renderHook(() => useOrphanSessionReconciler());

    await vi.advanceTimersByTimeAsync(FIRST_SWEEP_DELAY_MS);

    expect(terminalService.killSession).toHaveBeenCalledTimes(1);
    expect(terminalService.killSession).toHaveBeenCalledWith("dead", "orphan-reclaim");
  });

  it("skips a session that gets claimed between select and kill (TOCTOU recheck)", async () => {
    vi.mocked(terminalService.getAllStatus).mockResolvedValue([
      status("claimed-later", 60 * 60 * 1000),
    ]);
    // 第一次收集（sweep 快照）为空，kill 前复查时已被 tab 认领
    vi.mocked(usePanesStore.getState)
      .mockReturnValueOnce({
        collectReferencedSessionIds: () => new Set<string>(),
      } as unknown as ReturnType<typeof usePanesStore.getState>)
      .mockReturnValue({
        collectReferencedSessionIds: () => new Set(["claimed-later"]),
      } as unknown as ReturnType<typeof usePanesStore.getState>);

    renderHook(() => useOrphanSessionReconciler());
    await vi.advanceTimersByTimeAsync(FIRST_SWEEP_DELAY_MS);

    expect(terminalService.killSession).not.toHaveBeenCalled();
    expect(notificationService.trigger).not.toHaveBeenCalled();
  });

  it("fails closed when a reference source query throws", async () => {
    vi.mocked(runnerService.listActiveInstances).mockRejectedValue(new Error("ipc down"));
    vi.mocked(terminalService.getAllStatus).mockResolvedValue([
      status("orphan", 60 * 60 * 1000),
    ]);
    renderHook(() => useOrphanSessionReconciler());

    await vi.advanceTimersByTimeAsync(FIRST_SWEEP_DELAY_MS);
    expect(terminalService.killSession).not.toHaveBeenCalled();
  });

  it("treats runner and task-binding sessions as referenced", async () => {
    vi.mocked(runnerService.listActiveInstances).mockResolvedValue([
      { sessionId: "runner-session" } as never,
    ]);
    vi.mocked(taskBindingService.query).mockResolvedValue({
      items: [{ sessionId: "worker-session" } as never],
      total: 1,
      hasMore: false,
    });
    vi.mocked(terminalService.getAllStatus).mockResolvedValue([
      status("runner-session", 60 * 60 * 1000),
      status("worker-session", 60 * 60 * 1000),
    ]);
    renderHook(() => useOrphanSessionReconciler());

    await vi.advanceTimersByTimeAsync(FIRST_SWEEP_DELAY_MS);
    expect(terminalService.killSession).not.toHaveBeenCalled();
  });

  it("skips the sweep when multiple desktop clients share the daemon", async () => {
    vi.mocked(terminalService.getDaemonClientInfo).mockResolvedValue({
      mode: "daemon",
      desktopClientCount: 2,
    });
    vi.mocked(terminalService.getAllStatus).mockResolvedValue([
      status("other-window-session", 60 * 60 * 1000),
    ]);
    renderHook(() => useOrphanSessionReconciler());

    await vi.advanceTimersByTimeAsync(FIRST_SWEEP_DELAY_MS);

    expect(terminalService.getAllStatus).not.toHaveBeenCalled();
    expect(terminalService.killSession).not.toHaveBeenCalled();
  });

  it("fails closed when the daemon does not report a client count (old daemon)", async () => {
    vi.mocked(terminalService.getDaemonClientInfo).mockResolvedValue({ mode: "daemon" });
    vi.mocked(terminalService.getAllStatus).mockResolvedValue([
      status("orphan", 60 * 60 * 1000),
    ]);
    renderHook(() => useOrphanSessionReconciler());

    await vi.advanceTimersByTimeAsync(FIRST_SWEEP_DELAY_MS);
    expect(terminalService.killSession).not.toHaveBeenCalled();
  });

  it("fails closed when the client info query throws", async () => {
    vi.mocked(terminalService.getDaemonClientInfo).mockRejectedValue(new Error("ipc down"));
    vi.mocked(terminalService.getAllStatus).mockResolvedValue([
      status("orphan", 60 * 60 * 1000),
    ]);
    renderHook(() => useOrphanSessionReconciler());

    await vi.advanceTimersByTimeAsync(FIRST_SWEEP_DELAY_MS);
    expect(terminalService.killSession).not.toHaveBeenCalled();
  });

  it("sweeps normally for the in-process backend (sessions are instance-local)", async () => {
    vi.mocked(terminalService.getDaemonClientInfo).mockResolvedValue({ mode: "in-process" });
    vi.mocked(terminalService.getAllStatus).mockResolvedValue([
      status("orphan", 60 * 60 * 1000),
    ]);
    renderHook(() => useOrphanSessionReconciler());

    await vi.advanceTimersByTimeAsync(FIRST_SWEEP_DELAY_MS);
    expect(terminalService.killSession).toHaveBeenCalledWith("orphan", "orphan-reclaim");
  });

  it("aborts the kill loop when a second desktop client appears mid-sweep", async () => {
    vi.mocked(terminalService.getDaemonClientInfo)
      .mockResolvedValueOnce({ mode: "daemon", desktopClientCount: 1 })
      .mockResolvedValue({ mode: "daemon", desktopClientCount: 2 });
    vi.mocked(terminalService.getAllStatus).mockResolvedValue([
      status("orphan", 60 * 60 * 1000),
    ]);
    renderHook(() => useOrphanSessionReconciler());

    await vi.advanceTimersByTimeAsync(FIRST_SWEEP_DELAY_MS);
    expect(terminalService.getAllStatus).toHaveBeenCalled();
    expect(terminalService.killSession).not.toHaveBeenCalled();
  });

  it("paginates task bindings before deciding a session is orphaned", async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => ({
      id: `pending-${index}`,
    }));
    vi.mocked(taskBindingService.query).mockImplementation(async (query = {}) => {
      const { status, offset } = query;
      if (status === "pending" && offset === 0) {
        return { items: firstPage as never[], total: 201, hasMore: true };
      }
      if (status === "pending" && offset === 200) {
        return {
          items: [{ id: "pending-worker", sessionId: "paged-worker" } as never],
          total: 201,
          hasMore: false,
        };
      }
      return { items: [], total: 0, hasMore: false };
    });
    vi.mocked(terminalService.getAllStatus).mockResolvedValue([
      status("paged-worker", 60 * 60 * 1000),
    ]);
    renderHook(() => useOrphanSessionReconciler());

    await vi.advanceTimersByTimeAsync(FIRST_SWEEP_DELAY_MS);

    expect(taskBindingService.query).toHaveBeenCalledWith({
      status: "pending",
      limit: 200,
      offset: 200,
    });
    expect(terminalService.killSession).not.toHaveBeenCalled();
  });
});
