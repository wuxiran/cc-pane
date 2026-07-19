/**
 * 剥离 Windows `\\?\` verbatim 前缀。
 *
 * 后端 `canonicalize()` 会产出 `\\?\C:\...`，该值一旦回流成 PTY 的 cwd，
 * cmd.exe 会拒绝并静默回落到 `C:\Windows`（见 docs/35-unc-path-contamination.md）。
 * 这是前端兜底防线——后端已在 hook / 入库 / spawn 三处拦截。
 *
 * 与后端 `dunce` 语义保持一致：`\\?\UNC\server\share` 无法靠裸剥前缀降级成合法
 * 路径，保持原样。非 Windows 路径不含该前缀，因此天然是 no-op。幂等。
 */
export function stripVerbatimPrefix<T extends string | null | undefined>(path: T): T {
  if (typeof path !== "string") return path;
  if (!path.startsWith("\\\\?\\")) return path;
  if (path.startsWith("\\\\?\\UNC\\")) return path;
  return path.slice(4) as T;
}

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
