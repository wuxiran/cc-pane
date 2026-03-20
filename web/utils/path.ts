/**
 * 从完整路径提取文件名
 */
export function getFileName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").pop() || path;
}

/**
 * 从完整路径提取目录部分（含末尾斜线）
 */
export function getDirName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/");
  parts.pop();
  return parts.length > 0 ? parts.join("/") + "/" : "";
}

/**
 * 从路径提取项目名（最后一段目录名）
 */
export function getProjectName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}
