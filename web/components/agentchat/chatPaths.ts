// agent-chat 的路径小工具：@引用与文件跳转共用。
import type { Workspace } from "@/types";

export function isAbsolutePath(path: string): boolean {
  return /^([a-zA-Z]:[\\/]|\/|\\\\)/.test(path);
}

export function joinCwd(cwd: string, relative: string): string {
  const separator = cwd.includes("\\") ? "\\" : "/";
  return `${cwd.replace(/[\\/]+$/, "")}${separator}${relative}`;
}

export function toFileUri(absolutePath: string): string {
  const windows = isWindowsPath(absolutePath);
  const normalized = windows ? withoutWindowsNamespace(absolutePath).replace(/\\/g, "/") : absolutePath;
  const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");
  if (windows && normalized.startsWith("//")) {
    const slash = normalized.indexOf("/", 2);
    const host = slash < 0 ? normalized.slice(2) : normalized.slice(2, slash);
    return `file://${host}${slash < 0 ? "/" : encodePath(normalized.slice(slash))}`;
  }
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `file:///${normalized.slice(0, 2)}${encodePath(normalized.slice(2))}`;
  }
  return `file://${normalized.startsWith("/") ? "" : "/"}${encodePath(normalized)}`;
}

function withoutWindowsNamespace(path: string): string {
  if (/^\\\\\?\\UNC\\/i.test(path)) return `\\\\${path.slice(8)}`;
  return /^\\\\\?\\[a-zA-Z]:\\/.test(path) ? path.slice(4) : path;
}

function isWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || /^\\\\/.test(path) || /^\/\/[^/]+\/[^/]+/.test(path);
}

/** 只对盘符/UNC 路径应用 Windows 语义；POSIX 大小写和反斜杠都是有效文件名。 */
export function samePath(left: string, right: string): boolean {
  const windows = isWindowsPath(left);
  if (windows !== isWindowsPath(right)) return false;
  const normalize = (value: string) => {
    if (windows) return withoutWindowsNamespace(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return value ? value.replace(/\/+$/, "") || "/" : "";
  };
  return normalize(left) === normalize(right);
}

/**
 * 新 Agent Chat 会话的兜底工作目录：Agent Chat 专用常驻工作空间 → 默认工作空间 → 空。
 *
 * 会话没有 cwdOverride、标签也没带项目时（专用布局自动补的空标签、首页直接开聊），
 * 聊天仍需要一个真实存在的 cwd——常驻工作空间就是为此供给的锚点，保证会话不会
 * 因为「没选项目」而启动失败。
 */
export function residentAgentChatCwd(workspaces: readonly Workspace[]): string {
  return (
    workspaces.find((ws) => ws.isAgentChat && !ws.archivedAt)?.path
    ?? workspaces.find((ws) => ws.isDefault && !ws.archivedAt)?.path
    ?? ""
  );
}
