import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

type LayoutLogger = (event: string, payload?: Record<string, unknown>) => void;

export interface TerminalContainerSize {
  width: number;
  height: number;
}

export interface TerminalLayoutRequestOptions {
  focusIfSafe?: boolean;
  delayMs?: number;
  containerSize?: TerminalContainerSize;
  minContainerDelta?: number;
  force?: boolean;
  allowInactive?: boolean;
  onAfterLayout?: (term: Terminal) => void;
}

export interface TerminalLayoutScheduler {
  schedule: (reason: string, options?: TerminalLayoutRequestOptions) => void;
  flush: (reason: string, options?: TerminalLayoutRequestOptions) => Terminal | null;
  cancel: () => void;
  dispose: () => void;
  hasPendingLayout: () => boolean;
}

interface CreateTerminalLayoutSchedulerOptions {
  getTerminal: () => Terminal | null;
  getFitAddon: () => FitAddon | null;
  getHost: () => HTMLElement | null;
  getSessionId: () => string | null;
  isActive: () => boolean;
  /** 共享 PTY 只允许主视图驱动后端尺寸；镜像视图仍可本地 fit。 */
  canResizeBackend?: () => boolean;
  repaint: (reason: string) => void;
  resizeBackend: (cols: number, rows: number) => void;
  logger: LayoutLogger;
}

export function isTerminalHostRenderable(host: HTMLElement | null): boolean {
  if (!host || !host.isConnected) return false;

  const style = window.getComputedStyle(host);
  if (style.display === "none" || style.visibility === "hidden") return false;

  const rect = host.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function requestFrame(callback: FrameRequestCallback): number {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    return window.requestAnimationFrame(callback);
  }
  return window.setTimeout(() => callback(performance.now()), 0);
}

function cancelFrame(id: number): void {
  if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(id);
    return;
  }
  window.clearTimeout(id);
}

function shouldFocusTerminal(): boolean {
  const active = document.activeElement;
  if (!active) return true;
  return active.tagName !== "INPUT" && active.tagName !== "TEXTAREA";
}

/** fit 后延迟校验容器与 cols/rows 是否仍一致（嵌套分屏可能有第二轮 reflow）。 */
const VERIFY_REFIT_DELAY_MS = 120;
const VERIFY_REFIT_REASON = "verify.refit";
/** verify 未收敛时的有限重试上限，防止持续 reflow 下无限自链。 */
const VERIFY_REFIT_MAX_ATTEMPTS = 3;
/** 后端 PTY resize 去抖窗口：拖拽期间 conpty 每次 resize 都整屏重绘，高频下发会留残行。 */
const BACKEND_RESIZE_DEBOUNCE_MS = 250;

export function createTerminalLayoutScheduler({
  getTerminal,
  getFitAddon,
  getHost,
  getSessionId,
  isActive,
  canResizeBackend = () => true,
  repaint,
  resizeBackend,
  logger,
}: CreateTerminalLayoutSchedulerOptions): TerminalLayoutScheduler {
  let rafId: number | null = null;
  let nestedRafId: number | null = null;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let verifyTimerId: ReturnType<typeof setTimeout> | null = null;
  let backendTimerId: ReturnType<typeof setTimeout> | null = null;
  let lastBackendResizeAt = 0;
  let pendingBackendSize: { cols: number; rows: number } | null = null;
  let disposed = false;
  let pendingReason: string | null = null;
  let lastSize: { cols: number; rows: number } | null = null;
  let lastContainerSize: TerminalContainerSize | null = null;
  let verifyAttempts = 0;

  const cancel = () => {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    if (rafId !== null) {
      cancelFrame(rafId);
      rafId = null;
    }
    if (nestedRafId !== null) {
      cancelFrame(nestedRafId);
      nestedRafId = null;
    }
  };

  // 只比较不推进基线：基线在 fit 成功后统一更新，避免"基线先走、fit 被跳过"
  // 之后小幅修正被永久吞掉的卡死。
  const shouldSkipContainerDelta = (options: TerminalLayoutRequestOptions): boolean => {
    if (options.force || !options.containerSize || !options.minContainerDelta) return false;
    if (!lastContainerSize) return false;

    const size = options.containerSize;
    const deltaWidth = Math.abs(size.width - lastContainerSize.width);
    const deltaHeight = Math.abs(size.height - lastContainerSize.height);
    if (
      deltaWidth < options.minContainerDelta &&
      deltaHeight < options.minContainerDelta
    ) {
      logger("layout.skip.container-jitter", {
        width: size.width,
        height: size.height,
        deltaWidth,
        deltaHeight,
      });
      return true;
    }

    return false;
  };

  const sendBackendResize = (cols: number, rows: number) => {
    if (disposed || !getSessionId()) return;
    lastBackendResizeAt = Date.now();
    pendingBackendSize = null;
    resizeBackend(cols, rows);
  };

  // leading+trailing 去抖：间隔够久立即发（普通 resize 无感），
  // 拖拽等高频场景只发最终尺寸。
  const scheduleBackendResize = (cols: number, rows: number) => {
    const elapsed = Date.now() - lastBackendResizeAt;
    if (backendTimerId === null && elapsed >= BACKEND_RESIZE_DEBOUNCE_MS) {
      sendBackendResize(cols, rows);
      return;
    }

    pendingBackendSize = { cols, rows };
    if (backendTimerId !== null) return;
    backendTimerId = setTimeout(() => {
      backendTimerId = null;
      const pending = pendingBackendSize;
      if (pending) {
        logger("layout.resize.trailing", pending);
        sendBackendResize(pending.cols, pending.rows);
      }
    }, BACKEND_RESIZE_DEBOUNCE_MS);
  };

  const applyLayout = (
    reason: string,
    options: TerminalLayoutRequestOptions = {},
  ): Terminal | null => {
    if (disposed) return null;
    if (shouldSkipContainerDelta(options)) return null;

    const term = getTerminal();
    const fitAddon = getFitAddon();
    const host = getHost();
    if (!term || !fitAddon || !host) return null;

    if (!isActive() && !options.allowInactive) {
      pendingReason = reason;
      logger("layout.skip.inactive", { reason });
      return null;
    }

    const rect = host.getBoundingClientRect();
    if (!isTerminalHostRenderable(host)) {
      pendingReason = reason;
      logger("layout.skip.not-renderable", {
        reason,
        isConnected: host.isConnected,
        width: rect.width,
        height: rect.height,
      });
      return null;
    }

    try {
      fitAddon.fit();
    } catch (error) {
      logger("layout.fit.fail", {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    repaint(reason);

    if (options.focusIfSafe && shouldFocusTerminal()) {
      term.focus();
    }

    const { cols, rows } = term;
    if (lastSize?.cols !== cols || lastSize?.rows !== rows) {
      lastSize = { cols, rows };
      if (getSessionId() && canResizeBackend()) {
        scheduleBackendResize(cols, rows);
      }
    }

    // 无条件用实测 rect 推进基线：让 jitter 基线始终等于"上次实际 fit 的容器"，
    // 避免 forced flush 后基线陈旧、后续小幅修正被 minContainerDelta 吞掉。
    lastContainerSize = { width: rect.width, height: rect.height };

    pendingReason = null;
    logger("layout.applied", {
      reason,
      cols,
      rows,
      width: rect.width,
      height: rect.height,
      sessionId: getSessionId(),
    });
    options.onAfterLayout?.(term);
    if (reason !== VERIFY_REFIT_REASON) {
      verifyAttempts = 0;
      scheduleVerifyRefit();
    } else if (verifyAttempts < VERIFY_REFIT_MAX_ATTEMPTS) {
      // verify 补救后再复核一轮，未收敛可有限重试（多轮 reflow 场景）。
      scheduleVerifyRefit();
    }
    return term;
  };

  // fit 是事件驱动的单次执行；嵌套分屏在 fit 后可能还有一轮 reflow，
  // 之后 ResizeObserver 不再触发，终端会永久停在旧 cols/rows。
  // 延迟一拍复核 proposeDimensions，与实际不一致就强制补一次 fit（每轮最多一次）。
  const scheduleVerifyRefit = () => {
    if (verifyTimerId !== null) {
      clearTimeout(verifyTimerId);
    }
    verifyTimerId = setTimeout(() => {
      verifyTimerId = null;
      if (disposed) return;
      const term = getTerminal();
      const fitAddon = getFitAddon();
      if (!term || !fitAddon || !isTerminalHostRenderable(getHost())) return;

      let proposed: { cols: number; rows: number } | undefined;
      try {
        proposed = fitAddon.proposeDimensions();
      } catch {
        return;
      }
      if (!proposed || proposed.cols <= 0 || proposed.rows <= 0) return;
      if (proposed.cols === term.cols && proposed.rows === term.rows) return;

      logger("layout.verify.mismatch", {
        cols: term.cols,
        rows: term.rows,
        proposedCols: proposed.cols,
        proposedRows: proposed.rows,
        attempt: verifyAttempts + 1,
      });
      verifyAttempts += 1;
      // A successful inactive-pane fit was explicitly authorized by the caller.
      // Keep that permission for the post-reflow verification pass.
      applyLayout(VERIFY_REFIT_REASON, { force: true, allowInactive: true });
    }, VERIFY_REFIT_DELAY_MS);
  };

  const schedule = (
    reason: string,
    options: TerminalLayoutRequestOptions = {},
  ) => {
    if (disposed) return;
    cancel();

    const run = () => {
      rafId = requestFrame(() => {
        nestedRafId = requestFrame(() => {
          rafId = null;
          nestedRafId = null;
          applyLayout(reason, options);
        });
      });
    };

    if (options.delayMs && options.delayMs > 0) {
      timerId = setTimeout(() => {
        timerId = null;
        run();
      }, options.delayMs);
      return;
    }

    run();
  };

  return {
    schedule,
    flush: (reason, options) => {
      cancel();
      return applyLayout(reason, options);
    },
    cancel,
    dispose: () => {
      disposed = true;
      cancel();
      if (verifyTimerId !== null) {
        clearTimeout(verifyTimerId);
        verifyTimerId = null;
      }
      if (backendTimerId !== null) {
        clearTimeout(backendTimerId);
        backendTimerId = null;
      }
      pendingBackendSize = null;
      pendingReason = null;
      lastContainerSize = null;
      lastSize = null;
    },
    hasPendingLayout: () => pendingReason !== null,
  };
}
