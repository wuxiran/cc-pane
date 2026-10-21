import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { isTauriRuntime } from "./runtime";

/** Native actions are only for paths on the desktop running this view. */
export function canUseLocalFileActions(filePath: string, remote = false): boolean {
  if (remote || !isTauriRuntime() || /[\u0000-\u001f]/.test(filePath)) return false;
  return filePath.startsWith("/") || /^([A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(filePath);
}

export const filePreviewService = {
  async runDesktopAction(filePath: string, action: "openDefault" | "reveal", remote = false): Promise<void> {
    if (!canUseLocalFileActions(filePath, remote)) {
      throw new Error("Desktop file actions require a local absolute path");
    }
    if (action === "openDefault") await openPath(filePath);
    else await revealItemInDir(filePath);
  },
};
