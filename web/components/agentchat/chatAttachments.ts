// agent-chat 附件小工具：粘贴 / 拖放 / 附件对话框共用的纯函数。
// 路径 → 附件形态的判定规则集中在这里，组件只管状态与事件接线。

export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function isImagePath(path: string): boolean {
  const extension = baseName(path).split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(extension);
}

/**
 * 路径附件的形态：图片且引擎支持内嵌（promptCapabilities.image）才读成
 * base64 image 块；其余一律 resource_link 文件引用（ACP 基线能力，所有引擎可用）。
 */
export function planPathAttachment(path: string, imageSupported: boolean): "image" | "file" {
  return isImagePath(path) && imageSupported ? "image" : "file";
}
