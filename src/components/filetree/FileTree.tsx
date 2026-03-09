import { useEffect, useCallback, useRef, useMemo } from "react";
import { handleErrorSilent } from "@/utils";
import { useFileTreeStore } from "@/stores";
import { usePanesStore } from "@/stores";
import FileTreeNode from "./FileTreeNode";
import FileTreeContextMenu from "./FileTreeContextMenu";
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

export default function FileTree({
  rootPath,
  compact = false,
  onOpenTerminal,
  onNavigateToDir,
  onOpenFile,
}: FileTreeProps) {
  const tree = useFileTreeStore((s) => s.trees[rootPath]);
  const loadDirectory = useFileTreeStore((s) => s.loadDirectory);
  const toggleExpand = useFileTreeStore((s) => s.toggleExpand);
  const selectedFilePath = useFileTreeStore((s) => s.selectedFilePath);
  const setSelectedFilePath = useFileTreeStore((s) => s.setSelectedFilePath);
  const rawGitStatuses = useFileTreeStore((s) => s.gitStatuses[rootPath]);
  const loadGitStatuses = useFileTreeStore((s) => s.loadGitStatuses);
  const openEditor = usePanesStore((s) => s.openEditor);

  // 用 ref 传递当前右键节点给 ContextMenu，避免受控 open 问题
  const contextNodeRef = useRef<FileTreeNodeType | null>(null);

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

  if (!tree) {
    return (
      <div className="flex items-center justify-center py-4 text-xs text-muted-foreground">
        Loading...
      </div>
    );
  }

  return (
    <FileTreeContextMenu
      nodeRef={contextNodeRef}
      rootPath={rootPath}
      onOpenTerminal={onOpenTerminal}
    >
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          <FileTreeNode
            node={tree}
            depth={0}
            compact={compact}
            rootPath={rootPath}
            selectedFilePath={selectedFilePath}
            gitStatuses={gitStatuses}
            onToggle={handleToggle}
            onFileClick={handleFileClick}
            onContextMenu={handleContextMenu}
            onDirDoubleClick={onNavigateToDir}
          />
        </div>
      </div>
    </FileTreeContextMenu>
  );
}
