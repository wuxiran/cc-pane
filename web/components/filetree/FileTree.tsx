import { useEffect, useCallback, useRef, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { handleErrorSilent } from "@/utils";
import { useFileTreeStore } from "@/stores";
import { usePanesStore } from "@/stores";
import { Skeleton } from "@/components/ui/skeleton";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import FileTreeNode from "./FileTreeNode";
import FileTreeContextMenu, { type FileTreeContextMenuApi } from "./FileTreeContextMenu";
import type { FileTreeNode as FileTreeNodeType } from "@/types/filesystem";

interface FileTreeProps {
  rootPath: string;
  compact?: boolean;
  onOpenTerminal?: (path: string) => void;
  /** 资源管理器模式：双击目录时切换浏览根目录 */
  onNavigateToDir?: (path: string) => void;
  /** 自定义文件打开行为（不使用默认 openEditor） */
  onOpenFile?: (filePath: string, fileName: string) => void;
}

/** 可见项（展开目录的子级可见），附带父路径供 ← 键回退 */
interface VisibleItem {
  node: FileTreeNodeType;
  parentPath: string | null;
}

function flattenVisible(root: FileTreeNodeType): VisibleItem[] {
  const out: VisibleItem[] = [];
  const walk = (n: FileTreeNodeType, parentPath: string | null) => {
    out.push({ node: n, parentPath });
    if (n.entry.isDir && n.expanded && n.children) {
      for (const child of n.children) walk(child, n.entry.path);
    }
  };
  walk(root, null);
  return out;
}

export default function FileTree({
  rootPath,
  compact = false,
  onOpenTerminal,
  onNavigateToDir,
  onOpenFile,
}: FileTreeProps) {
  const { t } = useTranslation(["sidebar"]);
  const tree = useFileTreeStore((s) => s.trees[rootPath]);
  const loadDirectory = useFileTreeStore((s) => s.loadDirectory);
  const toggleExpand = useFileTreeStore((s) => s.toggleExpand);
  const selectedFilePath = useFileTreeStore((s) => s.selectedFilePath);
  const setSelectedFilePath = useFileTreeStore((s) => s.setSelectedFilePath);
  const rawGitStatuses = useFileTreeStore((s) => s.gitStatuses[rootPath]);
  const loadGitStatuses = useFileTreeStore((s) => s.loadGitStatuses);
  const openEditor = usePanesStore((s) => s.openEditor);
  const showLoadingSkeleton = useDelayedLoading(!tree);

  // 用 ref 传递当前右键节点给 ContextMenu，避免受控 open 问题
  const contextNodeRef = useRef<FileTreeNodeType | null>(null);
  // F2 重命名等键盘操作入口，由 ContextMenu 挂载后写入
  const contextMenuApiRef = useRef<FileTreeContextMenuApi | null>(null);
  const treeContainerRef = useRef<HTMLDivElement>(null);
  // roving tabindex 的当前聚焦项
  const [focusedPath, setFocusedPath] = useState<string | null>(null);

  // 首次加载
  useEffect(() => {
    if (!tree) {
      loadDirectory(rootPath, rootPath).catch((e) => handleErrorSilent(e, "load directory"));
    }
    // 同步加载 git 状态
    loadGitStatuses(rootPath).catch(() => {});
  }, [rootPath, tree, loadDirectory, loadGitStatuses]);

  // 监听活动编辑器 Tab，自动同步高亮
  useEffect(() => {
    const unsub = usePanesStore.subscribe((state) => {
      const activeId = state.activePaneId;
      const pane = state.rootPane.type === "panel" && state.rootPane.id === activeId
        ? state.rootPane
        : null;
      // 递归查找活动面板
      const findPanel = (node: typeof state.rootPane): typeof pane => {
        if (node.type === "panel" && node.id === activeId) return node;
        if (node.type === "split") {
          for (const child of node.children) {
            const found = findPanel(child);
            if (found) return found;
          }
        }
        return null;
      };
      const panel = pane || findPanel(state.rootPane);
      if (!panel || panel.type !== "panel") return;
      const activeTab = panel.tabs.find((t) => t.id === panel.activeTabId);
      if (activeTab?.contentType === "editor" && activeTab.filePath) {
        setSelectedFilePath(activeTab.filePath);
      }
    });
    return unsub;
  }, [setSelectedFilePath]);

  // 计算包含目录冒泡的 git statuses
  const gitStatuses = useMemo(() => {
    if (!rawGitStatuses || Object.keys(rawGitStatuses).length === 0) return undefined;
    const merged: Record<string, string> = { ...rawGitStatuses };

    // 目录着色冒泡：优先级 modified > added > untracked
    const PRIORITY: Record<string, number> = {
      modified: 3,
      added: 2,
      untracked: 1,
      renamed: 2,
      deleted: 3,
    };

    for (const [filePath, status] of Object.entries(rawGitStatuses)) {
      // 向上遍历每级父目录
      const normalized = filePath.replace(/\\/g, "/");
      const normalizedRoot = rootPath.replace(/\\/g, "/");
      const parts = normalized.split("/");
      const newPriority = PRIORITY[status] || 0;
      // 从文件的父目录开始向上直到 rootPath
      for (let i = parts.length - 1; i >= 1; i--) {
        const dirPath = parts.slice(0, i).join("/");
        if (dirPath.length <= normalizedRoot.length) break;
        // 还原为原始路径分隔符
        const originalDirPath = filePath.includes("\\")
          ? dirPath.replace(/\//g, "\\")
          : dirPath;

        const existing = merged[originalDirPath];
        const existingPriority = existing ? (PRIORITY[existing] || 0) : 0;
        if (existingPriority >= newPriority) continue; // 已有更高优先级，跳过
        merged[originalDirPath] = status;
      }
    }

    return merged;
  }, [rawGitStatuses, rootPath]);

  const handleToggle = useCallback(
    (path: string) => {
      toggleExpand(rootPath, path).catch((e) => handleErrorSilent(e, "toggle expand"));
    },
    [rootPath, toggleExpand]
  );

  const handleFileClick = useCallback(
    (filePath: string) => {
      const fileName = filePath.split(/[/\\]/).pop() || "File";
      if (onOpenFile) {
        onOpenFile(filePath, fileName);
      } else {
        openEditor(rootPath, filePath, fileName);
      }
      setSelectedFilePath(filePath);
    },
    [rootPath, openEditor, setSelectedFilePath, onOpenFile]
  );

  const handleContextMenu = useCallback(
    (_e: React.MouseEvent, node: FileTreeNodeType) => {
      contextNodeRef.current = node;
    },
    []
  );

  // 可见项扁平化（仅展开目录的子级参与键盘导航）
  const visibleItems = useMemo(() => (tree ? flattenVisible(tree) : []), [tree]);

  // 聚焦项失效（折叠/删除后）时回退到首个可见项
  const activePath =
    focusedPath && visibleItems.some((v) => v.node.entry.path === focusedPath)
      ? focusedPath
      : visibleItems[0]?.node.entry.path ?? null;

  const focusItem = useCallback((path: string) => {
    setFocusedPath(path);
    const container = treeContainerRef.current;
    if (!container) return;
    for (const row of container.querySelectorAll("[data-file-path]")) {
      if (row.getAttribute("data-file-path") === path) {
        (row as HTMLElement).focus();
        return;
      }
    }
  }, []);

  // 树键盘导航：↑/↓ 移动，→ 展开或进首个子项，← 折叠或回父项，
  // Enter 打开文件/切换目录，F2 重命名，Menu 键打开右键菜单
  const handleTreeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!activePath) return;
      const index = visibleItems.findIndex((v) => v.node.entry.path === activePath);
      if (index < 0) return;
      const current = visibleItems[index];

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          const next = visibleItems[Math.min(index + 1, visibleItems.length - 1)];
          if (next && next.node.entry.path !== activePath) focusItem(next.node.entry.path);
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          const prev = visibleItems[Math.max(index - 1, 0)];
          if (prev && prev.node.entry.path !== activePath) focusItem(prev.node.entry.path);
          break;
        }
        case "ArrowRight": {
          if (!current.node.entry.isDir) break;
          e.preventDefault();
          if (!current.node.expanded) {
            handleToggle(current.node.entry.path);
          } else {
            const next = visibleItems[index + 1];
            if (next && next.parentPath === current.node.entry.path) {
              focusItem(next.node.entry.path);
            }
          }
          break;
        }
        case "ArrowLeft": {
          e.preventDefault();
          if (current.node.entry.isDir && current.node.expanded) {
            handleToggle(current.node.entry.path);
          } else if (current.parentPath) {
            focusItem(current.parentPath);
          }
          break;
        }
        case "Enter": {
          e.preventDefault();
          if (current.node.entry.isDir) {
            handleToggle(current.node.entry.path);
          } else {
            handleFileClick(current.node.entry.path);
          }
          break;
        }
        case "F2": {
          e.preventDefault();
          contextNodeRef.current = current.node;
          contextMenuApiRef.current?.openRename();
          break;
        }
        case "ContextMenu": {
          e.preventDefault();
          const container = treeContainerRef.current;
          if (!container) break;
          for (const row of container.querySelectorAll("[data-file-path]")) {
            if (row.getAttribute("data-file-path") === activePath) {
              const rect = row.getBoundingClientRect();
              row.dispatchEvent(
                new MouseEvent("contextmenu", {
                  bubbles: true,
                  cancelable: true,
                  clientX: rect.left + 8,
                  clientY: rect.top + rect.height / 2,
                }),
              );
              break;
            }
          }
          break;
        }
      }
    },
    [activePath, visibleItems, focusItem, handleToggle, handleFileClick],
  );

  const handleFocusNode = useCallback((path: string) => {
    setFocusedPath(path);
  }, []);

  if (!tree) {
    // 目录读取超过 300ms 才显示骨架行，避免快加载闪占位
    if (!showLoadingSkeleton) return null;
    return (
      <div
        className="flex flex-col py-1"
        aria-busy="true"
        aria-hidden="true"
        data-testid="file-tree-skeleton"
      >
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="flex h-7 items-center gap-1.5 px-2"
            style={{ paddingLeft: (i % 3) * 14 + 12 }}
          >
            <Skeleton className="size-4 shrink-0 rounded" />
            <Skeleton className="h-3.5 flex-1" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <FileTreeContextMenu
      nodeRef={contextNodeRef}
      rootPath={rootPath}
      onOpenTerminal={onOpenTerminal}
      apiRef={contextMenuApiRef}
    >
      <div className="flex flex-col h-full overflow-hidden">
        <div
          ref={treeContainerRef}
          role="tree"
          aria-label={t("sidebar:filetree.treeLabel")}
          className="app-scrollbar flex-1 overflow-y-auto overflow-x-hidden"
          onKeyDown={handleTreeKeyDown}
        >
          <FileTreeNode
            node={tree}
            depth={0}
            compact={compact}
            rootPath={rootPath}
            selectedFilePath={selectedFilePath}
            gitStatuses={gitStatuses}
            focusedPath={activePath}
            onToggle={handleToggle}
            onFileClick={handleFileClick}
            onContextMenu={handleContextMenu}
            onDirDoubleClick={onNavigateToDir}
            onFocusNode={handleFocusNode}
          />
        </div>
      </div>
    </FileTreeContextMenu>
  );
}
