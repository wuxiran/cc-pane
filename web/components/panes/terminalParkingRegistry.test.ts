import { describe, expect, it, vi } from "vitest";
import { createTerminalParkingRegistry } from "./terminalParkingRegistry";

function owners(n: number): object[] {
  return Array.from({ length: n }, (_, i) => ({ id: i }));
}

describe("createTerminalParkingRegistry", () => {
  it("隐藏数不超上限不逐出；超出按最早隐藏者（LRU）停泊", () => {
    let clock = 0;
    const registry = createTerminalParkingRegistry({ limit: 2, now: () => clock });
    const [a, b, c] = owners(3);
    const parkA = vi.fn(() => true);
    const parkB = vi.fn(() => true);
    const parkC = vi.fn(() => true);

    clock = 1; registry.notifyHidden(a, parkA);
    clock = 2; registry.notifyHidden(b, parkB);
    expect(registry.hiddenCount()).toBe(2);
    expect(parkA).not.toHaveBeenCalled();

    clock = 3; registry.notifyHidden(c, parkC);
    expect(parkA).toHaveBeenCalledTimes(1);
    expect(parkB).not.toHaveBeenCalled();
    expect(parkC).not.toHaveBeenCalled();
    expect(registry.hiddenCount()).toBe(2);
    expect(registry.hiddenOwners()).toEqual([b, c]);
  });

  it("重复 notifyHidden（每次 render）幂等：不刷新 hiddenAt，不改变 LRU 顺序", () => {
    let clock = 0;
    const registry = createTerminalParkingRegistry({ limit: 1, now: () => clock });
    const [a, b] = owners(2);
    const parkA = vi.fn(() => true);
    const parkB = vi.fn(() => true);
    clock = 1; registry.notifyHidden(a, parkA);
    clock = 5; registry.notifyHidden(a, parkA);
    clock = 6; registry.notifyHidden(b, parkB);
    // a 的 hiddenAt 仍是 1，先被逐出
    expect(parkA).toHaveBeenCalledTimes(1);
    expect(parkB).not.toHaveBeenCalled();
  });

  it("变可见 / 已停泊的 owner 退出隐藏集合，不再被逐出", () => {
    const registry = createTerminalParkingRegistry({ limit: 1 });
    const [a, b, c] = owners(3);
    const parkA = vi.fn(() => true);
    registry.notifyHidden(a, parkA);
    registry.notifyVisible(a);
    registry.notifyHidden(b, () => true);
    expect(parkA).not.toHaveBeenCalled();
    expect(registry.hiddenCount()).toBe(1);
    registry.notifyParked(b);
    expect(registry.hiddenCount()).toBe(0);
    registry.notifyHidden(c, () => true);
    expect(registry.hiddenCount()).toBe(1);
  });

  it("setLimit 缩小立即逐出到上限以内；放大不动", () => {
    let clock = 0;
    const registry = createTerminalParkingRegistry({ limit: 4, now: () => clock });
    const parks = owners(4).map((owner, i) => {
      const park = vi.fn(() => true);
      clock = i + 1;
      registry.notifyHidden(owner, park);
      return park;
    });
    registry.setLimit(8);
    expect(parks.every((park) => !park.mock.calls.length)).toBe(true);
    registry.setLimit(2);
    expect(parks[0]).toHaveBeenCalledTimes(1);
    expect(parks[1]).toHaveBeenCalledTimes(1);
    expect(parks[2]).not.toHaveBeenCalled();
    expect(parks[3]).not.toHaveBeenCalled();
    expect(registry.hiddenCount()).toBe(2);
  });

  it("limit 为惰性函数时每次逐出前重读（设置变化即生效）", () => {
    let limit = 3;
    const registry = createTerminalParkingRegistry({ limit: () => limit });
    const parks = owners(3).map((owner) => {
      const park = vi.fn(() => true);
      registry.notifyHidden(owner, park);
      return park;
    });
    expect(parks.some((park) => park.mock.calls.length)).toBe(false);
    limit = 1;
    registry.notifyHidden({}, () => true);
    expect(registry.hiddenCount()).toBe(1);
    expect(parks[0]).toHaveBeenCalledTimes(1);
    expect(parks[1]).toHaveBeenCalledTimes(1);
    expect(parks[2]).toHaveBeenCalledTimes(1);
  });

  it("park 失败（守卫拦下）的 owner 留在集合并挪到 LRU 末尾，下轮再试", () => {
    let clock = 0;
    const registry = createTerminalParkingRegistry({ limit: 1, now: () => clock });
    const [a, b, c] = owners(3);
    const parkA = vi.fn(() => false);
    const parkB = vi.fn(() => true);
    clock = 1; registry.notifyHidden(a, parkA);
    clock = 2; registry.notifyHidden(b, parkB);
    // a 拒绝停泊 → 轮到 b 被停泊；a 仍在集合里但排到末尾
    expect(parkA).toHaveBeenCalledTimes(1);
    expect(parkB).toHaveBeenCalledTimes(1);
    expect(registry.hiddenCount()).toBe(1);
    expect(registry.hiddenOwners()).toEqual([a]);
    clock = 3; registry.notifyHidden(c, () => true);
    expect(parkA).toHaveBeenCalledTimes(2);
  });

  it("park 抛错视为失败，不中断逐出", () => {
    const registry = createTerminalParkingRegistry({ limit: 1 });
    const [a, b] = owners(2);
    registry.notifyHidden(a, () => { throw new Error("boom"); });
    expect(() => registry.notifyHidden(b, () => true)).not.toThrow();
    expect(registry.hiddenCount()).toBe(1);
  });
});
