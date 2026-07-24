import { describe, expect, it, vi } from "vitest";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import {
  createTerminalLayoutScheduler,
  isTerminalHostRenderable,
} from "./terminalLayoutScheduler";

function createRenderableHost(width = 640, height = 360): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  Object.defineProperty(host, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      width,
      height,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => {},
    }),
  });
  return host;
}

describe("terminal layout scheduler", () => {
  it("detects hidden or zero-sized terminal hosts", () => {
    expect(isTerminalHostRenderable(null)).toBe(false);

    const host = createRenderableHost();
    expect(isTerminalHostRenderable(host)).toBe(true);

    host.style.display = "none";
    expect(isTerminalHostRenderable(host)).toBe(false);
  });

  it("fits, repaints, and resizes the backend when visible", () => {
    const host = createRenderableHost();
    const term = {
      cols: 80,
      rows: 24,
      focus: vi.fn(),
    } as unknown as Terminal;
    const fitAddon = {
      fit: vi.fn(() => {
        (term as unknown as { cols: number; rows: number }).cols = 100;
        (term as unknown as { cols: number; rows: number }).rows = 30;
      }),
    } as unknown as FitAddon;
    const repaint = vi.fn();
    const resizeBackend = vi.fn();

    const scheduler = createTerminalLayoutScheduler({
      getTerminal: () => term,
      getFitAddon: () => fitAddon,
      getHost: () => host,
      getSessionId: () => "session-1",
      isActive: () => true,
      repaint,
      resizeBackend,
      logger: vi.fn(),
    });

    expect(scheduler.flush("test", { focusIfSafe: true })).toBe(term);
    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(repaint).toHaveBeenCalledWith("test");
    expect(resizeBackend).toHaveBeenCalledWith(100, 30);
    expect(term.focus).toHaveBeenCalledOnce();
  });

  it("defers layout when inactive", () => {
    const host = createRenderableHost();
    const fitAddon = { fit: vi.fn() } as unknown as FitAddon;

    const scheduler = createTerminalLayoutScheduler({
      getTerminal: () => ({ cols: 80, rows: 24 } as Terminal),
      getFitAddon: () => fitAddon,
      getHost: () => host,
      getSessionId: () => "session-1",
      isActive: () => false,
      repaint: vi.fn(),
      resizeBackend: vi.fn(),
      logger: vi.fn(),
    });

    expect(scheduler.flush("inactive")).toBeNull();
    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(scheduler.hasPendingLayout()).toBe(true);
  });

  it("keeps zero-sized hosts dirty and fits once the host becomes visible", () => {
    const host = createRenderableHost(0, 0);
    const fitAddon = { fit: vi.fn() } as unknown as FitAddon;
    let width = 0;
    let height = 0;
    Object.defineProperty(host, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        width,
        height,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        x: 0,
        y: 0,
        toJSON: () => {},
      }),
    });
    const scheduler = createTerminalLayoutScheduler({
      getTerminal: () => ({ cols: 80, rows: 24 } as Terminal),
      getFitAddon: () => fitAddon,
      getHost: () => host,
      getSessionId: () => "session-1",
      isActive: () => false,
      repaint: vi.fn(),
      resizeBackend: vi.fn(),
      logger: vi.fn(),
    });

    expect(scheduler.flush("hidden", { allowInactive: true })).toBeNull();
    expect(scheduler.hasPendingLayout()).toBe(true);
    expect(fitAddon.fit).not.toHaveBeenCalled();

    width = 640;
    height = 360;
    scheduler.flush("visible", { allowInactive: true });
    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(scheduler.hasPendingLayout()).toBe(false);
  });

  it("can layout a visible inactive pane when explicitly allowed", () => {
    const host = createRenderableHost();
    const term = { cols: 80, rows: 24, focus: vi.fn() } as unknown as Terminal;
    const fitAddon = { fit: vi.fn() } as unknown as FitAddon;
    const onAfterLayout = vi.fn();

    const scheduler = createTerminalLayoutScheduler({
      getTerminal: () => term,
      getFitAddon: () => fitAddon,
      getHost: () => host,
      getSessionId: () => "session-1",
      isActive: () => false,
      repaint: vi.fn(),
      resizeBackend: vi.fn(),
      logger: vi.fn(),
    });

    expect(scheduler.flush("inactive-visible", {
      allowInactive: true,
      onAfterLayout,
    })).toBe(term);
    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(onAfterLayout).toHaveBeenCalledWith(term);
    expect(term.focus).not.toHaveBeenCalled();
    expect(scheduler.hasPendingLayout()).toBe(false);
  });

  it("can force a layout even when the container delta is below the jitter threshold", () => {
    const host = createRenderableHost();
    const term = { cols: 80, rows: 24 } as Terminal;
    const fitAddon = { fit: vi.fn() } as unknown as FitAddon;
    const scheduler = createTerminalLayoutScheduler({
      getTerminal: () => term,
      getFitAddon: () => fitAddon,
      getHost: () => host,
      getSessionId: () => "session-1",
      isActive: () => true,
      repaint: vi.fn(),
      resizeBackend: vi.fn(),
      logger: vi.fn(),
    });

    scheduler.flush("first", {
      containerSize: { width: 640, height: 360 },
      minContainerDelta: 5,
    });
    scheduler.flush("jitter", {
      containerSize: { width: 642, height: 362 },
      minContainerDelta: 5,
    });
    scheduler.flush("forced", {
      force: true,
      containerSize: { width: 643, height: 363 },
      minContainerDelta: 5,
    });

    expect(fitAddon.fit).toHaveBeenCalledTimes(2);
  });

  it("does not advance the jitter baseline when the fit is skipped", () => {
    const host = createRenderableHost();
    const term = { cols: 80, rows: 24 } as Terminal;
    const fitAddon = { fit: vi.fn() } as unknown as FitAddon;
    let active = true;
    const scheduler = createTerminalLayoutScheduler({
      getTerminal: () => term,
      getFitAddon: () => fitAddon,
      getHost: () => host,
      getSessionId: () => "session-1",
      isActive: () => active,
      repaint: vi.fn(),
      resizeBackend: vi.fn(),
      logger: vi.fn(),
    });

    scheduler.flush("first", {
      containerSize: { width: 640, height: 360 },
      minContainerDelta: 5,
    });
    expect(fitAddon.fit).toHaveBeenCalledTimes(1);

    // 尺寸大幅变化但 pane 不活跃：fit 被跳过，基线必须停在 640。
    active = false;
    scheduler.flush("inactive-resize", {
      containerSize: { width: 700, height: 360 },
      minContainerDelta: 5,
    });
    expect(fitAddon.fit).toHaveBeenCalledTimes(1);

    // 激活后同尺寸再来一次：相对旧基线 delta=60，不能被抖动阈值吞掉。
    active = true;
    scheduler.flush("active-resize", {
      containerSize: { width: 700, height: 360 },
      minContainerDelta: 5,
    });
    expect(fitAddon.fit).toHaveBeenCalledTimes(2);
  });

  it("refits once when the verify pass finds a dimension mismatch", () => {
    vi.useFakeTimers();
    try {
      const host = createRenderableHost();
      const term = { cols: 80, rows: 24 } as Terminal;
      let proposed = { cols: 100, rows: 30 };
      const fitAddon = {
        fit: vi.fn(() => {
          (term as unknown as { cols: number; rows: number }).cols = proposed.cols;
          (term as unknown as { cols: number; rows: number }).rows = proposed.rows;
        }),
        proposeDimensions: vi.fn(() => proposed),
      } as unknown as FitAddon;
      const scheduler = createTerminalLayoutScheduler({
        getTerminal: () => term,
        getFitAddon: () => fitAddon,
        getHost: () => host,
        getSessionId: () => "session-1",
        isActive: () => true,
        repaint: vi.fn(),
        resizeBackend: vi.fn(),
        logger: vi.fn(),
      });

      scheduler.flush("initial");
      expect(fitAddon.fit).toHaveBeenCalledTimes(1);

      // fit 之后布局又变了一轮（模拟嵌套分屏二次 reflow）。
      proposed = { cols: 90, rows: 28 };
      vi.advanceTimersByTime(200);
      expect(fitAddon.fit).toHaveBeenCalledTimes(2);
      expect(term.cols).toBe(90);

      // verify 补救后尺寸一致，不再无限重复。
      vi.advanceTimersByTime(500);
      expect(fitAddon.fit).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps inactive-pane permission for the verify refit", () => {
    vi.useFakeTimers();
    try {
      const host = createRenderableHost();
      const term = { cols: 80, rows: 24 } as Terminal;
      let proposed = { cols: 100, rows: 30 };
      const fitAddon = {
        fit: vi.fn(() => {
          (term as unknown as { cols: number; rows: number }).cols = proposed.cols;
          (term as unknown as { cols: number; rows: number }).rows = proposed.rows;
        }),
        proposeDimensions: vi.fn(() => proposed),
      } as unknown as FitAddon;
      const scheduler = createTerminalLayoutScheduler({
        getTerminal: () => term,
        getFitAddon: () => fitAddon,
        getHost: () => host,
        getSessionId: () => "session-1",
        isActive: () => false,
        repaint: vi.fn(),
        resizeBackend: vi.fn(),
        logger: vi.fn(),
      });

      scheduler.flush("inactive-pane", { allowInactive: true });
      proposed = { cols: 90, rows: 28 };
      vi.advanceTimersByTime(200);

      expect(fitAddon.fit).toHaveBeenCalledTimes(2);
      expect(term.cols).toBe(90);
      expect(term.rows).toBe(28);
    } finally {
      vi.useRealTimers();
    }
  });

  it("debounces rapid backend resizes to leading and trailing sends", () => {
    vi.useFakeTimers();
    vi.setSystemTime(60_000);
    try {
      const host = createRenderableHost();
      const term = { cols: 80, rows: 24 } as Terminal;
      const setDims = (cols: number, rows: number) => {
        (term as unknown as { cols: number; rows: number }).cols = cols;
        (term as unknown as { cols: number; rows: number }).rows = rows;
      };
      const fitAddon = {
        fit: vi.fn(),
        proposeDimensions: vi.fn(() => ({ cols: term.cols, rows: term.rows })),
      } as unknown as FitAddon;
      const resizeBackend = vi.fn();
      const scheduler = createTerminalLayoutScheduler({
        getTerminal: () => term,
        getFitAddon: () => fitAddon,
        getHost: () => host,
        getSessionId: () => "session-1",
        isActive: () => true,
        repaint: vi.fn(),
        resizeBackend,
        logger: vi.fn(),
      });

      // leading：距上次足够久，立即下发。
      scheduler.flush("drag-1");
      expect(resizeBackend).toHaveBeenCalledWith(80, 24);
      expect(resizeBackend).toHaveBeenCalledTimes(1);

      // 拖拽期间连续变化：不立即下发，只记最新值。
      setDims(90, 26);
      vi.advanceTimersByTime(50);
      scheduler.flush("drag-2");
      setDims(100, 30);
      vi.advanceTimersByTime(50);
      scheduler.flush("drag-3");
      expect(resizeBackend).toHaveBeenCalledTimes(1);

      // trailing：只发最终尺寸。
      vi.advanceTimersByTime(300);
      expect(resizeBackend).toHaveBeenCalledTimes(2);
      expect(resizeBackend).toHaveBeenLastCalledWith(100, 30);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fits a mirror view without resizing the shared backend PTY", () => {
    const host = createRenderableHost();
    const term = { cols: 100, rows: 30 } as Terminal;
    const fitAddon = { fit: vi.fn() } as unknown as FitAddon;
    const resizeBackend = vi.fn();
    const scheduler = createTerminalLayoutScheduler({
      getTerminal: () => term,
      getFitAddon: () => fitAddon,
      getHost: () => host,
      getSessionId: () => "shared-session",
      isActive: () => true,
      canResizeBackend: () => false,
      repaint: vi.fn(),
      resizeBackend,
      logger: vi.fn(),
    });

    expect(scheduler.flush("mirror.fit")).toBe(term);
    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(resizeBackend).not.toHaveBeenCalled();
  });
});
