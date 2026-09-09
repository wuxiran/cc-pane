// 视图销毁：listeners / timers / observers / addons / 终端实例的统一清理。
// 从 TerminalView.tsx 拆出（纯代码移动，逻辑不变）；清理顺序与原 cleanup() 逐行一致。
import type { IDisposable, Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SerializeAddon } from "@xterm/addon-serialize";
import type { TerminalRendererController } from "../terminalRendererController";
import type { TerminalLayoutScheduler } from "../terminalLayoutScheduler";
import type { attachTerminalInputTrace } from "../terminalInputTrace";
import type { attachTerminalDomInputFallback } from "../terminalDomInputFallback";
import type { attachTerminalImeGuard } from "../terminalImeGuard";
import type { createTerminalWriteFlowControl } from "../terminalWriteFlowControl";
import { unregisterRecoveryCheckpointSource } from "../terminalRecoveryCheckpoint";

interface RefValue<T> {
  current: T;
}

export interface TerminalViewDisposableRefs {
  onDataDisposableRef: RefValue<IDisposable | null>;
  currentSessionIdRef: RefValue<string | null>;
  atlasResetTimerRef: RefValue<ReturnType<typeof setTimeout> | null>;
  layoutSchedulerRef: RefValue<TerminalLayoutScheduler | null>;
  resizeObserverRef: RefValue<ResizeObserver | null>;
  parserDisposableRefs: RefValue<IDisposable[]>;
  dragDropUnlistenRef: RefValue<(() => void) | null>;
  inputTraceRef: RefValue<ReturnType<typeof attachTerminalInputTrace> | null>;
  domInputFallbackRef: RefValue<ReturnType<typeof attachTerminalDomInputFallback> | null>;
  imeGuardRef: RefValue<ReturnType<typeof attachTerminalImeGuard> | null>;
  pasteHandlerRef: RefValue<((e: ClipboardEvent) => void) | null>;
  nativeMenuCleanupRef: RefValue<(() => void) | null>;
  inputDebugCleanupRef: RefValue<(() => void) | null>;
  pasteRequestRef: RefValue<(() => void) | null>;
  terminalInstanceRef: RefValue<Terminal | null>;
  rendererControllerRef: RefValue<TerminalRendererController | null>;
  fitAddonRef: RefValue<FitAddon | null>;
  serializeAddonRef: RefValue<SerializeAddon | null>;
  writeFlowControlRef: RefValue<ReturnType<typeof createTerminalWriteFlowControl> | null>;
  trackedBufferTypeRef: RefValue<"unknown" | "normal" | "alternate">;
  focusReportModeRef: RefValue<boolean>;
}

/** Dispose listeners, timers, observers, addons, and the terminal instance. */
export function disposeTerminalView(
  refs: TerminalViewDisposableRefs,
  {
    debugLog,
    unbindSessionCallbacks,
  }: {
    debugLog: (event: string, payload?: Record<string, unknown>) => void;
    unbindSessionCallbacks: () => void;
  },
): void {
  debugLog("cleanup.begin", {
    trackedBuffer: refs.trackedBufferTypeRef.current,
  });
  if (refs.onDataDisposableRef.current) {
    refs.onDataDisposableRef.current.dispose();
    refs.onDataDisposableRef.current = null;
  }
  if (refs.currentSessionIdRef.current) {
    debugLog("cleanup.detach-session", {
      detachSessionId: refs.currentSessionIdRef.current,
    });
    refs.currentSessionIdRef.current = null;
  }
  unbindSessionCallbacks();
  if (refs.atlasResetTimerRef.current) {
    clearTimeout(refs.atlasResetTimerRef.current);
    refs.atlasResetTimerRef.current = null;
  }
  refs.layoutSchedulerRef.current?.dispose();
  refs.layoutSchedulerRef.current = null;
  if (refs.resizeObserverRef.current) {
    refs.resizeObserverRef.current.disconnect();
    refs.resizeObserverRef.current = null;
  }
  if (refs.parserDisposableRefs.current.length > 0) {
    for (const disposable of refs.parserDisposableRefs.current) {
      try {
        disposable.dispose();
      } catch {
        // Safe to ignore if parser handler was already disposed.
      }
    }
    refs.parserDisposableRefs.current = [];
  }

  if (refs.dragDropUnlistenRef.current) {
    try {
      refs.dragDropUnlistenRef.current();
    } catch {
      // Safe to ignore if Tauri already removed the drag-drop listener.
    }
    refs.dragDropUnlistenRef.current = null;
  }
  refs.inputTraceRef.current?.dispose();
  refs.inputTraceRef.current = null;
  refs.domInputFallbackRef.current?.dispose();
  refs.domInputFallbackRef.current = null;
  refs.imeGuardRef.current?.dispose();
  refs.imeGuardRef.current = null;
  if (refs.pasteHandlerRef.current && refs.terminalInstanceRef.current?.textarea) {
    refs.terminalInstanceRef.current.textarea.removeEventListener('paste', refs.pasteHandlerRef.current, true);
    refs.pasteHandlerRef.current = null;
  }
  refs.nativeMenuCleanupRef.current?.();
  refs.nativeMenuCleanupRef.current = null;
  refs.inputDebugCleanupRef.current?.();
  refs.inputDebugCleanupRef.current = null;
  refs.pasteRequestRef.current = null;

  // Dispose addons before the terminal instance.
  const rendererToDispose = refs.rendererControllerRef.current;
  const fitToDispose = refs.fitAddonRef.current;
  const termToDispose = refs.terminalInstanceRef.current;
  if (termToDispose) unregisterRecoveryCheckpointSource(termToDispose);
  refs.terminalInstanceRef.current = null;
  refs.rendererControllerRef.current = null;
  refs.fitAddonRef.current = null;
  refs.serializeAddonRef.current = null;
  refs.writeFlowControlRef.current?.dispose("unmounted"); // 非 reset：后者不清队列 → 信用还不回去
  refs.writeFlowControlRef.current = null;
  refs.trackedBufferTypeRef.current = "unknown";
  refs.focusReportModeRef.current = false;

  rendererToDispose?.dispose();
  if (fitToDispose) {
    try {
      fitToDispose.dispose();
    } catch {
      // Safe to ignore if the addon is already detached from the DOM.
    }
  }
  if (termToDispose) {
    try {
      termToDispose.dispose();
    } catch {
      // Safe to ignore if xterm was already detached from the DOM.
    }
  }
  debugLog("cleanup.end", {});
}
