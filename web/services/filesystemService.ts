import type {
  DirListing,
  FileContent,
  FsEntry,
  ProjectContentSearchResult,
  ProjectFileSearchResult,
} from "@/types/filesystem";
import { apiGet, apiJson, invokeOrApi } from "./apiClient";

/** 文件系统服务 — 封装所有 fs_* IPC 调用 */
export const filesystemService = {
  /** 列出一级目录内容 */
  listDirectory(path: string, showHidden: boolean): Promise<DirListing> {
    return invokeOrApi<DirListing>("fs_list_directory", { path, showHidden }, () =>
      apiGet<DirListing>("/api/fs/list", { path, showHidden }),
    );
  },

  /** 读取文件内容 */
  readFile(path: string): Promise<FileContent> {
    return invokeOrApi<FileContent>("fs_read_file", { path }, () =>
      apiGet<FileContent>("/api/fs/read", { path }),
    );
  },

  /** 写入文件 */
  writeFile(path: string, content: string): Promise<void> {
    return invokeOrApi<void>("fs_write_file", { path, content }, () =>
      apiJson<void>("/api/fs/write", "POST", { path, content }),
    );
  },

  /** 创建空文件 */
  createFile(path: string): Promise<void> {
    return invokeOrApi<void>("fs_create_file", { path }, () =>
      apiJson<void>("/api/fs/create-file", "POST", { path }),
    );
  },

  /** 创建目录 */
  createDirectory(path: string): Promise<void> {
    return invokeOrApi<void>("fs_create_directory", { path }, () =>
      apiJson<void>("/api/fs/create-directory", "POST", { path }),
    );
  },

  /** 删除文件/目录（默认移到回收站；permanent 为 true 时永久删除） */
  deleteEntry(path: string, permanent = false): Promise<void> {
    return invokeOrApi<void>("fs_delete_entry", { path, permanent }, () =>
      apiJson<void>("/api/fs/delete", "POST", { path, permanent }),
    );
  },

  /** 重命名 */
  renameEntry(oldPath: string, newName: string): Promise<void> {
    return invokeOrApi<void>("fs_rename_entry", { oldPath, newName }, () =>
      apiJson<void>("/api/fs/rename", "POST", { oldPath, newName }),
    );
  },

  /** 复制 */
  copyEntry(src: string, destDir: string): Promise<void> {
    return invokeOrApi<void>("fs_copy_entry", { src, destDir }, () =>
      apiJson<void>("/api/fs/copy", "POST", { src, destDir }),
    );
  },

  /** 移动 */
  moveEntry(src: string, destDir: string): Promise<void> {
    return invokeOrApi<void>("fs_move_entry", { src, destDir }, () =>
      apiJson<void>("/api/fs/move", "POST", { src, destDir }),
    );
  },

  /** 获取单个条目信息 */
  getEntryInfo(path: string): Promise<FsEntry> {
    return invokeOrApi<FsEntry>("fs_get_entry_info", { path }, () =>
      apiGet<FsEntry>("/api/fs/info", { path }),
    );
  },

  /** 获取 Git 文件状态（用于文件树着色） */
  getGitFileStatuses(rootPath: string): Promise<Record<string, string>> {
    return invokeOrApi<Record<string, string>>("get_git_file_statuses", { path: rootPath }, () =>
      apiGet<Record<string, string>>("/api/git/file-statuses", { path: rootPath }),
    );
  },

  searchProjectFiles(root: string, query: string, limit = 200): Promise<ProjectFileSearchResult> {
    return invokeOrApi<ProjectFileSearchResult>(
      "search_project_files",
      { root, query, limit },
      () => apiGet<ProjectFileSearchResult>("/api/fs/search/files", { root, query, limit }),
    );
  },

  searchProjectContents(
    root: string,
    query: string,
    limit = 300,
  ): Promise<ProjectContentSearchResult> {
    return invokeOrApi<ProjectContentSearchResult>(
      "search_project_contents",
      { root, query, limit },
      () => apiGet<ProjectContentSearchResult>("/api/fs/search/contents", { root, query, limit }),
    );
  },
};
