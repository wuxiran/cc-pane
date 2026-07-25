import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mcpService } from "@/services";
import type { OrchestratorStatus } from "@/types";
import { useOrchestratorStatus } from "./useOrchestratorStatus";

vi.mock("@/services", () => ({
  mcpService: {
    getOrchestratorStatus: vi.fn(),
    onOrchestratorStatusChanged: vi.fn(),
  },
}));

const readyStatus = {
  port: 47822,
  bind: { host: "127.0.0.1", mode: "auto", reason: "test" },
  lifecycle: "ready",
  attempt: null,
  lastError: null,
  nextRetryAt: null,
} as OrchestratorStatus;

describe("useOrchestratorStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mcpService.getOrchestratorStatus).mockResolvedValue(readyStatus);
  });

  it("先订阅事件再读取当前状态，并用事件持续更新", async () => {
    let onStatus: ((status: OrchestratorStatus) => void) | undefined;
    vi.mocked(mcpService.onOrchestratorStatusChanged).mockImplementation(async (handler) => {
      onStatus = handler;
      return vi.fn(() => {});
    });

    const { result } = renderHook(() => useOrchestratorStatus());

    await waitFor(() => expect(result.current).toEqual(readyStatus));
    expect(mcpService.onOrchestratorStatusChanged).toHaveBeenCalledBefore(
      vi.mocked(mcpService.getOrchestratorStatus),
    );

    const failedStatus = {
      ...readyStatus,
      port: null,
      lifecycle: "failed",
      attempt: 5,
      lastError: "port occupied",
    } as OrchestratorStatus;
    act(() => onStatus?.(failedStatus));

    expect(result.current).toEqual(failedStatus);
  });

  it("卸载后释放事件订阅", async () => {
    const unlisten = vi.fn(() => {});
    vi.mocked(mcpService.onOrchestratorStatusChanged).mockResolvedValue(unlisten);

    const view = renderHook(() => useOrchestratorStatus());
    await waitFor(() => expect(view.result.current).toEqual(readyStatus));
    view.unmount();

    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
