import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ORB_TIMINGS } from "./orbModel";
import { useOrbHover, type OrbHoverOptions } from "./useOrbHover";

function setup(initial: Partial<OrbHoverOptions> = {}) {
  const onDwell = vi.fn();
  const props: OrbHoverOptions = { hovered: false, dragging: false, hoverSwitch: true, onDwell, ...initial };
  const hook = renderHook((options: OrbHoverOptions) => useOrbHover(options), { initialProps: props });
  const update = (patch: Partial<OrbHoverOptions>) => hook.rerender({ ...props, ...patch });
  return { ...hook, onDwell, update };
}

const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe("useOrbHover", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("opens only after hovering the orb for the open delay", () => {
    const { result, update } = setup();
    update({ hovered: true });
    advance(ORB_TIMINGS.openDelayMs - 1);
    expect(result.current.open).toBe(false);
    advance(1);
    expect(result.current.open).toBe(true);
  });

  it("does not open when the pointer leaves early or while dragging", () => {
    const { result, update } = setup();
    update({ hovered: true });
    advance(ORB_TIMINGS.openDelayMs / 2);
    update({ hovered: false });
    advance(ORB_TIMINGS.openDelayMs * 2);
    expect(result.current.open).toBe(false);
    update({ hovered: true, dragging: true });
    advance(ORB_TIMINGS.openDelayMs * 2);
    expect(result.current.open).toBe(false);
  });

  it("closes after the close delay, but crossing the gap back cancels it", () => {
    const { result, update } = setup({ hovered: true });
    advance(ORB_TIMINGS.openDelayMs);
    update({ hovered: false });
    advance(ORB_TIMINGS.closeDelayMs - 10);
    update({ hovered: true });
    advance(ORB_TIMINGS.closeDelayMs);
    expect(result.current.open).toBe(true);
    update({ hovered: false });
    advance(ORB_TIMINGS.closeDelayMs);
    expect(result.current.open).toBe(false);
  });

  it("switches to a row after dwelling on it and closes the list", () => {
    const { result, onDwell } = setup({ hovered: true });
    advance(ORB_TIMINGS.openDelayMs);
    act(() => result.current.rowEnter("s2", 1));
    expect(result.current.highlight).toBe(1);
    expect(result.current.dwellId).toBe("s2");
    advance(ORB_TIMINGS.dwellSwitchMs - 1);
    expect(onDwell).not.toHaveBeenCalled();
    advance(1);
    expect(onDwell).toHaveBeenCalledWith("s2");
    expect(result.current.open).toBe(false);
    expect(result.current.dwellId).toBeNull();
  });

  it("restarts the dwell when moving to another row and resets on leave", () => {
    const { result, onDwell } = setup({ hovered: true });
    advance(ORB_TIMINGS.openDelayMs);
    act(() => result.current.rowEnter("s1", 0));
    advance(ORB_TIMINGS.dwellSwitchMs - 100);
    act(() => result.current.rowEnter("s1", 0));
    act(() => result.current.rowEnter("s2", 1));
    advance(ORB_TIMINGS.dwellSwitchMs - 100);
    act(() => result.current.rowLeave());
    advance(ORB_TIMINGS.dwellSwitchMs);
    expect(onDwell).not.toHaveBeenCalled();
    expect(result.current.open).toBe(true);
  });

  it("only highlights rows when switch-on-hover is off", () => {
    const { result, onDwell } = setup({ hovered: true, hoverSwitch: false });
    advance(ORB_TIMINGS.openDelayMs);
    act(() => result.current.rowEnter("s3", 2));
    advance(ORB_TIMINGS.dwellSwitchMs * 2);
    expect(result.current.highlight).toBe(2);
    expect(result.current.dwellId).toBeNull();
    expect(onDwell).not.toHaveBeenCalled();
  });

  it("does not reopen under a resting cursor after closing; needs a fresh hover", () => {
    const { result, update } = setup({ hovered: true });
    advance(ORB_TIMINGS.openDelayMs);
    act(() => result.current.close());
    advance(ORB_TIMINGS.openDelayMs * 3);
    expect(result.current.open).toBe(false);
    update({ hovered: false });
    update({ hovered: true });
    advance(ORB_TIMINGS.openDelayMs);
    expect(result.current.open).toBe(true);
  });
});
