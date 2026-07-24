import { memo, useCallback } from "react";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Database,
  File,
  FileCode,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Image,
  Loader2,
  Terminal,
} from "lucide-react";
import type { FileTreeNode as FileTreeNodeType } from "@/types/filesystem";

interface FileTreeNodeProps {
  node: FileTreeNodeType;
  depth: number;
  compact?: boolean;
  rootPath: string;
  selectedFilePath?: string | null;
  gitStatuses?: Record<string, string>;
  onToggle: (path: string) => void;
  onFileClick: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, node: FileTreeNodeType) => void;
  onDirDoubleClick?: (path: string) => void;
}

/** 文件类型保留形状区分，颜色统一退到中性层。 */
export function getFileIcon(ext: string | null, size = 16): React.ReactNode {
  const className = "shrink-0 text-[var(--app-text-tertiary)]";
  if (!ext) return <File size={size} className={className} />;

  switch (ext.toLowerCase()) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "py":
    case "vue":
    case "css":
    case "scss":
    case "less":
    case "java":
    case "rs":
    case "go":
    case "html":
    case "htm":
    case "xml":
    case "svg":
    case "c":
    case "cpp":
    case "h":
    case "hpp":
    case "rb":
    case "php":
    case "swift":
    case "kt":
    case "dart":
    case "lua":
    case "graphql":
      return <FileCode size={size} className={className} />;
    case "json":
    case "jsonc":
    case "yaml":
    case "yml":
    case "toml":
    case "ini":
    case "cfg":
      return <FileJson size={size} className={className} />;
    case "sh":
    case "bash":
    case "zsh":
    case "ps1":
    case "bat":
      return <Terminal size={size} className={className} />;
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "ico":
    case "webp":
    case "bmp":
      return <Image size={size} className={className} />;
    case "zip":
    case "rar":
    case "tar":
    case "gz":
    case "7z":
      return <Archive size={size} className={className} />;
    case "md":
    case "mdx":
    case "txt":
    case "log":
    case "csv":
      return <FileText size={size} className={className} />;
    case "sql":
      return <Database size={size} className={className} />;
    default:
      return <File size={size} className={className} />;
  }
}

/** 与 ExplorerGitSection 同源的状态色 + 单字母形状冗余。 */
const GIT_STATUS_BADGES: Record<string, { letter: string; className: string }> = {
  modified: { letter: "M", className: "text-[var(--app-status-warning)]" },
  added: { letter: "A", className: "text-[var(--app-status-success)]" },
  deleted: { letter: "D", className: "text-[var(--app-status-danger)]" },
  untracked: { letter: "U", className: "text-[var(--app-status-success)]" },
  renamed: { letter: "R", className: "text-[var(--app-accent)]" },
};

export default memo(function FileTreeNode({
  node,
  depth,
  compact,
  rootPath,
  selectedFilePath,
  gitStatuses,
  onToggle,
  onFileClick,
  onContextMenu,
  onDirDoubleClick,
}: FileTreeNodeProps) {
  const handleClick = useCallback(() => {
    if (node.entry.isDir) {
      onToggle(node.entry.path);
    } else {
      onFileClick(node.entry.path);
    }
  }, [node.entry.isDir, node.entry.path, onToggle, onFileClick]);

  const handleDoubleClick = useCallback(() => {
    if (node.entry.isDir && onDirDoubleClick) {
      onDirDoubleClick(node.entry.path);
    }
  }, [node.entry.isDir, node.entry.path, onDirDoubleClick]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      onContextMenu(e, node);
    },
    [node, onContextMenu],
  );

  const paddingLeft = depth * 14 + 12;
  const isSelected = !node.entry.isDir && node.entry.path === selectedFilePath;
  const gitStatus = gitStatuses?.[node.entry.path];
  const gitBadge = gitStatus ? GIT_STATUS_BADGES[gitStatus] : undefined;

  return (
    <>
      <div
        className={`group flex h-7 cursor-pointer select-none items-center gap-1.5 rounded-md px-2 text-[var(--app-text-primary)] transition-colors ${
          isSelected ? "bg-[var(--editor-selection-bg)]" : "hover:bg-[var(--app-hover)]"
        }`}
        style={{ paddingLeft }}
        data-file-path={node.entry.path}
        data-current={isSelected ? "true" : undefined}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
      >
        {node.entry.isDir ? (
          node.loading ? (
            <Loader2
              size={16}
              className="shrink-0 animate-spin text-[var(--app-text-tertiary)]"
            />
          ) : node.expanded ? (
            <ChevronDown size={16} className="shrink-0 text-[var(--app-text-tertiary)]" />
          ) : (
            <ChevronRight size={16} className="shrink-0 text-[var(--app-text-tertiary)]" />
          )
        ) : (
          <span className="w-4 shrink-0" />
        )}

        {node.entry.isDir ? (
          node.expanded ? (
            <FolderOpen size={16} className="shrink-0 text-[var(--app-accent)]" />
          ) : (
            <Folder size={16} className="shrink-0 text-[var(--app-accent)]" />
          )
        ) : (
          getFileIcon(node.entry.extension)
        )}

        <span
          className={`min-w-0 flex-1 truncate text-[13px] leading-5 text-[var(--app-text-primary)] ${
            node.entry.isDir ? "font-semibold" : ""
          }`}
        >
          {node.entry.name}
        </span>
        {gitBadge && (
          <span
            className={`ml-auto w-4 shrink-0 text-right text-xs font-semibold leading-none ${gitBadge.className}`}
            title={gitStatus}
          >
            {gitBadge.letter}
          </span>
        )}
      </div>

      {node.entry.isDir && node.expanded && node.children && (
        <div>
          {node.children.map((child) => (
            <FileTreeNode
              key={child.entry.path}
              node={child}
              depth={depth + 1}
              compact={compact}
              rootPath={rootPath}
              selectedFilePath={selectedFilePath}
              gitStatuses={gitStatuses}
              onToggle={onToggle}
              onFileClick={onFileClick}
              onContextMenu={onContextMenu}
              onDirDoubleClick={onDirDoubleClick}
            />
          ))}
        </div>
      )}
    </>
  );
});
