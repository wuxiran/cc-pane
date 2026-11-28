import { afterEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./runtime", () => ({ invokeIfTauri: runtime.invoke }));

import { keepAwakeService } from "./keepAwakeService";

afterEach(() => vi.clearAllMocks());

describe("keepAwakeService", () => {
  it("invokes get_keep_awake_status without arguments", async () => {
    const report = {
      enabled: true,
      holding: true,
      app: { enabled: true, holding: false, busyCount: 0 },
      daemon: { enabled: true, holding: true, busyCount: 2 },
    };
    runtime.invoke.mockResolvedValue(report);
    await expect(keepAwakeService.getStatus()).resolves.toEqual(report);
    expect(runtime.invoke).toHaveBeenCalledWith("get_keep_awake_status");
  });
});
