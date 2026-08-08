/** 文件系统条目 */
export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  isFile: boolean;
  isSymlink: boolean;
  size: number;
  modified: string | null;
  extension: string | null;
  hidden: boolean;
  permissions?: string | null;
}

/** 目录列表 */
export interface DirListing {
  path: string;
  entries: FsEntry[];
}

/** 文件内容 */
export interface FileContent {
  path: string;
  content: string;
  encoding: string;
  size: number;
  language: string | null;
}

export interface ImageFileContent {
  path: string;
  dataBase64: string;
  mimeType: string;
  size: number;
}

/** 文件树节点（用于前端树结构） */
export interface FileTreeNode {
  entry: FsEntry;
  children: FileTreeNode[] | null; // null = 未加载
  expanded: boolean;
  loading: boolean;
}

export interface ProjectFileSearchResult {
  paths: string[];
  truncated: boolean;
}

export interface ProjectContentMatch {
  path: string;
  line: number;
  preview: string;
}

export interface ProjectContentSearchResult {
  matches: ProjectContentMatch[];
  truncated: boolean;
  timedOut: boolean;
}
