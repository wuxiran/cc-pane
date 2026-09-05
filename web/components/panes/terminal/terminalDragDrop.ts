// Tauri 文件拖放监听：drop 落在终端宿主内时把路径粘贴进终端。
// 从 TerminalView.tsx 拆出（纯代码移动，逻辑不变）。
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { isTauriRuntime } from "@/services/runtime";
import { getErrorMessage } from "@/utils";
import { formatTerminalFilePaths } from "../terminalClipboard";
import { isDropInsideTerminalHost } from "../terminalDrop";

export interface TerminalDragDropDeps {
  getHost: () => HTMLDivElement | null;
  isMounted: () => boolean;
  debugLog: (event: string, payload?: Record<string, unknown>) => void;
  pasteText: (text: string, kind: string) => void;
  setUnlisten: (unlisten: () => void) => void;
}

export function attachTerminalDragDropListener({
  getHost,
  isMounted,
  debugLog,
  pasteText,
  setUnlisten,
}: TerminalDragDropDeps): void {
  if (isTauriRuntime()) {
    try {
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type !== "drop") return;

          const host = getHost();
          if (!host || !isDropInsideTerminalHost(host, payload.position)) return;

          const text = formatTerminalFilePaths(payload.paths);
          if (!text) return;

          debugLog("drag-drop.paste", {
            pathCount: payload.paths.length,
            textLength: text.length,
          });
          pasteText(text, "file-drop");
        })
        .then((unlisten) => {
          if (!isMounted()) {
            unlisten();
            return;
          }
          setUnlisten(unlisten);
        })
        .catch((error) => {
          debugLog("drag-drop.listener.failed", {
            error: getErrorMessage(error),
          });
        });
    } catch (error) {
      debugLog("drag-drop.listener.failed", {
        error: getErrorMessage(error),
      });
    }
  }
}
