import { invoke } from "@tauri-apps/api/core";

export interface ScreenshotResult {
  filePath: string;
  width: number;
  height: number;
}

/** 截图服务（截图流程已迁移至 Rust 原生窗口，前端仅保留快捷键更新） */
export const screenshotService = {
  /** 更新截图快捷键 */
  updateShortcut(oldShortcut: string, newShortcut: string): Promise<void> {
    return invoke("screenshot_update_shortcut", { oldShortcut, newShortcut });
  },
  saveClipboardImage(): Promise<ScreenshotResult | null> {
    return invoke<ScreenshotResult | null>("screenshot_save_clipboard_image");
  },
};
