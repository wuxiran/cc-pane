import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IslandSession } from "@/types/island";
import { DONE_POP_MS, useDonePop } from "./useDonePop";

const done = (id: string, since: number): IslandSession => ({
  id, kind: "terminal", name: id, cli: "Codex", state: "done", since, activity: null, approval: null,
});

describe("useDonePop", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not pop finishes that already existed when the island loaded", () => {
    const { result } = renderHook(({ list }) => useDonePop(list, true), { initialProps: { list: [done("old", 1)] } });
    expect(result.current).toBeNull();
  });

  it("pops a new finish and auto-collapses after 4 seconds", () => {
    const { result, rerender } = renderHook(({ list }) => useDonePop(list, true), { initialProps: { list: [] as IslandSession[] } });
    const fresh = done("a", 10);
    rerender({ list: [fresh] });
    expect(result.current).toEqual(fresh);
    act(() => vi.advanceTimersByTime(DONE_POP_MS - 1));
    expect(result.current).toEqual(fresh);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBeNull();
  });

  it("restarts the 4 second window for a second finish", () => {
    const { result, rerender } = renderHook(({ list }) => useDonePop(list, true), { initialProps: { list: [] as IslandSession[] } });
    rerender({ list: [done("a", 10)] });
    act(() => vi.advanceTimersByTime(3_000));
    rerender({ list: [done("b", 20), done("a", 10)] });
    act(() => vi.advanceTimersByTime(3_000));
    expect(result.current?.id).toBe("b");
    act(() => vi.advanceTimersByTime(1_000));
    expect(result.current).toBeNull();
  });

  it("never pops when pop-on-finish is off", () => {
    const { result, rerender } = renderHook(({ list }) => useDonePop(list, false), { initialProps: { list: [] as IslandSession[] } });
    rerender({ list: [done("a", 10)] });
    expect(result.current).toBeNull();
  });
});
