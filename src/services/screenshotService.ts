import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { ScreenshotResult, TempScreenshot } from "@/types";

/** 截图服务 */
export const screenshotService = {
  /** 由前端发起截图（push 模型：JS mount 后调用） */
  capture(): Promise<TempScreenshot> {
    return invoke<TempScreenshot>("screenshot_capture");
  },

  /** 将临时文件路径转换为 asset protocol URL */
  getTempImageUrl(filePath: string): string {
    return convertFileSrc(filePath);
  },

  /** 裁剪区域并保存为 PNG */
  cropAndSave(
    tempFilePath: string,
    x: number,
    y: number,
    w: number,
    h: number
  ): Promise<ScreenshotResult> {
    return invoke<ScreenshotResult>("screenshot_crop_and_save", {
      tempFilePath,
      x,
      y,
      w,
      h,
    });
  },

  /** 复制文件路径到剪贴板 */
  async copyPathToClipboard(path: string): Promise<void> {
    await writeText(path);
  },

  /** 更新截图快捷键 */
  updateShortcut(oldShortcut: string, newShortcut: string): Promise<void> {
    return invoke("screenshot_update_shortcut", { oldShortcut, newShortcut });
  },
};
