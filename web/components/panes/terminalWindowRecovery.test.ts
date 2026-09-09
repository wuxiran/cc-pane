import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTerminalLayoutScheduler } from "./terminalLayoutScheduler";
import { bindTerminalWindowRecovery } from "./terminalWindowRecovery";

const cleanups: (() => void)[] = [];

function setup({ mirror = false, webgl = false } = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  host.getBoundingClientRect = () => ({ width: 960, height: 480 } as DOMRect);
  const term = { cols: 120, rows: 30, focus: vi.fn() } as unknown as Terminal;
  const fit = {
    fit: vi.fn(),
    proposeDimensions: () => ({ cols: term.cols, rows: term.rows }),
  };
  const resizeBackend = vi.fn();
  const repaint = vi.fn();
  const scheduler = createTerminalLayoutScheduler({
    getTerminal: () => term,
    getFitAddon: () => fit as unknown as FitAddon,
    getHost: () => host,
    getSessionId: () => "session-1",
    // 模拟当前布局里可见但未聚焦的分屏，同样需要恢复。
    isActive: () => false,
    canResizeBackend: () => !mirror,
    resizeBackend,
    repaint,
    logger: vi.fn(),
  });
  scheduler.flush("initial", { allowInactive: true });
  resizeBackend.mockClear();
  fit.fit.mockClear();
  repaint.mockClear();
  const isRenderVisible = vi.fn(() => true);
  const scheduleWebglRecovery = vi.fn();
  const bind = () => bindTerminalWindowRecovery({
    isRenderVisible,
    getLayoutScheduler: () => scheduler,
    repaint,
    getLastDevicePixelRatio: () => 1,
    shouldRunWebglRecovery: () => webgl,
    scheduleWebglRecovery,
  });
  const dispose = bind();
  cleanups.push(() => { dispose(); scheduler.dispose(); host.remove(); });
  return { term, fit, scheduler, resizeBackend, repaint, isRenderVisible, scheduleWebglRecovery, dispose };
}

describe("terminal window recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(1);
  });

  afterEach(() => {
    cleanups.splice(0).forEach((dispose) => dispose());
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("refits a visible DOM terminal and resends unchanged geometry after focus returns", () => {
    const { fit, resizeBackend, repaint, term } = setup();
    window.dispatchEvent(new Event("focus"));
    expect(fit.fit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(fit.fit).toHaveBeenCalledOnce();
    expect(resizeBackend).toHaveBeenCalledExactlyOnceWith(120, 30);
    expect(repaint).toHaveBeenCalledWith("window.focus");
    expect(term.focus).not.toHaveBeenCalled();
  });

  it("coalesces focus and visibility events into one repair", () => {
    const { resizeBackend } = setup();
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(50);
    expect(resizeBackend).toHaveBeenCalledExactlyOnceWith(120, 30);
  });

  it("retains backend synchronization when a resize event replaces the queued recovery", () => {
    const { resizeBackend } = setup();
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(50);
    expect(resizeBackend).toHaveBeenCalledExactlyOnceWith(120, 30);
  });

  it("retains recovery through a debounced ResizeObserver container-jitter request", () => {
    const { resizeBackend, scheduler } = setup();
    document.dispatchEvent(new Event("visibilitychange"));
    scheduler.schedule("resize-observer.fit", {
      delayMs: 150,
      containerSize: { width: 961, height: 480 },
      minContainerDelta: 5,
      allowInactive: true,
    });
    vi.advanceTimersByTime(200);
    expect(resizeBackend).toHaveBeenCalledExactlyOnceWith(120, 30);
  });

  it("keeps recovery authorized for an unfocused pane when another layout request follows", () => {
    const { resizeBackend, scheduler } = setup();
    window.dispatchEvent(new Event("focus"));
    scheduler.schedule("fonts.loadingdone", { force: true });
    vi.advanceTimersByTime(50);
    expect(resizeBackend).toHaveBeenCalledExactlyOnceWith(120, 30);
  });

  it("recovers DOM geometry after a suspended timer resumes without a focus event", () => {
    const { resizeBackend, scheduleWebglRecovery } = setup();
    vi.setSystemTime(Date.now() + 120_000);
    vi.advanceTimersByTime(30_050);
    expect(resizeBackend).toHaveBeenCalledExactlyOnceWith(120, 30);
    expect(scheduleWebglRecovery).not.toHaveBeenCalled();
  });

  it("also recreates WebGL after a sleep gap", () => {
    const { resizeBackend, scheduleWebglRecovery } = setup({ webgl: true });
    vi.setSystemTime(Date.now() + 120_000);
    vi.advanceTimersByTime(30_050);
    expect(resizeBackend).toHaveBeenCalledExactlyOnceWith(120, 30);
    expect(scheduleWebglRecovery).toHaveBeenCalledWith("heartbeat.resume-gap", { forceRecreate: true });
  });

  it("still refits when DPR changes instead of returning through the WebGL-only path", () => {
    const { resizeBackend, scheduleWebglRecovery } = setup();
    vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(2);
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(50);
    expect(resizeBackend).toHaveBeenCalledExactlyOnceWith(120, 30);
    expect(scheduleWebglRecovery).toHaveBeenCalledWith("window.focus.dpr-change");
  });

  it("only fits a mirror locally without resizing its shared PTY", () => {
    const { fit, resizeBackend, repaint } = setup({ mirror: true });
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(50);
    expect(fit.fit).toHaveBeenCalledOnce();
    expect(repaint).toHaveBeenCalledWith("window.focus");
    expect(resizeBackend).not.toHaveBeenCalled();
  });

  it.each(["document", "view"])("does not recover a hidden %s", (hidden) => {
    const { fit, isRenderVisible, resizeBackend, repaint } = setup();
    if (hidden === "document") {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    } else {
      isRenderVisible.mockReturnValue(false);
    }
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("resize"));
    document.dispatchEvent(new Event("visibilitychange"));
    vi.setSystemTime(Date.now() + 120_000);
    vi.advanceTimersByTime(30_050);
    expect(fit.fit).not.toHaveBeenCalled();
    expect(resizeBackend).not.toHaveBeenCalled();
    expect(repaint).not.toHaveBeenCalled();
  });

  it("does not repeatedly fit or recreate on normal heartbeats", () => {
    const { fit, resizeBackend, repaint, scheduleWebglRecovery } = setup({ webgl: true });
    vi.advanceTimersByTime(90_000);
    expect(repaint).toHaveBeenCalledTimes(3);
    expect(fit.fit).not.toHaveBeenCalled();
    expect(resizeBackend).not.toHaveBeenCalled();
    expect(scheduleWebglRecovery).not.toHaveBeenCalled();
  });

  it("removes window listeners and the heartbeat on dispose", () => {
    const { dispose, fit, repaint } = setup({ webgl: true });
    dispose();
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("resize"));
    document.dispatchEvent(new Event("visibilitychange"));
    vi.setSystemTime(Date.now() + 120_000);
    vi.advanceTimersByTime(30_050);
    expect(fit.fit).not.toHaveBeenCalled();
    expect(repaint).not.toHaveBeenCalled();
  });
});
