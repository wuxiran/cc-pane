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

/**
 * 将 Windows 本地路径转换为 WSL 路径
 */
export function toWslPath(path?: string | null): string | null {
  if (!path) return null;
  const wslUncRemotePath = getWslUncRemotePath(path);
  if (wslUncRemotePath) return wslUncRemotePath;
  const match = path.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!match) return null;
  const drive = match[1].toLowerCase();
  const rest = match[2].replace(/\\/g, "/").replace(/^\/+/, "");
  return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`;
}

/**
 * 从 WSL UNC 路径中提取 Linux 远端路径
 */
export function getWslUncRemotePath(path?: string | null): string | null {
  if (!path) return null;
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const match = normalized.match(/^\/\/(?:wsl(?:\.localhost)?|wsl\$)\/[^/]+(?:\/(.*))?$/i);
  if (!match) return null;
  const remotePath = match[1]?.replace(/^\/+/, "") ?? "";
  return remotePath ? `/${remotePath}` : "/";
}

/**
 * 判断路径是否为 Windows 下的 WSL UNC 路径。
 */
export function isWslUncPath(path?: string | null): boolean {
  return getWslUncRemotePath(path) !== null;
}
