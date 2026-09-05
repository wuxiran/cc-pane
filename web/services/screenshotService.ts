import { invokeOrApi } from "./apiClient";

export interface ScreenshotResult {
  filePath: string;
  width: number;
  height: number;
}

/** 截图服务（截图流程已迁移至 Rust 原生窗口，前端仅保留快捷键更新） */
export const screenshotService = {
  /** 更新截图快捷键 */
  updateShortcut(oldShortcut: string, newShortcut: string): Promise<void> {
    return invokeOrApi<void>("screenshot_update_shortcut", { oldShortcut, newShortcut }, async () => {});
  },
  /** 从应用内（命令面板）触发截图：与全局热键同一条 Rust 路径 */
  trigger(): Promise<void> {
    return invokeOrApi<void>("screenshot_trigger", undefined, async () => {});
  },
  saveClipboardImage(): Promise<ScreenshotResult | null> {
    return invokeOrApi<ScreenshotResult | null>("screenshot_save_clipboard_image", undefined, async () => null);
  },
};
