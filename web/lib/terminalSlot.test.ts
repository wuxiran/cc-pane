// 槽位测试（批4 · acquireTerminalSlot）。
import { describe, it, expect, beforeEach } from "vitest";
import {
  acquireTerminalSlot,
  createTerminalSlotHolder,
  inFlightSlotCount,
  resetTerminalSlots,
} from "./terminalSlot";

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

describe("createTerminalSlotHolder", () => {
  it("两个持有者争同一格：第二个 acquire 失败", () => {
    const first = createTerminalSlotHolder();
    const second = createTerminalSlotHolder();
    expect(first.acquire("t1", "leaf-1")).toBe(true);
    expect(second.acquire("t1", "leaf-1")).toBe(false);
    first.release();
    expect(second.acquire("t1", "leaf-1")).toBe(true);
  });

  it("release 幂等；未 acquire 就 release 无害", () => {
    const holder = createTerminalSlotHolder();
    holder.release();
    expect(holder.acquire("t1", "leaf-1")).toBe(true);
    holder.release();
    holder.release();
    expect(inFlightSlotCount()).toBe(0);
  });

  it("无 tabId/paneId 身份时放行且不记账（无标签视图不能被永久挡住）", () => {
    const holder = createTerminalSlotHolder();
    expect(holder.acquire(undefined, "leaf-1")).toBe(true);
    expect(holder.acquire("t1", undefined)).toBe(true);
    expect(inFlightSlotCount()).toBe(0);
  });

  // 回归守卫：接线时实测踩到过——持有者声明在 async 函数内部，「createSession
  // 永不落定就被卸载」时 finally 不执行，槽位永久泄漏，那一格此后再也建不出
  // 会话且零报错。TerminalView 两条路径的卸载清理都必须 release。
  it("持有者可在创建永不落定时被外部释放（卸载清理的形态）", () => {
    const holder = createTerminalSlotHolder();
    expect(holder.acquire("t1", "leaf-1")).toBe(true);
    // 模拟卸载：创建 promise 永不落定，只有卸载清理这一条释放路径。
    holder.release();
    expect(inFlightSlotCount()).toBe(0);
    expect(createTerminalSlotHolder().acquire("t1", "leaf-1")).toBe(true);
  });

  it("acquire 失败的持有者 release 不会误放别人的槽", () => {
    const first = createTerminalSlotHolder();
    const second = createTerminalSlotHolder();
    first.acquire("t1", "leaf-1");
    expect(second.acquire("t1", "leaf-1")).toBe(false);
    second.release();
    expect(inFlightSlotCount()).toBe(1);
    expect(createTerminalSlotHolder().acquire("t1", "leaf-1")).toBe(false);
  });
});
