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
