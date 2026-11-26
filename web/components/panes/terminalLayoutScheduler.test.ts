import { afterEach, describe, expect, it, vi } from "vitest";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import {
  createTerminalLayoutScheduler,
  isTerminalHostRenderable,
} from "./terminalLayoutScheduler";

type SchedulerOptions = Parameters<typeof createTerminalLayoutScheduler>[0];
type MutableDims = { cols: number; rows: number };

/** 尺寸可变的 host：setSize 之后 getBoundingClientRect 立即反映新尺寸。 */
function createResizableHost(width = 640, height = 360) {
  const size = { width, height };
  const host = document.createElement("div");
  document.body.appendChild(host);
  Object.defineProperty(host, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      width: size.width,
      height: size.height,
      top: 0,
      left: 0,
      right: size.width,
      bottom: size.height,
      x: 0,
      y: 0,
      toJSON: () => {},
    }),
  });
  const setSize = (nextWidth: number, nextHeight: number) => {
    size.width = nextWidth;
    size.height = nextHeight;
  };
  return { host, setSize };
}

function createRenderableHost(width = 640, height = 360): HTMLElement {
  return createResizableHost(width, height).host;
}

function setDims(term: Terminal, cols: number, rows: number) {
  (term as unknown as MutableDims).cols = cols;
  (term as unknown as MutableDims).rows = rows;
}

interface SchedulerFixture extends Partial<SchedulerOptions> {
  term?: Terminal;
  fitAddon?: FitAddon;
  host?: HTMLElement;
}

/**
 * 默认：80x24 终端、仅有 fit 的 FitAddon、640x360 可渲染 host、活跃 pane。
 * 任意 scheduler 选项都可通过 overrides 覆盖。
 */
function makeScheduler({
  term = { cols: 80, rows: 24 } as Terminal,
  fitAddon = { fit: vi.fn() } as unknown as FitAddon,
  host = createRenderableHost(),
  ...overrides
}: SchedulerFixture = {}) {
  const scheduler = createTerminalLayoutScheduler({
    getTerminal: () => term,
    getFitAddon: () => fitAddon,
    getHost: () => host,
    getSessionId: () => "session-1",
    isActive: () => true,
    repaint: vi.fn(),
    resizeBackend: vi.fn(),
    logger: vi.fn(),
    ...overrides,
  });
  return { scheduler, term, fitAddon, host };
}

function createCompositionFrameScheduler() {
  let nextFrameHandle = 1;
  const frameCallbacks = new Map<number, FrameRequestCallback>();
  return {
    compositionFrameScheduler: {
      request: vi.fn((callback: FrameRequestCallback) => {
        const handle = nextFrameHandle++;
        frameCallbacks.set(handle, callback);
        return handle;
      }),
      cancel: vi.fn((handle: number) => frameCallbacks.delete(handle)),
    },
    flushFrame: () => {
      const callbacks = [...frameCallbacks.values()];
      frameCallbacks.clear();
      callbacks.forEach((callback) => callback(0));
    },
  };
}

describe("terminal layout scheduler", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("detects hidden or zero-sized terminal hosts", () => {
    expect(isTerminalHostRenderable(null)).toBe(false);

    const host = createRenderableHost();
    expect(isTerminalHostRenderable(host)).toBe(true);

    host.style.display = "none";
    expect(isTerminalHostRenderable(host)).toBe(false);

    // 有宽度但没有可测高度同样不可渲染。
    expect(isTerminalHostRenderable(createRenderableHost(88, 0))).toBe(false);
  });

  it("does not resize the PTY when Fit proposes a degenerate size", () => {
    const resizeBackend = vi.fn();
    const logger = vi.fn();
    const { scheduler, fitAddon } = makeScheduler({
      fitAddon: {
        proposeDimensions: vi.fn(() => ({ cols: 1, rows: 0 })),
        fit: vi.fn(),
      } as unknown as FitAddon,
      resizeBackend,
      logger,
    });
    expect(scheduler.flush("resize-observer.fit")).toBeNull();
    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(resizeBackend).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith(
      "layout.skip.degenerate",
      expect.objectContaining({ cols: 1, rows: 0 }),
    );
    scheduler.dispose();
  });

  it("refocuses the terminal when fit blurs the helper textarea", () => {
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    const { scheduler, term } = makeScheduler({
      term: {
        cols: 80,
        rows: 24,
        textarea,
        focus: vi.fn(() => textarea.focus()),
      } as unknown as Terminal,
      fitAddon: {
        fit: vi.fn(() => {
          textarea.blur();
        }),
      } as unknown as FitAddon,
    });

    textarea.focus();
    expect(document.activeElement).toBe(textarea);
    scheduler.flush("window.focus", { force: true, forceBackendSync: true });
    expect(term.focus).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(textarea);
    scheduler.dispose();
    textarea.remove();
  });

  it("does not steal focus from another input during window-focus recovery", () => {
    const other = document.createElement("input");
    document.body.appendChild(other);
    const { scheduler, term } = makeScheduler({
      term: {
        cols: 80,
        rows: 24,
        textarea: document.createElement("textarea"),
        focus: vi.fn(),
      } as unknown as Terminal,
    });

    other.focus();
    scheduler.flush("window.focus", { force: true, forceBackendSync: true });
    expect(term.focus).not.toHaveBeenCalled();
    scheduler.dispose();
    other.remove();
  });

  it("fits, repaints, and resizes the backend when visible", () => {
    const term = { cols: 80, rows: 24, focus: vi.fn() } as unknown as Terminal;
    const repaint = vi.fn();
    const resizeBackend = vi.fn();
    const { scheduler, fitAddon } = makeScheduler({
      term,
      fitAddon: { fit: vi.fn(() => setDims(term, 100, 30)) } as unknown as FitAddon,
      repaint,
      resizeBackend,
    });

    expect(scheduler.flush("test", { focusIfSafe: true })).toBe(term);
    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(repaint).toHaveBeenCalledWith("test");
    expect(resizeBackend).toHaveBeenCalledWith(100, 30);
    expect(term.focus).toHaveBeenCalledOnce();
  });

  it("re-sends the current geometry for an explicit Fit even when xterm is unchanged", () => {
    const resizeBackend = vi.fn();
    const { scheduler, fitAddon } = makeScheduler({ resizeBackend });

    scheduler.flush("initial");
    resizeBackend.mockClear();

    scheduler.flush("context-menu.fit", {
      force: true,
      forceBackendSync: true,
    });

    expect(fitAddon.fit).toHaveBeenCalledTimes(2);
    expect(resizeBackend).toHaveBeenCalledTimes(1);
    expect(resizeBackend).toHaveBeenCalledWith(80, 24);
    scheduler.dispose();
  });

  it.each([
    ["the pane is inactive", "inactive", (): SchedulerFixture => ({ isActive: () => false })],
    ["the document is hidden", "minimized", (): SchedulerFixture => {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      return { host: createRenderableHost(1, 1) };
    }],
  ] as const)("defers layout while %s", (_label, reason, setup) => {
    const { scheduler, fitAddon } = makeScheduler(setup());

    expect(scheduler.flush(reason)).toBeNull();
    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(scheduler.hasPendingLayout()).toBe(true);
    scheduler.dispose();
  });

  it("keeps zero-sized hosts dirty and fits once the host becomes visible", () => {
    const { host, setSize } = createResizableHost(0, 0);
    const { scheduler, fitAddon } = makeScheduler({ host, isActive: () => false });

    expect(scheduler.flush("hidden", { allowInactive: true })).toBeNull();
    expect(scheduler.hasPendingLayout()).toBe(true);
    expect(fitAddon.fit).not.toHaveBeenCalled();

    setSize(640, 360);
    scheduler.flush("visible", { allowInactive: true });
    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(scheduler.hasPendingLayout()).toBe(false);
    scheduler.dispose();
  });

  it("retries fit after a collapsed host becomes renderable", () => {
    vi.useFakeTimers();
    const { host, setSize } = createResizableHost(88, 0);
    const { scheduler, fitAddon } = makeScheduler({ host });

    expect(scheduler.flush("session.create.fit", { allowInactive: true })).toBeNull();
    expect(fitAddon.fit).not.toHaveBeenCalled();

    setSize(1112, 1254);
    vi.advanceTimersByTime(200);
    expect(fitAddon.fit).toHaveBeenCalledOnce();
    scheduler.dispose();
  });

  it("blocks layout during IME and skips recovery fit when cols/rows are unchanged", () => {
    vi.useFakeTimers();
    const textarea = document.createElement("textarea");
    const { compositionFrameScheduler, flushFrame } = createCompositionFrameScheduler();
    const repaint = vi.fn();
    const logger = vi.fn();
    const { scheduler, fitAddon } = makeScheduler({
      term: { cols: 80, rows: 24, textarea } as unknown as Terminal,
      fitAddon: {
        fit: vi.fn(),
        proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 })),
      } as unknown as FitAddon,
      compositionFrameScheduler,
      repaint,
      logger,
    });

    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(scheduler.flush("composition.resize", { force: true })).toBeNull();
    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(scheduler.hasPendingLayout()).toBe(true);

    textarea.dispatchEvent(new FocusEvent("blur"));
    flushFrame();
    flushFrame();

    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(repaint).not.toHaveBeenCalled();
    expect(scheduler.hasPendingLayout()).toBe(false);
    expect(logger).toHaveBeenCalledWith(
      "layout.skip.unchanged",
      expect.objectContaining({ reason: "ime.compositionend", cols: 80, rows: 24 }),
    );
    scheduler.dispose();
  });

  it("does not probe dimensions after IME when no layout was deferred", () => {
    vi.useFakeTimers();
    const proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
    const textarea = document.createElement("textarea");
    const { compositionFrameScheduler, flushFrame } = createCompositionFrameScheduler();
    const { scheduler, fitAddon } = makeScheduler({
      term: { cols: 80, rows: 24, textarea } as unknown as Terminal,
      fitAddon: { fit: vi.fn(), proposeDimensions } as unknown as FitAddon,
      compositionFrameScheduler,
    });

    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    textarea.dispatchEvent(new FocusEvent("blur"));
    flushFrame();
    flushFrame();

    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(proposeDimensions).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  it("still fits after IME recovery when proposed dimensions differ", () => {
    vi.useFakeTimers();
    const textarea = document.createElement("textarea");
    const term = { cols: 80, rows: 24, textarea } as unknown as Terminal;
    const { compositionFrameScheduler, flushFrame } = createCompositionFrameScheduler();
    const repaint = vi.fn();
    const { scheduler, fitAddon } = makeScheduler({
      term,
      fitAddon: {
        fit: vi.fn(() => setDims(term, 100, 30)),
        proposeDimensions: vi.fn(() => ({ cols: 100, rows: 30 })),
      } as unknown as FitAddon,
      compositionFrameScheduler,
      repaint,
    });

    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(scheduler.flush("composition.resize", { force: true })).toBeNull();
    textarea.dispatchEvent(new FocusEvent("blur"));
    flushFrame();
    flushFrame();

    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(repaint).toHaveBeenCalledWith("ime.compositionend");
    expect(scheduler.hasPendingLayout()).toBe(false);
    scheduler.dispose();
  });

  it("still fits IME recovery when a backend sync is pending even if size is unchanged", () => {
    vi.useFakeTimers();
    const textarea = document.createElement("textarea");
    const { compositionFrameScheduler, flushFrame } = createCompositionFrameScheduler();
    const resizeBackend = vi.fn();
    const { scheduler, fitAddon } = makeScheduler({
      term: { cols: 80, rows: 24, textarea } as unknown as Terminal,
      fitAddon: {
        fit: vi.fn(),
        proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 })),
      } as unknown as FitAddon,
      compositionFrameScheduler,
      resizeBackend,
    });

    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(scheduler.flush("recovery.fit", { force: true, forceBackendSync: true })).toBeNull();
    textarea.dispatchEvent(new FocusEvent("blur"));
    flushFrame();
    flushFrame();

    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(resizeBackend).toHaveBeenCalledWith(80, 24);
    scheduler.dispose();
  });

  it("can layout a visible inactive pane when explicitly allowed", () => {
    const onAfterLayout = vi.fn();
    const { scheduler, term, fitAddon } = makeScheduler({
      term: { cols: 80, rows: 24, focus: vi.fn() } as unknown as Terminal,
      isActive: () => false,
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
    const { scheduler, fitAddon } = makeScheduler();

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
    let active = true;
    const { scheduler, fitAddon } = makeScheduler({ isActive: () => active });

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

  it.each([
    ["an active pane", true, undefined],
    ["an inactive pane (keeps allowInactive permission)", false, { allowInactive: true }],
  ] as const)("verify pass refits once on a dimension mismatch for %s", (_label, active, request) => {
    vi.useFakeTimers();
    const term = { cols: 80, rows: 24 } as Terminal;
    let proposed = { cols: 100, rows: 30 };
    const { scheduler, fitAddon } = makeScheduler({
      term,
      fitAddon: {
        fit: vi.fn(() => setDims(term, proposed.cols, proposed.rows)),
        proposeDimensions: vi.fn(() => proposed),
      } as unknown as FitAddon,
      isActive: () => active,
    });

    scheduler.flush("initial", request);
    expect(fitAddon.fit).toHaveBeenCalledTimes(1);

    // fit 之后布局又变了一轮（模拟嵌套分屏二次 reflow）。
    proposed = { cols: 90, rows: 28 };
    vi.advanceTimersByTime(200);
    expect(fitAddon.fit).toHaveBeenCalledTimes(2);
    expect(term.cols).toBe(90);
    expect(term.rows).toBe(28);

    // verify 补救后尺寸一致，不再无限重复。
    vi.advanceTimersByTime(500);
    expect(fitAddon.fit).toHaveBeenCalledTimes(2);
  });

  it("debounces rapid backend resizes to leading and trailing sends", () => {
    vi.useFakeTimers();
    vi.setSystemTime(60_000);
    const term = { cols: 80, rows: 24 } as Terminal;
    const resizeBackend = vi.fn();
    const { scheduler } = makeScheduler({
      term,
      fitAddon: {
        fit: vi.fn(),
        proposeDimensions: vi.fn(() => ({ cols: term.cols, rows: term.rows })),
      } as unknown as FitAddon,
      resizeBackend,
    });

    // leading：距上次足够久，立即下发。
    scheduler.flush("drag-1");
    expect(resizeBackend).toHaveBeenCalledWith(80, 24);
    expect(resizeBackend).toHaveBeenCalledTimes(1);

    // 拖拽期间连续变化：不立即下发，只记最新值。
    setDims(term, 90, 26);
    vi.advanceTimersByTime(50);
    scheduler.flush("drag-2");
    setDims(term, 100, 30);
    vi.advanceTimersByTime(50);
    scheduler.flush("drag-3");
    expect(resizeBackend).toHaveBeenCalledTimes(1);

    // trailing：只发最终尺寸。
    vi.advanceTimersByTime(300);
    expect(resizeBackend).toHaveBeenCalledTimes(2);
    expect(resizeBackend).toHaveBeenLastCalledWith(100, 30);
  });

  it("fits a mirror view without resizing the shared backend PTY", () => {
    const resizeBackend = vi.fn();
    const { scheduler, term, fitAddon } = makeScheduler({
      term: { cols: 100, rows: 30 } as Terminal,
      getSessionId: () => "shared-session",
      canResizeBackend: () => false,
      resizeBackend,
    });

    expect(scheduler.flush("mirror.fit")).toBe(term);
    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(resizeBackend).not.toHaveBeenCalled();
  });
});
