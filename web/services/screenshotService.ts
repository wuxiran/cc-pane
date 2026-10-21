import { invokeOrApi } from "./apiClient";

export interface ScreenshotResult {
  filePath: string;
  width: number;
  height: number;
}

/** 原生截图与图片附件服务；区域选择和图片落盘由 Rust 后端处理。 */
export const screenshotService = {
  /** 更新截图快捷键 */
  updateShortcut(oldShortcut: string, newShortcut: string): Promise<void> {
    return invokeOrApi<void>("screenshot_update_shortcut", { oldShortcut, newShortcut }, async () => {});
  },
  /** 从应用内（命令面板）触发截图：与全局热键同一条 Rust 路径 */
  trigger(): Promise<void> {
    return invokeOrApi<void>("screenshot_trigger", undefined, async () => {});
  },
  /** Persist the actual pasted/dropped bytes when the engine only accepts file references. */
  saveImageAttachment(dataBase64: string): Promise<ScreenshotResult | null> {
    return invokeOrApi<ScreenshotResult | null>("screenshot_save_image_attachment", { dataBase64 }, async () => null);
  },
  saveClipboardImage(): Promise<ScreenshotResult | null> {
    return invokeOrApi<ScreenshotResult | null>("screenshot_save_clipboard_image", undefined, async () => null);
  },
};
