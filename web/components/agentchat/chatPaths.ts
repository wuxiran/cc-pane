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
  const normalized = absolutePath.replace(/\\/g, "/");
  return normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`;
}

/** 路径宽松等价（Windows 大小写 + 分隔符差异），仅用于 UI 高亮/过滤。 */
export function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
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
