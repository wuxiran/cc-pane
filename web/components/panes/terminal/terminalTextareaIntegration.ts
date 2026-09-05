// textarea 集成：原生菜单压制、焦点上报、粘贴事件、输入诊断/trace、
// DOM 兜底与 IME 守卫的装配。从 TerminalView.tsx 拆出（纯代码移动，逻辑不变）；
// 各诊断句柄仍写回调用方持有的 ref，清理顺序与原 cleanup() 完全一致。
import type { Terminal } from "@xterm/xterm";
import { useShortcutsStore } from "@/stores";
import { terminalService } from "@/services";
import { TERMINAL_APP_MENU_PASTE_EVENT } from "@/utils/appMenuPaste";
import { attachTerminalInputDebugLog } from "../terminalInputDebug";
import { attachTerminalInputTrace, summarizeTerminalInputData } from "../terminalInputTrace";
import { attachTerminalDomInputFallback } from "../terminalDomInputFallback";
import { attachTerminalImeGuard, isLinuxWebKitImeEnvironment } from "../terminalImeGuard";
import { isTerminalPasteShortcut } from "../terminalKeyboard";
import {
  IS_MAC,
  resolveNativeMenuBlock,
  setMacosTerminalNativeFocus,
} from "../terminalViewHelpers";

const TERMINAL_DEBUG = import.meta.env.DEV;

interface RefValue<T> {
  current: T;
}

export interface TerminalTextareaIntegrationDeps {
  term: Terminal;
  host: HTMLDivElement;
  debugLog: (event: string, payload?: Record<string, unknown>) => void;
  pasteTerminalPayload: (clipboardData?: DataTransfer | null) => void;
  currentSessionIdRef: RefValue<string | null>;
  readOnlyRef: RefValue<boolean>;
  isDisconnectedRef: RefValue<boolean>;
  inputTraceSeqRef: RefValue<number>;
  pasteHandlerRef: RefValue<((e: ClipboardEvent) => void) | null>;
  inputDebugCleanupRef: RefValue<(() => void) | null>;
  inputTraceRef: RefValue<ReturnType<typeof attachTerminalInputTrace> | null>;
  domInputFallbackRef: RefValue<ReturnType<typeof attachTerminalDomInputFallback> | null>;
  imeGuardRef: RefValue<ReturnType<typeof attachTerminalImeGuard> | null>;
}

/**
 * Wire textarea-level listeners and input diagnostics. Returns the native-menu
 * cleanup (assigned to nativeMenuCleanupRef by the caller).
 */
export function attachTerminalTextareaIntegration({
  term,
  host,
  debugLog,
  pasteTerminalPayload,
  currentSessionIdRef,
  readOnlyRef,
  isDisconnectedRef,
  inputTraceSeqRef,
  pasteHandlerRef,
  inputDebugCleanupRef,
  inputTraceRef,
  domInputFallbackRef,
  imeGuardRef,
}: TerminalTextareaIntegrationDeps): () => void {
  // Track terminal focus so global shortcuts can defer to xterm.
  const textarea = term.textarea;
  const cleanupNativeMenuBlockers: Array<() => void> = [];
  const blockNativeTerminalMenu = (event: Event) => {
    // 决策逻辑在 resolveNativeMenuBlock（terminalViewHelpers）里，带单测。
    // 要点：contextmenu 只 preventDefault、**放行传播**，交给外层 TerminalContextMenu。
    const { blocked, stopPropagation } = resolveNativeMenuBlock({
      eventType: event.type,
      button: "button" in event && typeof event.button === "number" ? event.button : undefined,
      ctrlKey: "ctrlKey" in event && event.ctrlKey === true,
      isMac: IS_MAC,
    });
    if (!blocked) return;
    event.preventDefault();
    if (stopPropagation) {
      event.stopPropagation();
      event.stopImmediatePropagation();
    }
    term.focus();
    debugLog("native-menu.blocked", {
      eventType: event.type,
      target: event.target instanceof HTMLElement ? event.target.tagName : null,
      propagated: !stopPropagation,
    });
  };
  const addNativeMenuBlocker = (target: EventTarget | null | undefined) => {
    if (!target) return;
    for (const eventName of ["pointerdown", "mousedown", "mouseup", "auxclick", "contextmenu"]) {
      target.addEventListener(eventName, blockNativeTerminalMenu, true);
    }
    cleanupNativeMenuBlockers.push(() => {
      for (const eventName of ["pointerdown", "mousedown", "mouseup", "auxclick", "contextmenu"]) {
        target.removeEventListener(eventName, blockNativeTerminalMenu, true);
      }
    });
  };
  if (IS_MAC) {
    addNativeMenuBlocker(host);
    addNativeMenuBlocker(term.element);
  }

  if (textarea) {
    textarea.spellcheck = false;
    textarea.autocomplete = "off";
    textarea.autocapitalize = "off";
    textarea.setAttribute("autocorrect", "off");
    textarea.setAttribute("data-cc-panes-terminal-input", "true");
    const keydownPasteHandler = (event: KeyboardEvent) => {
      if (event.target !== textarea) return;
      if (!isTerminalPasteShortcut(event, IS_MAC)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      debugLog("clipboard.paste-shortcut.captured", {
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
      });
      pasteTerminalPayload(null);
    };
    const appMenuPasteHandler = (event: Event) => {
      debugLog("clipboard.paste-menu.captured", {
        source: event instanceof CustomEvent ? event.detail?.source ?? "unknown" : "unknown",
      });
      pasteTerminalPayload(null);
    };
    const setFocused = useShortcutsStore.getState().setTerminalFocused;
    textarea.addEventListener('focus', () => {
      setFocused(true);
      setMacosTerminalNativeFocus(true);
      debugLog("textarea.focus", {});
    });
    textarea.addEventListener('blur', () => {
      setFocused(false);
      setMacosTerminalNativeFocus(false);
      debugLog("textarea.blur", {});
    });

    const pasteHandler = (e: ClipboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      pasteTerminalPayload(e.clipboardData);
    };

    textarea.ownerDocument.addEventListener("keydown", keydownPasteHandler, true);
    cleanupNativeMenuBlockers.push(() => {
      textarea.ownerDocument.removeEventListener("keydown", keydownPasteHandler, true);
    });
    textarea.addEventListener(TERMINAL_APP_MENU_PASTE_EVENT, appMenuPasteHandler);
    cleanupNativeMenuBlockers.push(() => {
      textarea.removeEventListener(TERMINAL_APP_MENU_PASTE_EVENT, appMenuPasteHandler);
    });
    textarea.addEventListener('paste', pasteHandler, true);
    pasteHandlerRef.current = pasteHandler;
    if (IS_MAC) {
      addNativeMenuBlocker(textarea);
    }
    inputDebugCleanupRef.current = attachTerminalInputDebugLog(
      textarea,
      debugLog,
      () => ++inputTraceSeqRef.current,
    );
    inputTraceRef.current = attachTerminalInputTrace({
      textarea,
      isDev: TERMINAL_DEBUG,
      isMac: IS_MAC,
      logger: debugLog,
    });
    if (IS_MAC) {
      domInputFallbackRef.current = attachTerminalDomInputFallback({
        textarea,
        logger: debugLog,
        nextTraceId: () => ++inputTraceSeqRef.current,
        onFallbackData: (data, traceId) => {
          const sessionId = currentSessionIdRef.current;
          debugLog("input.dom-fallback.write", {
            traceId,
            data: summarizeTerminalInputData(data),
            disconnected: isDisconnectedRef.current,
            hasSession: Boolean(sessionId),
          });
          if (isDisconnectedRef.current) return;
          if (sessionId && !readOnlyRef.current) {
            void terminalService.write(sessionId, data, { traceId }).catch((error) => {
              console.warn("[TerminalView] DOM fallback write failed:", error);
            });
          }
        },
      });
    }
    imeGuardRef.current = attachTerminalImeGuard({
      textarea,
      terminal: term,
      enabled: isLinuxWebKitImeEnvironment(),
      logger: debugLog,
    });
  }
  return () => {
    while (cleanupNativeMenuBlockers.length > 0) {
      cleanupNativeMenuBlockers.pop()?.();
    }
  };
}
