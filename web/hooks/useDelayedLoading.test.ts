import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SKELETON_DELAY_MS, useDelayedLoading } from "./useDelayedLoading";

describe("useDelayedLoading", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false immediately when loading starts", () => {
    const { result } = renderHook(() => useDelayedLoading(true));

    expect(result.current).toBe(false);
  });

  it("stays false when never loading", () => {
    const { result } = renderHook(() => useDelayedLoading(false));

    act(() => {
      vi.advanceTimersByTime(SKELETON_DELAY_MS * 4);
    });

    expect(result.current).toBe(false);
  });

  it("returns true only after loading persists past the default 300ms", () => {
    const { result } = renderHook(() => useDelayedLoading(true));

    act(() => {
      vi.advanceTimersByTime(SKELETON_DELAY_MS - 1);
    });
    expect(result.current).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });

  it("stays false when loading finishes within the delay", () => {
    const { result, rerender } = renderHook(
      ({ loading }) => useDelayedLoading(loading),
      { initialProps: { loading: true } },
    );

    act(() => {
      vi.advanceTimersByTime(SKELETON_DELAY_MS - 100);
    });
    rerender({ loading: false });
    act(() => {
      vi.advanceTimersByTime(SKELETON_DELAY_MS * 2);
    });

    expect(result.current).toBe(false);
  });

  it("returns false immediately once loading ends", () => {
    const { result, rerender } = renderHook(
      ({ loading }) => useDelayedLoading(loading),
      { initialProps: { loading: true } },
    );

    act(() => {
      vi.advanceTimersByTime(SKELETON_DELAY_MS);
    });
    expect(result.current).toBe(true);

    rerender({ loading: false });
    expect(result.current).toBe(false);
  });

  it("resets the timer when loading restarts", () => {
    const { result, rerender } = renderHook(
      ({ loading }) => useDelayedLoading(loading),
      { initialProps: { loading: true } },
    );

    act(() => {
      vi.advanceTimersByTime(SKELETON_DELAY_MS - 100);
    });
    rerender({ loading: false });
    rerender({ loading: true });

    act(() => {
      vi.advanceTimersByTime(SKELETON_DELAY_MS - 1);
    });
    expect(result.current).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });

  it("supports a custom delay", () => {
    const { result } = renderHook(() => useDelayedLoading(true, 100));

    act(() => {
      vi.advanceTimersByTime(99);
    });
    expect(result.current).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });
});
