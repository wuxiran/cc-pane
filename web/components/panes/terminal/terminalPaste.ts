// 粘贴处理（右键菜单/快捷键/拖放共用的负载解析与写入）。
// 从 TerminalView.tsx 拆出（纯代码移动，逻辑不变）。
import type { Terminal } from "@xterm/xterm";
import { toast } from "@/components/ui/toast";
import { getErrorMessage } from "@/utils";
import { resolveTerminalPastePayload } from "../terminalClipboard";
import {
  formatTerminalPathsForShell,
  type TerminalRuntimeKind,
} from "../terminalDropPaths";

interface RefValue<T> {
  current: T;
}

export interface TerminalPasteHandlersDeps {
  term: Terminal;
  debugLog: (event: string, payload?: Record<string, unknown>) => void;
  lastShortcutPasteAtRef: RefValue<number>;
  /** 会话运行时，决定粘贴的文件路径如何呈现。缺省 local。 */
  getRuntimeKind?: () => TerminalRuntimeKind;
  /** SSH 会话粘贴宿主本地文件路径时的诚实降级提示（不插入无效路径）。 */
  onUnsupportedPaths?: (pathCount: number) => void;
}

export function createTerminalPasteHandlers({
  term,
  debugLog,
  lastShortcutPasteAtRef,
  getRuntimeKind,
  onUnsupportedPaths,
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
        if (payload.kind === "file") {
          // 与拖放同源（docs/105 F2）：按会话运行时呈现路径——本地/WSL 做
          // shell 转义（WSL 额外把盘符路径转 /mnt/<drive>/...），SSH 不插入
          // 宿主本地路径而是诚实提示。剪贴板原文本 payload.text 是裸 join，
          // 这里用 filePaths 重新格式化以保持一致。
          const runtimeKind = getRuntimeKind?.() ?? "local";
          const text = formatTerminalPathsForShell(payload.filePaths, {
            runtimeKind,
          });
          if (!text) {
            if (runtimeKind === "ssh" && payload.filePaths.length > 0) {
              debugLog("clipboard.paste.unsupported-runtime", {
                runtimeKind,
                pathCount: payload.filePaths.length,
              });
              onUnsupportedPaths?.(payload.filePaths.length);
            }
            return;
          }
          debugLog("clipboard.paste.file-paths", {
            runtimeKind,
            pathCount: payload.filePaths.length,
            textLength: text.length,
          });
          pasteTextIntoTerminal(text, payload.kind);
          return;
        }

        if (payload.kind === "image" || payload.kind === "text") {
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
