import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useWorkspacesStore } from "@/stores";
import { isTauriReady } from "@/utils";

/**
 * 监听后端 workspaces-changed 事件，自动刷新工作空间列表。
 * 当外部工具（如 Claude Code slash command）修改了 workspace.json 时触发。
 */
export function useWorkspaceWatcher() {
  useEffect(() => {
    if (!isTauriReady()) return;
    let unlisten: (() => void) | null = null;
    getCurrentWebview()
      .listen("workspaces-changed", () => {
        useWorkspacesStore.getState().load();
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => {
      unlisten?.();
    };
  }, []);
}
