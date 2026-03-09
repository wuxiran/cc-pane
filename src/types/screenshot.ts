/** 截图结果（裁剪保存后） */
export interface ScreenshotResult {
  filePath: string;
  width: number;
  height: number;
}

/** 临时截图信息（单显示器模式） */
export interface TempScreenshot {
  /** 临时 PNG 文件路径 */
  tempFilePath: string;
  width: number;
  height: number;
  /** 目标显示器位置 X（物理像素） */
  monitorX: number;
  /** 目标显示器位置 Y（物理像素） */
  monitorY: number;
  /** 目标显示器宽度（物理像素） */
  monitorWidth: number;
  /** 目标显示器高度（物理像素） */
  monitorHeight: number;
}
