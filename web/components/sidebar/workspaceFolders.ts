// 工作空间的项目文件夹：哪些算在内、哪个是主要的、默认在哪个目录干活。
import type { Workspace, WorkspaceProject } from "@/types";

const WINDOWS_PATH = /^[a-zA-Z]:[\\/]|^\\\\/;

/** 统一分隔符、去尾斜杠；Windows 路径不区分大小写 */
export function normalizePath(path: string): string {
  const unified = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return WINDOWS_PATH.test(path) ? unified.toLowerCase() : unified;
}

/** 工作空间的未归档项目文件夹。 */
export function workspaceFolders(workspace: Workspace): WorkspaceProject[] {
  return workspace.projects.filter((project) => !project.archivedAt);
}

/**
 * 主要文件夹：新聊天 / 启动终端默认落在这里。工作空间根路径正好是其中一个项目时
 * 取它，否则取第一个项目。
 */
export function primaryFolder(workspace: Workspace): WorkspaceProject | null {
  const folders = workspaceFolders(workspace);
  const root = workspace.path ? normalizePath(workspace.path) : null;
  return (root ? folders.find((project) => normalizePath(project.path) === root) : undefined) ?? folders[0] ?? null;
}
