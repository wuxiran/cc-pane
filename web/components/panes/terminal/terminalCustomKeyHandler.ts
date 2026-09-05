// xterm 自定义键盘事件处理：IME 守卫、粘贴/复制快捷键拦截、全局快捷键让路。
// 从 TerminalView.tsx 拆出（纯代码移动，逻辑不变）。
import type { Terminal } from "@xterm/xterm";
import { toast } from "sonner";
import { getErrorMessage } from "@/utils";
import { shouldTerminalHandleKey } from "@/stores";
import { copyTerminalSelection } from "../terminalClipboard";
import type { attachTerminalImeGuard } from "../terminalImeGuard";
import { isTerminalCopyShortcut, isTerminalPasteShortcut } from "../terminalKeyboard";
import { IS_MAC } from "../terminalViewHelpers";

export interface TerminalCustomKeyHandlerDeps {
  term: Terminal;
  getImeGuard: () => ReturnType<typeof attachTerminalImeGuard> | null;
  debugLog: (event: string, payload?: Record<string, unknown>) => void;
  pasteTerminalPayload: (clipboardData?: DataTransfer | null) => void;
}

/** Build the handler passed to term.attachCustomKeyEventHandler. */
export function createTerminalCustomKeyHandler({
  term,
  getImeGuard,
  debugLog,
  pasteTerminalPayload,
}: TerminalCustomKeyHandlerDeps): (e: KeyboardEvent) => boolean {
  // Intercept paste so file clipboard data can be resolved through the Tauri backend.
  return (e: KeyboardEvent) => {
    // 先让平台特定的 guard 记录 Linux WebKit 的组合状态，再拦截后续处理。
    if (!getImeGuard()?.handleKeyEvent(e)) {
      return false;
    }

    // Intel Mac 的旧版 WKWebView 仍会把组合期间的 keydown 传到 xterm，必须在
    // 粘贴、复制和快捷键判断之前放行给隐藏 textarea，避免打断 IME。
    if (e.isComposing || e.keyCode === 229) {
      return false;
    }

    if (isTerminalPasteShortcut(e, IS_MAC)) {
      e.preventDefault();
      e.stopPropagation();
      pasteTerminalPayload(null);
      return false;
    }

    if (isTerminalCopyShortcut(e, IS_MAC)) {
      // Copy the selection; without one Ctrl+C must stay SIGINT.
      const selection = term.getSelection();
      if (selection) {
        e.preventDefault();
        void copyTerminalSelection(selection)
          .then(() => {
            term.clearSelection();
            getImeGuard()?.clearNativeEditState("copy-selection");
            term.focus();
          })
          .catch((error) => {
            const message = getErrorMessage(error);
            debugLog("clipboard.copy.failed", { error: message });
            toast.error(`Copy failed: ${message}`);
          });
        return false;
      }
      // No selection: plain Ctrl/Cmd+C goes to the terminal (SIGINT);
      // Ctrl+Shift+C falls through to the global shortcut layer.
      if (!e.shiftKey) return true;
    }
    return shouldTerminalHandleKey(e);
  };
}
