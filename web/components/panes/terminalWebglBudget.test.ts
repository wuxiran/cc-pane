import { expect, it, vi } from "vitest";
import { createTerminalWebglBudget } from "./terminalWebglBudget";

it("reclaims hidden contexts immediately during rapid layout switching", () => {
  const pool = createTerminalWebglBudget(1), first = {}, second = {};
  let firstVisible = true, secondVisible = false;
  const revokeFirst = vi.fn(), revokeSecond = vi.fn();
  pool.acquire(first, () => {}, () => firstVisible, revokeFirst);
  firstVisible = false; secondVisible = true;
  expect(pool.acquire(second, () => {}, () => secondVisible, revokeSecond)).toBe(true);
  expect(revokeFirst).toHaveBeenCalledOnce(); expect(pool.count()).toBe(1);
  secondVisible = false; firstVisible = true;
  expect(pool.acquire(first, () => {}, () => firstVisible, revokeFirst)).toBe(true);
  expect(revokeSecond).toHaveBeenCalledOnce(); expect(pool.count()).toBe(1);
});

it("bounds contexts, prioritizes visible waiters and cancels disposed waiters", async () => {
  const pool = createTerminalWebglBudget(1);
  const first = {}, hidden = {}, visible = {}, cancelled = {};
  const grants: string[] = [];
  const acquire = (owner: object, name: string, isVisible: boolean) => pool.acquire(owner, () => {
    grants.push(name); acquire(owner, name, isVisible);
  }, () => isVisible);
  expect(acquire(first, "first", true)).toBe(true);
  expect(acquire(hidden, "hidden", false)).toBe(false);
  expect(acquire(visible, "visible", true)).toBe(false);
  const noGrant = vi.fn();
  pool.acquire(cancelled, noGrant, () => true);
  pool.release(cancelled);
  pool.release(first);
  await Promise.resolve();
  expect(grants).toEqual(["visible"]);
  expect(pool.count()).toBe(1);
  pool.release(visible);
  await Promise.resolve();
  expect(grants).toEqual(["visible", "hidden"]);
  expect(noGrant).not.toHaveBeenCalled();
});

it("evicts the least-recently-hidden holder, never a visible one", () => {
  let clock = 0;
  const pool = createTerminalWebglBudget(3, { hiddenLimit: 6, now: () => clock });
  const state = { a: true, b: true, c: true, d: true };
  const revoked: string[] = [];
  const acquire = (name: keyof typeof state) =>
    pool.acquire({ name }, () => {}, () => state[name], () => revoked.push(name));
  // owner identity must be stable per name
  const owners: Record<string, object> = {};
  const acquireStable = (name: keyof typeof state) => {
    owners[name] ??= { name };
    return pool.acquire(owners[name], () => {}, () => state[name], () => revoked.push(name));
  };
  void acquire;
  expect(acquireStable("a")).toBe(true);
  expect(acquireStable("b")).toBe(true);
  expect(acquireStable("c")).toBe(true);
  // b hides first, then a; c stays visible
  clock = 10; state.b = false; pool.sweep();
  clock = 20; state.a = false; pool.sweep();
  expect(pool.hiddenCount()).toBe(2);
  // visible newcomer: pool is full → evict b (hidden earliest), not c (visible), not a (hidden later)
  expect(acquireStable("d")).toBe(true);
  expect(revoked).toEqual(["b"]);
  expect(pool.count()).toBe(3);
  // one more visible newcomer evicts a (the next oldest hidden)
  expect(pool.acquire({ name: "e" }, () => {}, () => true)).toBe(true);
  expect(revoked).toEqual(["b", "a"]);
  // pool now holds only visible holders; a further visible newcomer must wait
  expect(pool.acquire({ name: "f" }, () => {}, () => true)).toBe(false);
  expect(pool.count()).toBe(3);
});

it("caps hidden holders at hiddenLimit and keeps hidden waiters queued", async () => {
  let clock = 0;
  const pool = createTerminalWebglBudget(8, { hiddenLimit: 2, now: () => clock });
  const revoked: string[] = [];
  const grants: string[] = [];
  const hiddenOwners = ["h1", "h2", "h3"].map((name) => ({ name }));
  for (const owner of hiddenOwners) {
    clock += 1;
    // the first two hidden acquirers get a context, the third waits
    const granted = pool.acquire(
      owner, () => grants.push(owner.name), () => false, () => revoked.push(owner.name),
    );
    expect(granted).toBe(owner.name !== "h3");
  }
  expect(pool.hiddenCount()).toBe(2);
  // visible holders are unaffected by the hidden cap
  const v1 = { name: "v1" };
  expect(pool.acquire(v1, () => {}, () => true)).toBe(true);
  expect(pool.count()).toBe(3);
  // a holder that becomes hidden pushes the hidden count over the cap → oldest hidden is evicted
  const late = { name: "v2" }; let lateVisible = true;
  expect(pool.acquire(late, () => {}, () => lateVisible)).toBe(true);
  clock += 1; lateVisible = false; pool.sweep();
  expect(revoked).toEqual(["h1"]);
  expect(pool.hiddenCount()).toBe(2);
  // releasing a visible holder frees a slot, but hidden waiters stay queued while the cap is full
  pool.release(v1);
  await Promise.resolve();
  expect(grants).toEqual([]);
  // releasing a hidden holder drops below the cap → hidden waiters drain in FIFO order
  pool.release(hiddenOwners[1]);
  await Promise.resolve();
  expect(grants).toEqual(["h3", "h1"]);
});
