import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TERMINAL_LAYOUT_CHANGED_EVENT } from "@/lib/paneTree";
import {
  didLayoutBecomeVisible,
  useTerminalLayoutEvents,
} from "./useTerminalLayoutEvents";

describe("didLayoutBecomeVisible", () => {
  it("is true only on the hidden → visible edge", () => {
    expect(didLayoutBecomeVisible(false, true)).toBe(true);
    expect(didLayoutBecomeVisible(true, true)).toBe(false);
    expect(didLayoutBecomeVisible(undefined, true)).toBe(false);
    expect(didLayoutBecomeVisible(true, false)).toBe(false);
  });
});

describe("useTerminalLayoutEvents", () => {
  it("refits and refreshes display when the layout-changed event fires on an active layout", () => {
    const schedule = vi.fn();
    const refreshDisplay = vi.fn();
    const layoutActiveRef = { current: true };
    renderHook(() =>
      useTerminalLayoutEvents({
        layoutActive: true,
        layoutActiveRef,
        layoutSchedulerRef: { current: { schedule } as never },
        refreshDisplay,
        debugLog: vi.fn(),
      }),
    );

    window.dispatchEvent(
      new CustomEvent(TERMINAL_LAYOUT_CHANGED_EVENT, { detail: { reason: "layout.switch" } }),
    );

    expect(schedule).toHaveBeenCalledWith("layout-change.layout.switch", {
      force: true,
      allowInactive: true,
    });
    expect(refreshDisplay).toHaveBeenCalledWith("layout-change.layout.switch");
  });

  it("refreshes display when a hidden layout becomes the current one", () => {
    const schedule = vi.fn();
    const refreshDisplay = vi.fn();
    const layoutActiveRef = { current: false };
    const { rerender } = renderHook(
      ({ layoutActive }: { layoutActive: boolean }) =>
        useTerminalLayoutEvents({
          layoutActive,
          layoutActiveRef,
          layoutSchedulerRef: { current: { schedule } as never },
          refreshDisplay,
          debugLog: vi.fn(),
        }),
      { initialProps: { layoutActive: false } },
    );

    expect(refreshDisplay).not.toHaveBeenCalled();
    layoutActiveRef.current = true;
    rerender({ layoutActive: true });

    expect(schedule).toHaveBeenCalledWith("layout.activated", {
      force: true,
      allowInactive: true,
    });
    expect(refreshDisplay).toHaveBeenCalledWith("layout.activated");
  });
});
