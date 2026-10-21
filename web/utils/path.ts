import { parseWslUnc, toWslPosix, type WslUncPath } from "./wslPath";

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
 * 将 Windows 本地路径（盘符或 WSL UNC）转换为 WSL 路径；已是 POSIX 或无法转换的返回 null。
 */
export function toWslPath(path?: string | null): string | null {
  if (!path) return null;
  const slashed = path.trim().replace(/\\/g, "/");
  if (slashed.startsWith("/") && !slashed.startsWith("//")) return null;
  return toWslPosix(path);
}

/**
 * 从 WSL UNC 路径中提取发行版与 Linux 远端路径
 */
export function getWslUncRemotePath(path?: string | null): WslUncPath | null {
  return parseWslUnc(path);
}

/**
 * 判断路径是否为 Windows 下的 WSL UNC 路径。
 */
export function isWslUncPath(path?: string | null): boolean {
  return getWslUncRemotePath(path) !== null;
}

export type NavigationPathStyle = "auto" | "posix";
interface NavigationPath { root: string; parts: string[] }

/** Preserve path roots and POSIX filename backslashes; never resolve dot segments or symlinks. */
function splitNavigationPath(path: string, style: NavigationPathStyle): NavigationPath {
  const uri = /^[A-Za-z]:/.test(path) ? null : path.match(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]+)(?:\/|$)/);
  if (uri) return { root: `${uri[1]}/`, parts: path.slice(uri[0].length).split("/").filter(Boolean) };
  const stripped = style === "auto" ? stripVerbatimPrefix(path) : path;
  const windows = style === "auto" && (/^[A-Za-z]:/.test(stripped) || stripped.startsWith("\\\\") || stripped.startsWith("//"));
  const normalized = windows ? stripped.replace(/\\/g, "/").replace(/^\/\/\?\/UNC\//i, "//").replace(/^\/\/\?\/(?=[A-Za-z]:\/)/, "") : stripped;
  if (windows && /^[A-Za-z]:/.test(normalized)) {
    const root = normalized.slice(0, normalized[2] === "/" ? 3 : 2);
    return { root, parts: normalized.slice(root.length).split("/").filter(Boolean) };
  }
  if (windows && normalized.startsWith("//")) {
    const parts = normalized.slice(2).split("/").filter(Boolean);
    return { root: `//${parts.slice(0, 2).join("/")}`, parts: parts.slice(2) };
  }
  const root = normalized.startsWith("//") && !normalized.startsWith("///") ? "//" : normalized.startsWith("/") ? "/" : "";
  return { root, parts: normalized.slice(root.length).split("/").filter(Boolean) };
}

function joinNavigationPath({ root, parts }: NavigationPath): string {
  const separator = parts.length && root && !root.endsWith("/") && !root.endsWith(":") ? "/" : "";
  return root + separator + parts.join("/");
}

export function normalizeNavigationPath(path: string, style: NavigationPathStyle = "auto"): string {
  return joinNavigationPath(splitNavigationPath(path, style));
}

export function parentNavigationPath(path: string, style: NavigationPathStyle = "auto"): string {
  const parsed = splitNavigationPath(path, style);
  if (!parsed.parts.length || (!parsed.root && parsed.parts.length === 1)) return joinNavigationPath(parsed);
  return joinNavigationPath({ root: parsed.root, parts: parsed.parts.slice(0, -1) });
}

export function navigationBreadcrumbs(path: string, style: NavigationPathStyle = "auto"): Array<{ label: string; path: string }> {
  const { root, parts } = splitNavigationPath(path, style);
  const showRoot = root && (parts.length === 0 || (root !== "/" && root !== "//"));
  const breadcrumbs = showRoot ? [{ label: /^[A-Za-z]:\/$/.test(root) ? root.slice(0, 2) : root, path: root }] : [];
  for (let index = 0; index < parts.length; index += 1) {
    breadcrumbs.push({ label: parts[index], path: joinNavigationPath({ root, parts: parts.slice(0, index + 1) }) });
  }
  return breadcrumbs;
}
