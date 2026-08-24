import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipeEdge } from "@/types/canvas";
import { usePipePreviewEvents } from "./usePipePreviewEvents";

const edge: PipeEdge = {
  id: "pipe:leader->worker",
  sourceId: "leader",
  targetId: "worker",
  readOnly: true,
};

describe("usePipePreviewEvents", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("plays a one-shot queued, flowing, delivered preview and can replay it", () => {
    const { result, rerender } = renderHook(
      ({ enabled, replayKey }) => usePipePreviewEvents([edge], enabled, replayKey),
      { initialProps: { enabled: true, replayKey: 0 } },
    );

    act(() => vi.advanceTimersByTime(0));
    expect(result.current).toMatchObject([{ phase: "queued", sourceId: "leader", targetId: "worker" }]);

    act(() => vi.advanceTimersByTime(360));
    expect(result.current).toMatchObject([{ phase: "flowing" }]);

    act(() => vi.advanceTimersByTime(3_200));
    expect(result.current).toMatchObject([{ phase: "delivered" }]);

    act(() => vi.advanceTimersByTime(900));
    expect(result.current).toEqual([]);

    rerender({ enabled: true, replayKey: 1 });
    act(() => vi.advanceTimersByTime(0));
    expect(result.current).toMatchObject([{ phase: "queued" }]);
  });

  it("clears an active preview when animation is disabled", () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => usePipePreviewEvents([edge], enabled),
      { initialProps: { enabled: true } },
    );

    act(() => vi.advanceTimersByTime(0));
    expect(result.current).toHaveLength(1);

    rerender({ enabled: false });
    expect(result.current).toEqual([]);
  });
});
