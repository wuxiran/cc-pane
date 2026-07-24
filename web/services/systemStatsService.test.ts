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

  it("通过 get_resource_tree 命令读取会话资源树", async () => {
    const tree = { sessions: [], orphans: [], elapsedMicros: 42 };
    vi.mocked(invokeIfTauri).mockResolvedValue(tree);

    await expect(systemStatsService.getResourceTree()).resolves.toEqual(tree);
    expect(invokeIfTauri).toHaveBeenCalledWith("get_resource_tree");
  });

  it("通过 kill_orphan_processes 命令批量终止孤立进程", async () => {
    const results = [{ pid: 42, success: true, error: null }];
    vi.mocked(invokeIfTauri).mockResolvedValue(results);

    await expect(systemStatsService.killOrphans([42])).resolves.toEqual(results);
    expect(invokeIfTauri).toHaveBeenCalledWith("kill_orphan_processes", { pids: [42] });
  });
});
