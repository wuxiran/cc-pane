import { afterEach, describe, expect, it, vi } from "vitest";

import { setDragging } from "@/stores/splitDragState";
import type { TerminalLayoutScheduler } from "../terminalLayoutScheduler";
import { createTerminalResizeObserver } from "./terminalResizeObserver";

type ObserverCallback = ConstructorParameters<typeof ResizeObserver>[0];

function harness({ mounted = true }: { mounted?: boolean } = {}) {
  let callback: ObserverCallback | null = null;
  class FakeResizeObserver {
    constructor(cb: ObserverCallback) {
      callback = cb;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);

  const layoutScheduler = {
    schedule: vi.fn(),
    flush: vi.fn(),
  };
  const layoutSchedulerRef = {
    current: layoutScheduler as unknown as TerminalLayoutScheduler,
  };
  const lastDragFitAtRef = { current: 0 };
  createTerminalResizeObserver({
    isMounted: () => mounted,
    layoutSchedulerRef,
    lastDragFitAtRef,
  });
  const fire = (width: number, height: number) => {
    callback?.(
      [{ contentRect: { width, height } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
  };
  return { layoutScheduler, lastDragFitAtRef, fire };
}

describe("createTerminalResizeObserver", () => {
  afterEach(() => {
    setDragging(false);
    vi.unstubAllGlobals();
  });

  it("schedules a debounced fit for normal container changes", () => {
    const { layoutScheduler, fire } = harness();
    fire(800, 600);
    expect(layoutScheduler.schedule).toHaveBeenCalledTimes(1);
    expect(layoutScheduler.schedule).toHaveBeenCalledWith("resize-observer.fit", {
      delayMs: 150,
      containerSize: { width: 800, height: 600 },
      minContainerDelta: 5,
      allowInactive: true,
    });
    expect(layoutScheduler.flush).not.toHaveBeenCalled();
  });

  it("does nothing once unmounted", () => {
    const { layoutScheduler, fire } = harness({ mounted: false });
    fire(800, 600);
    expect(layoutScheduler.schedule).not.toHaveBeenCalled();
    expect(layoutScheduler.flush).not.toHaveBeenCalled();
  });

  it("flushes immediately but throttled while dragging", () => {
    setDragging(true);
    const { layoutScheduler, lastDragFitAtRef, fire } = harness();
    fire(800, 600);
    expect(layoutScheduler.flush).toHaveBeenCalledTimes(1);
    expect(layoutScheduler.flush).toHaveBeenCalledWith("resize-observer.drag.fit", {
      containerSize: { width: 800, height: 600 },
      minContainerDelta: 20,
      allowInactive: true,
    });
    expect(layoutScheduler.schedule).not.toHaveBeenCalled();
    expect(lastDragFitAtRef.current).toBeGreaterThan(0);

    // 80ms 节流窗口内的第二次拖动变更被丢弃。
    fire(820, 600);
    expect(layoutScheduler.flush).toHaveBeenCalledTimes(1);
  });
});
