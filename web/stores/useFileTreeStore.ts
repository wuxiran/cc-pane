import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { filesystemService } from "@/services/filesystemService";
import type { FileTreeNode, SearchResult } from "@/types/filesystem";

interface FileTreeState {
  /** rootPath → 根节点（entry + children） */
  trees: Record<string, FileTreeNode>;
  /** 是否显示隐藏文件 */
  showHidden: boolean;
  /** 当前选中/高亮的文件路径 */
  selectedFilePath: string | null;
  /** rootPath → (filePath → git status) */
  gitStatuses: Record<string, Record<string, string>>;

  /** 加载目录（首次加载或刷新） */
  loadDirectory: (rootPath: string, dirPath: string) => Promise<void>;
  /** 展开/折叠节点 */
  toggleExpand: (rootPath: string, dirPath: string) => Promise<void>;
  /** 刷新整棵树或指定目录 */
  refresh: (rootPath: string, dirPath?: string) => Promise<void>;
  /** 搜索文件 */
  searchFiles: (rootPath: string, query: string) => Promise<SearchResult[]>;
  /** 清除指定根路径的文件树缓存 */
  clearTree: (rootPath: string) => void;
  /** 切换隐藏文件显示 */
  toggleShowHidden: () => void;
  /** 设置当前选中文件路径 */
  setSelectedFilePath: (path: string | null) => void;
  /** 在文件树中展开并高亮指定文件 */
  revealFile: (rootPath: string, filePath: string) => Promise<void>;
  /** 折叠所有子节点（保持根节点展开） */
  collapseAll: (rootPath: string) => void;
  /** 加载 Git 文件状态 */
  loadGitStatuses: (rootPath: string) => Promise<void>;

  // CRUD 操作后自动刷新父目录
  createFile: (parentDir: string, name: string, rootPath: string) => Promise<void>;
  createDirectory: (parentDir: string, name: string, rootPath: string) => Promise<void>;
  deleteEntry: (path: string, rootPath: string) => Promise<void>;
  renameEntry: (oldPath: string, newName: string, rootPath: string) => Promise<void>;
  copyEntry: (src: string, destDir: string, rootPath: string) => Promise<void>;
  moveEntry: (src: string, destDir: string, rootPath: string) => Promise<void>;
}

/** 规范化路径分隔符，统一为正斜杠 */
function normPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/** 递归查找节点（路径比较兼容 Windows 正反斜杠混合） */
function findNode(node: FileTreeNode, dirPath: string): FileTreeNode | null {
  if (normPath(node.entry.path) === normPath(dirPath)) return node;
  if (node.children) {
    for (const child of node.children) {
      const found = findNode(child, dirPath);
      if (found) return found;
    }
  }
  return null;
}

/** 获取路径的父目录（兼容 Windows 混合路径分隔符） */
function parentDir(filePath: string): string {
  // 找到最后一个分隔符的位置（兼容 / 和 \）
  const lastSep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (lastSep <= 0) return filePath;
  return filePath.slice(0, lastSep);
}

export const useFileTreeStore = create<FileTreeState>()(
  immer((set, get) => ({
    trees: {},
    showHidden: false,
    selectedFilePath: null,
    gitStatuses: {},

    loadDirectory: async (rootPath, dirPath) => {
      // 标记 loading
      set((state) => {
        const root = state.trees[rootPath];
        if (!root) return;
        const node = findNode(root, dirPath);
        if (node) node.loading = true;
      });

      try {
        const listing = await filesystemService.listDirectory(
          dirPath,
          get().showHidden
        );
        set((state) => {
          let root = state.trees[rootPath];
          if (!root) {
            // 首次加载：创建根节点
            state.trees[rootPath] = {
              entry: {
                name: rootPath.split(/[/\\]/).pop() || rootPath,
                path: listing.path,
                isDir: true,
                isFile: false,
                isSymlink: false,
                size: 0,
                modified: null,
                extension: null,
                hidden: false,
              },
              children: listing.entries.map((e) => ({
                entry: e,
                children: e.isDir ? null : [],
                expanded: false,
                loading: false,
              })),
              expanded: true,
              loading: false,
            };
            return;
          }

          const node = findNode(root, dirPath);
          if (node) {
            // 保留已展开子节点的状态
            const existingMap = new Map<string, FileTreeNode>();
            if (node.children) {
              for (const child of node.children) {
                existingMap.set(child.entry.path, child);
              }
            }
            node.children = listing.entries.map((e) => {
              const existing = existingMap.get(e.path);
              if (existing && e.isDir && existing.expanded) {
                return { ...existing, entry: e };
              }
              return {
                entry: e,
                children: e.isDir ? null : [],
                expanded: false,
                loading: false,
              };
            });
            node.loading = false;
          }
        });
      } catch (err) {
        set((state) => {
          const root = state.trees[rootPath];
          if (!root) return;
          const node = findNode(root, dirPath);
          if (node) {
            node.loading = false;
            // 设为 null 而非 []，允许下次展开时重试加载
            node.children = null;
          }
        });
        throw err;
      }
    },

    toggleExpand: async (rootPath, dirPath) => {
      const root = get().trees[rootPath];
      if (!root) return;
      const node = findNode(root, dirPath);
      if (!node || !node.entry.isDir) return;

      if (node.expanded) {
        // 折叠
        set((state) => {
          const r = state.trees[rootPath];
          if (!r) return;
          const n = findNode(r, dirPath);
          if (n) n.expanded = false;
        });
      } else {
        // 展开：如果未加载子节点，先加载
        set((state) => {
          const r = state.trees[rootPath];
          if (!r) return;
          const n = findNode(r, dirPath);
          if (n) n.expanded = true;
        });
        if (!node.children) {
          await get().loadDirectory(rootPath, dirPath);
        }
      }
    },

    refresh: async (rootPath, dirPath?) => {
      const target = dirPath || rootPath;
      await get().loadDirectory(rootPath, target);
    },

    searchFiles: async (rootPath, query) => {
      return filesystemService.searchFiles(rootPath, query, 100);
    },

    clearTree: (rootPath) => {
      set((state) => {
        delete state.trees[rootPath];
        delete state.gitStatuses[rootPath];
      });
    },

    toggleShowHidden: () => {
      set((state) => {
        state.showHidden = !state.showHidden;
      });
      // 自动刷新所有已加载的树
      const trees = get().trees;
      for (const rootPath of Object.keys(trees)) {
        get().refresh(rootPath).catch(() => {});
      }
    },

    setSelectedFilePath: (path) => {
      set((state) => {
        state.selectedFilePath = path;
      });
    },

    revealFile: async (rootPath, filePath) => {
      // 解析出从 rootPath 到 filePath 的每级目录
      const normalized = filePath.replace(/\\/g, "/");
      const normalizedRoot = rootPath.replace(/\\/g, "/");
      if (!normalized.startsWith(normalizedRoot)) return;

      const relative = normalized.slice(normalizedRoot.length).replace(/^\//, "");
      const parts = relative.split("/");

      // 依次展开每级目录（最后一个是文件名，不需要展开）
      let currentPath = rootPath;
      for (let i = 0; i < parts.length - 1; i++) {
        const sep = currentPath.includes("\\") ? "\\" : "/";
        currentPath = currentPath + sep + parts[i];
        const root = get().trees[rootPath];
        if (!root) break;
        const node = findNode(root, currentPath);
        if (node && node.entry.isDir && !node.expanded) {
          await get().toggleExpand(rootPath, currentPath);
        }
      }

      // 高亮目标文件
      set((state) => {
        state.selectedFilePath = filePath;
      });

      // 滚动到目标元素
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-file-path="${CSS.escape(filePath)}"]`);
        el?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    },

    collapseAll: (rootPath) => {
      set((state) => {
        const root = state.trees[rootPath];
        if (!root) return;
        const collapse = (node: FileTreeNode) => {
          node.expanded = false;
          if (node.children) {
            for (const child of node.children) collapse(child);
          }
        };
        // 折叠整棵树（包括根节点）
        collapse(root);
      });
    },

    loadGitStatuses: async (rootPath) => {
      try {
        const statuses = await filesystemService.getGitFileStatuses(rootPath);
        set((state) => {
          state.gitStatuses[rootPath] = statuses;
        });
      } catch {
        // 非 git 仓库或其他错误 → 置空
        set((state) => {
          state.gitStatuses[rootPath] = {};
        });
      }
    },

    createFile: async (parentDirPath, name, rootPath) => {
      const trimmed = parentDirPath.replace(/[/\\]+$/, "");
      const sep = trimmed.includes("\\") ? "\\" : "/";
      const fullPath = `${trimmed}${sep}${name}`;
      await filesystemService.createFile(fullPath);
      await get().refresh(rootPath, parentDirPath);
    },

    createDirectory: async (parentDirPath, name, rootPath) => {
      const trimmed = parentDirPath.replace(/[/\\]+$/, "");
      const sep = trimmed.includes("\\") ? "\\" : "/";
      const fullPath = `${trimmed}${sep}${name}`;
      await filesystemService.createDirectory(fullPath);
      await get().refresh(rootPath, parentDirPath);
    },

    deleteEntry: async (path, rootPath) => {
      await filesystemService.deleteEntry(path);
      const parent = parentDir(path);
      await get().refresh(rootPath, parent);
    },

    renameEntry: async (oldPath, newName, rootPath) => {
      await filesystemService.renameEntry(oldPath, newName);
      const parent = parentDir(oldPath);
      await get().refresh(rootPath, parent);
    },

    copyEntry: async (src, destDir, rootPath) => {
      await filesystemService.copyEntry(src, destDir);
      await get().refresh(rootPath, destDir);
    },

    moveEntry: async (src, destDir, rootPath) => {
      await filesystemService.moveEntry(src, destDir);
      const srcParent = parentDir(src);
      await get().refresh(rootPath, srcParent);
      if (srcParent !== destDir) {
        await get().refresh(rootPath, destDir);
      }
    },
  }))
);
