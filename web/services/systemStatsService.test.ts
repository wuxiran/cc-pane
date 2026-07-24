import { beforeEach, describe, expect, it, vi } from "vitest";
import { invokeIfTauri } from "./runtime";
import { systemStatsService } from "./systemStatsService";

vi.mock("./runtime", () => ({
  invokeIfTauri: vi.fn(),
}));

describe("systemStatsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("通过 get_system_stats 命令读取系统统计", async () => {
    const stats = { cpuPercent: 12.5, memUsed: 8, memTotal: 16 };
    vi.mocked(invokeIfTauri).mockResolvedValue(stats);

    await expect(systemStatsService.get()).resolves.toEqual(stats);
    expect(invokeIfTauri).toHaveBeenCalledWith("get_system_stats");
  });

  it("非桌面运行时返回 null", async () => {
    vi.mocked(invokeIfTauri).mockResolvedValue(undefined);

    await expect(systemStatsService.get()).resolves.toBeNull();
  });
});
