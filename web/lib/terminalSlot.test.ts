// 槽位测试（批4 · acquireTerminalSlot）。
import { describe, it, expect, beforeEach } from "vitest";
import { acquireTerminalSlot, inFlightSlotCount, resetTerminalSlots } from "./terminalSlot";

beforeEach(resetTerminalSlots);

describe("acquireTerminalSlot", () => {
  it("同一 (tabId, paneId) 在途时第二个进入者拿不到槽", () => {
    const release = acquireTerminalSlot("t1", "leaf-1");
    expect(release).not.toBeNull();
    expect(acquireTerminalSlot("t1", "leaf-1")).toBeNull();
    release!();
    expect(acquireTerminalSlot("t1", "leaf-1")).not.toBeNull();
  });

  it("不同格互不影响", () => {
    expect(acquireTerminalSlot("t1", "leaf-1")).not.toBeNull();
    expect(acquireTerminalSlot("t1", "leaf-2")).not.toBeNull();
    expect(acquireTerminalSlot("t2", "leaf-1")).not.toBeNull();
    expect(inFlightSlotCount()).toBe(3);
  });

  it("释放幂等：finally 与 catch 重复调无害", () => {
    const release = acquireTerminalSlot("t1", "leaf-1")!;
    release();
    release();
    expect(inFlightSlotCount()).toBe(0);
    expect(acquireTerminalSlot("t1", "leaf-1")).not.toBeNull();
  });
});
