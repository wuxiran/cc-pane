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
});
