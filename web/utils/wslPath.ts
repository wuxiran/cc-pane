/**
 * WSL 视角的路径工具：前端对应 `cc-panes-paths` crate 的 `wsl` 模块。
 *
 * 与 Rust 共用 `cc-panes-paths/tests/fixtures/wsl_path_cases.json` 做对拍
 * （见 wslPath.test.ts），改语义时两边和用例表要一起改。
 */

/** WSL 默认的 Windows 盘挂载根。 */
export const DEFAULT_WSL_MOUNT_ROOT = "/mnt";

export interface WslUncPath {
  distro: string;
  /** distro 内的 POSIX 绝对路径；发行版根为 `/`。 */
  posix: string;
}

/**
 * 解析 WSL UNC 路径（`\\wsl.localhost\`、`\\wsl$\`、`\\wsl\`，大小写不敏感，
 * 也认 `\\?\UNC\` 包装）。distro 与 POSIX 部分保持原样大小写，去掉尾分隔符。
 */
export function parseWslUnc(path?: string | null): WslUncPath | null {
  if (!path) return null;
  return splitWslUnc(slashedWithoutVerbatim(path));
}

/**
 * 转成 WSL 内可用的 POSIX 路径（形式转换，保留大小写，不用于比较）。
 *
 * - WSL UNC → distro 内的 POSIX 路径；
 * - 盘符 `D:\x` / `D:` → `<mountRoot>/d/x` / `<mountRoot>/d`；
 * - POSIX 绝对路径原样返回（去尾分隔符）；
 * - 普通网络共享、`C:relative` 返回 null。
 */
export function toWslPosix(
  path: string | null | undefined,
  mountRoot: string = DEFAULT_WSL_MOUNT_ROOT,
): string | null {
  if (!path) return null;
  const slashed = slashedWithoutVerbatim(path);
  const unc = splitWslUnc(slashed);
  if (unc) return unc.posix;
  const drive = splitAbsoluteDrive(slashed);
  if (drive) {
    const root = mountRoot.replace(/\/+$/, "");
    const tail = drive.rest.replace(/^\/+|\/+$/g, "");
    return tail ? `${root}/${drive.letter}/${tail}` : `${root}/${drive.letter}`;
  }
  if (slashed.startsWith("/") && !slashed.startsWith("//")) return trimPosix(slashed);
  return null;
}

/**
 * WSL 视角的比较键（会话归属匹配用）：UNC 剥成 POSIX，盘符转 `/mnt/<x>`，
 * `/mnt/<x>/` 开头的整体小写，WSL Linux 路径保持大小写。不含 distro。
 */
export function wslCompareKey(path: string): string {
  const slashed = slashedWithoutVerbatim(path);
  const unc = splitWslUnc(slashed);
  if (unc) return foldMountedDrive(unc.posix);
  if (splitAbsoluteDrive(slashed)) {
    return (toWslPosix(slashed) ?? "").toLowerCase();
  }
  if (slashed.startsWith("/") && !slashed.startsWith("//")) {
    return foldMountedDrive(trimPosix(slashed));
  }
  return slashed.replace(/\/+$/, "").toLowerCase();
}

/** `/mnt/<x>` 或 `/mnt/<x>/...` 返回小写盘符；路径中部的 `/mnt/` 不算。 */
export function mntDriveLetter(posix: string): string | null {
  const match = /^\/mnt\/([A-Za-z])(?:\/|$)/.exec(posix);
  return match ? match[1].toLowerCase() : null;
}

function foldMountedDrive(posix: string): string {
  return mntDriveLetter(posix) ? posix.toLowerCase() : posix;
}

function slashedWithoutVerbatim(path: string): string {
  const slashed = path.trim().replace(/\\/g, "/");
  if (!slashed.startsWith("//?/")) return slashed;
  const rest = slashed.slice(4);
  return rest.slice(0, 4).toLowerCase() === "unc/" ? `//${rest.slice(4)}` : rest;
}

function splitWslUnc(slashed: string): WslUncPath | null {
  if (!slashed.startsWith("//")) return null;
  const rest = slashed.slice(2);
  const serverEnd = rest.indexOf("/");
  if (serverEnd < 0) return null;
  const server = rest.slice(0, serverEnd).toLowerCase();
  if (server !== "wsl.localhost" && server !== "wsl$" && server !== "wsl") return null;
  const afterServer = rest.slice(serverEnd + 1);
  const distroEnd = afterServer.indexOf("/");
  const distro = distroEnd < 0 ? afterServer : afterServer.slice(0, distroEnd);
  if (!distro) return null;
  const tail = (distroEnd < 0 ? "" : afterServer.slice(distroEnd + 1)).replace(/\/+$/, "");
  const posix = !tail ? "/" : tail.startsWith("/") ? tail : `/${tail}`;
  return { distro, posix };
}

function splitAbsoluteDrive(slashed: string): { letter: string; rest: string } | null {
  const match = /^([A-Za-z]):(\/.*)?$/.exec(slashed);
  return match ? { letter: match[1].toLowerCase(), rest: match[2] ?? "" } : null;
}

function trimPosix(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}
