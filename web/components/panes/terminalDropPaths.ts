// 拖放/粘贴文件路径进终端时的 shell 呈现：引号转义 + 按会话运行时转换。
//
// 背景：终端拖放（terminalDragDrop.ts）与剪贴板文件路径粘贴
// （terminalClipboard.ts）以前只做 `paths.join(" ")`，含空格/中文的路径会被
// shell 拆成多个参数，WSL 会话还会拿到无效的 Windows 盘符路径。本模块把
// 「路径 → 可安全插入终端的文本」收成一个纯函数，便于单测锁定。
//
// WSL 转换走 `@/utils/path` 的 toWslPath（底层 wslPath.ts，与 Rust `cc-panes-paths`
// 共用用例表对拍），保持前后端一致。

import { toWslPath } from "@/utils/path";

/** 终端会话的运行时类型，决定路径如何呈现。 */
export type TerminalRuntimeKind = "local" | "wsl" | "ssh";

/**
 * POSIX 单引号包裹，使路径作为单一参数插入 shell。
 * 内部单引号按 `'\''` 惯例转义（关闭引号、转义引号、重开引号）。
 * 始终加引号（对标 Pebrel「insert quoted paths」），行为可预测。
 */
export function quoteShellPath(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * Windows 路径 → WSL guest 路径。无法识别的形态返回 null（调用方保留原值）。
 *
 * 支持：
 * - 盘符绝对路径 `D:\repos\app` / `D:/repos/app` → `/mnt/d/repos/app`
 * - WSL UNC `\\wsl.localhost\Distro\home\me` / `\\wsl$\...` / `\\wsl\...` → `/home/me`
 *
 * 入参允许反斜杠或正斜杠；内部统一按 `/` 处理。
 */
export function windowsPathToWsl(path: string): string | null {
  return toWslPath(path);
}

export interface FormatTerminalPathsOptions {
  /** 会话运行时；缺省按 local 处理。 */
  runtimeKind?: TerminalRuntimeKind;
}

/**
 * 把一组文件路径格式化为可安全插入终端的文本。
 *
 * - local：逐个单引号转义，空格分隔。
 * - wsl：先尝试转成 guest 路径（转不动的保留原值，已是 POSIX 的路径原样），再转义。
 * - ssh：返回空串——宿主本地路径在远端无意义，诚实降级为「不插入」，
 *   不假装可用（对标 Pebrel 的诚实标注；自动上传不在本期范围）。
 *
 * 空路径被过滤；全部为空时返回空串（调用方据此跳过粘贴）。
 */
export function formatTerminalPathsForShell(
  paths: string[],
  options: FormatTerminalPathsOptions = {},
): string {
  const runtimeKind = options.runtimeKind ?? "local";
  if (runtimeKind === "ssh") return "";

  return paths
    .filter((path) => path.length > 0)
    .map((path) =>
      runtimeKind === "wsl" ? (windowsPathToWsl(path) ?? path) : path,
    )
    .map(quoteShellPath)
    .join(" ");
}
