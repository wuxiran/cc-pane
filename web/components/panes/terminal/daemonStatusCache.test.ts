import { afterEach, describe, expect, it, vi } from "vitest";

const getAllStatus = vi.fn();
vi.mock("@/services/terminalService", () => ({
  terminalService: { getAllStatus: (...args: unknown[]) => getAllStatus(...args) },
}));

import {
  getAllTerminalStatusShared,
  resetTerminalStatusCacheForTests,
} from "./daemonStatusCache";

describe("getAllTerminalStatusShared", () => {
  afterEach(() => {
    resetTerminalStatusCacheForTests();
    getAllStatus.mockReset();
  });

  it("coalesces concurrent callers into one daemon request", async () => {
    let resolve!: (value: unknown) => void;
    getAllStatus.mockReturnValue(new Promise((r) => { resolve = r; }));
    const a = getAllTerminalStatusShared();
    const b = getAllTerminalStatusShared();
    resolve([{ sessionId: "s1" }]);
    expect(await a).toEqual([{ sessionId: "s1" }]);
    expect(await b).toEqual([{ sessionId: "s1" }]);
    expect(getAllStatus).toHaveBeenCalledTimes(1);
  });

  it("serves a fresh result from cache and refetches once it ages out", async () => {
    let now = 1_000;
    getAllStatus.mockResolvedValue([{ sessionId: "s1" }]);
    await getAllTerminalStatusShared(1_500, () => now);
    now += 500;
    await getAllTerminalStatusShared(1_500, () => now);
    expect(getAllStatus).toHaveBeenCalledTimes(1);
    now += 1_500;
    await getAllTerminalStatusShared(1_500, () => now);
    expect(getAllStatus).toHaveBeenCalledTimes(2);
  });

  it("does not cache failures", async () => {
    getAllStatus.mockRejectedValueOnce(new Error("daemon down"));
    await expect(getAllTerminalStatusShared()).rejects.toThrow("daemon down");
    getAllStatus.mockResolvedValueOnce([]);
    expect(await getAllTerminalStatusShared()).toEqual([]);
    expect(getAllStatus).toHaveBeenCalledTimes(2);
  });
});
