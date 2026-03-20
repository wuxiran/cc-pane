import { invoke } from "@tauri-apps/api/core";
import type {
  DirListing,
  FileContent,
  FsEntry,
  SearchResult,
} from "@/types/filesystem";

/** 文件系统服务 — 封装所有 fs_* IPC 调用 */
export const filesystemService = {
  /** 列出一级目录内容 */
  listDirectory(path: string, showHidden: boolean): Promise<DirListing> {
    return invoke("fs_list_directory", { path, showHidden });
  },

  /** 读取文件内容 */
  readFile(path: string): Promise<FileContent> {
    return invoke("fs_read_file", { path });
  },

  /** 写入文件 */
  writeFile(path: string, content: string): Promise<void> {
    return invoke("fs_write_file", { path, content });
  },

  /** 创建空文件 */
  createFile(path: string): Promise<void> {
    return invoke("fs_create_file", { path });
  },

  /** 创建目录 */
  createDirectory(path: string): Promise<void> {
    return invoke("fs_create_directory", { path });
  },

  /** 删除文件/目录（移到回收站） */
  deleteEntry(path: string): Promise<void> {
    return invoke("fs_delete_entry", { path });
  },

  /** 重命名 */
  renameEntry(oldPath: string, newName: string): Promise<void> {
    return invoke("fs_rename_entry", { oldPath, newName });
  },

  /** 复制 */
  copyEntry(src: string, destDir: string): Promise<void> {
    return invoke("fs_copy_entry", { src, destDir });
  },

  /** 移动 */
  moveEntry(src: string, destDir: string): Promise<void> {
    return invoke("fs_move_entry", { src, destDir });
  },

  /** 搜索文件名 */
  searchFiles(
    root: string,
    query: string,
    maxResults: number = 100
  ): Promise<SearchResult[]> {
    return invoke("fs_search_files", { root, query, maxResults });
  },

  /** 获取单个条目信息 */
  getEntryInfo(path: string): Promise<FsEntry> {
    return invoke("fs_get_entry_info", { path });
  },

  /** 获取 Git 文件状态（用于文件树着色） */
  getGitFileStatuses(rootPath: string): Promise<Record<string, string>> {
    return invoke("get_git_file_statuses", { path: rootPath });
  },
};
