import "@/i18n";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

const mocks = vi.hoisted(() => ({ getStatus: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock("@/services/keepAwakeService", () => ({ keepAwakeService: { getStatus: mocks.getStatus } }));
vi.mock("@/services/runtime", () => ({ isTauriRuntime: mocks.isTauri }));

import KeepAwakeIndicator, { KEEP_AWAKE_POLL_MS } from "./KeepAwakeIndicator";

function report(holding: boolean) {
  return {
    enabled: true,
    holding,
    app: { enabled: true, holding: false, busyCount: 0 },
    daemon: { enabled: true, holding, busyCount: holding ? 1 : 0 },
  };
}

function renderIndicator() {
  return render(
    <TooltipProvider>
      <KeepAwakeIndicator />
    </TooltipProvider>,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.isTauri.mockReturnValue(true);
});

describe("KeepAwakeIndicator", () => {
  it("shows the icon only while a lock is held", async () => {
    vi.useFakeTimers();
    mocks.getStatus.mockResolvedValueOnce(report(true)).mockResolvedValueOnce(report(false));
    renderIndicator();
    await act(async () => {});
    expect(screen.getByRole("img", { name: /阻止系统休眠|sleep is prevented/ })).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(KEEP_AWAKE_POLL_MS);
    });
    expect(screen.queryByRole("img", { name: /阻止系统休眠|sleep is prevented/ })).toBeNull();
  });

  it("does not query outside the desktop runtime", () => {
    mocks.isTauri.mockReturnValue(false);
    renderIndicator();
    expect(mocks.getStatus).not.toHaveBeenCalled();
  });
});
