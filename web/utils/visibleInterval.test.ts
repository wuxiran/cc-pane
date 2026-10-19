import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startVisibleInterval } from "./visibleInterval";

function setVisibility(state: DocumentVisibilityState) {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("startVisibleInterval", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("ticks while visible and stops while hidden", () => {
    const callback = vi.fn();
    const stop = startVisibleInterval(callback, 1000);
    vi.advanceTimersByTime(3000);
    expect(callback).toHaveBeenCalledTimes(3);

    setVisibility("hidden");
    vi.advanceTimersByTime(10_000);
    expect(callback).toHaveBeenCalledTimes(3);
    stop();
  });

  it("catches up once on return when a full period elapsed, then resumes cadence", () => {
    const callback = vi.fn();
    const stop = startVisibleInterval(callback, 1000);
    setVisibility("hidden");
    vi.advanceTimersByTime(5000);
    setVisibility("visible");
    expect(callback).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(callback).toHaveBeenCalledTimes(2);
    stop();
  });

  it("does not catch up when hidden only briefly", () => {
    const callback = vi.fn();
    const stop = startVisibleInterval(callback, 1000);
    vi.advanceTimersByTime(200);
    setVisibility("hidden");
    vi.advanceTimersByTime(300);
    setVisibility("visible");
    expect(callback).not.toHaveBeenCalled();
    stop();
  });

  it("starting while hidden waits for visibility, and stop detaches the listener", () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const callback = vi.fn();
    const stop = startVisibleInterval(callback, 1000);
    vi.advanceTimersByTime(5000);
    expect(callback).not.toHaveBeenCalled();

    stop();
    setVisibility("visible");
    vi.advanceTimersByTime(5000);
    expect(callback).not.toHaveBeenCalled();
  });
});
