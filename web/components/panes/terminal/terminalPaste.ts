// 粘贴处理（右键菜单/快捷键/拖放共用的负载解析与写入）。
// 从 TerminalView.tsx 拆出（纯代码移动，逻辑不变）。
import type { Terminal } from "@xterm/xterm";
import { toast } from "sonner";
import { getErrorMessage } from "@/utils";
import { resolveTerminalPastePayload } from "../terminalClipboard";

interface RefValue<T> {
  current: T;
}

export interface TerminalPasteHandlersDeps {
  term: Terminal;
  debugLog: (event: string, payload?: Record<string, unknown>) => void;
  lastShortcutPasteAtRef: RefValue<number>;
}

export function createTerminalPasteHandlers({
  term,
  debugLog,
  lastShortcutPasteAtRef,
}: TerminalPasteHandlersDeps) {
  const pasteTextIntoTerminal = (text: string, kind: string) => {
    if (!text) return;
    debugLog("clipboard.paste", {
      kind,
      textLength: text.length,
    });
    term.focus();
    term.paste(text);
  };

  const pasteTerminalPayload = (clipboardData?: DataTransfer | null) => {
    if (!clipboardData) {
      const now = Date.now();
      if (now - lastShortcutPasteAtRef.current < 300) {
        debugLog("clipboard.paste.dedupe", {
          elapsedMs: now - lastShortcutPasteAtRef.current,
        });
        return;
      }
      lastShortcutPasteAtRef.current = now;
    }
    void resolveTerminalPastePayload(clipboardData)
      .then((payload) => {
        if (payload.kind === "image" || payload.kind === "text" || payload.kind === "file") {
          pasteTextIntoTerminal(payload.text, payload.kind);
          return;
        }

        if (payload.kind === "error") {
          debugLog("clipboard.paste.failed", {
            reason: payload.reason,
            error: payload.error,
          });
          toast.error(`Paste failed: ${payload.error}`);
        }
      })
      .catch((error) => {
        const message = getErrorMessage(error);
        debugLog("clipboard.paste.failed", {
          reason: "unexpected-error",
          error: message,
        });
        toast.error(`Paste failed: ${message}`);
      });
  };

  return { pasteTextIntoTerminal, pasteTerminalPayload };
}
