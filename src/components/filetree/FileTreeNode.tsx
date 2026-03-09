import { memo, useCallback } from "react";
import {
  ChevronRight, ChevronDown, Folder, FolderOpen,
  File, FileJson, Image, FileText, FileCode,
  Archive, Loader2, Terminal, Database,
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

/* ── 自定义品牌 SVG 图标 (24x24 viewBox) ── */

function JsIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="shrink-0">
      <path d="M0 0h24v24H0V0z" fill="#F7DF1E" />
      <path d="M22.034 18.276c-.175-1.095-.888-2.015-3.003-2.873-.736-.345-1.554-.585-1.797-1.14-.091-.33-.105-.51-.046-.705.15-.646.915-.84 1.515-.66.39.12.75.42.976.9 1.034-.676 1.034-.676 1.755-1.125-.27-.42-.405-.6-.586-.78-.63-.705-1.469-1.065-2.834-1.034l-.705.089c-.676.165-1.32.525-1.71 1.005-1.14 1.275-.81 3.51.585 4.44 1.38 1.005 3.405 1.23 3.66 2.174.24 1.14-.87 1.504-1.965 1.374-.81-.18-1.26-.585-1.755-1.336l-1.83 1.051c.21.48.45.689.81 1.109 1.74 1.756 6.09 1.666 6.871-1.004.029-.09.24-.705.074-1.65l.008.005zm-8.983-8.905h-2.248c0 1.938-.009 3.864-.009 5.805 0 1.232.063 2.363-.138 2.711-.33.689-1.18.601-1.566.48-.396-.196-.594-.466-.84-.9-.066-.12-.115-.21-.138-.21l-1.844 1.14c.309.63.756 1.17 1.324 1.517.855.494 2.004.675 3.207.405.783-.226 1.458-.691 1.811-1.411.51-.93.402-2.07.397-3.346.012-2.054 0-4.109 0-6.179l.004-.012z" fill="#323330" />
    </svg>
  );
}

function TypeScriptIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="shrink-0">
      <path d="M0 0h24v24H0V0z" fill="#3178C6" />
      <path d="M4.807 13.093h2.083v6.674h2.381v-6.674h2.083v-1.97H4.807v1.97zm9.122-1.97v8.644c.95.22 1.758.332 2.673.332 2.42 0 3.88-1.233 3.88-3.146 0-1.69-1.001-2.67-3.165-3.234-.903-.264-1.376-.553-1.376-1.082 0-.478.394-.784 1.056-.784.645 0 1.294.227 1.87.633l1.072-1.706c-.78-.538-1.767-.833-2.934-.833-2.198 0-3.655 1.196-3.655 3.027 0 1.527.887 2.508 2.96 3.116 1.12.34 1.559.596 1.559 1.143 0 .558-.473.885-1.282.885-.834 0-1.63-.28-2.417-.837l-.003 2.255-.238.585z" fill="#fff" />
    </svg>
  );
}

function PythonIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="shrink-0" fill="none">
      <path d="M11.914 0C5.82 0 6.2 2.656 6.2 2.656l.007 2.752h5.814v.826H3.9S0 5.789 0 11.969c0 6.18 3.403 5.96 3.403 5.96h2.03v-2.867s-.109-3.42 3.35-3.42h5.766s3.24.052 3.24-3.148V3.202S18.28 0 11.914 0zM8.708 1.85a1.06 1.06 0 110 2.12 1.06 1.06 0 010-2.12z" fill="#3572A5" />
      <path d="M12.086 24c6.094 0 5.714-2.656 5.714-2.656l-.007-2.752h-5.814v-.826h8.121S24 18.211 24 12.031c0-6.18-3.403-5.96-3.403-5.96h-2.03v2.867s.109 3.42-3.35 3.42H9.451s-3.24-.052-3.24 3.148v5.292S5.72 24 12.086 24zm3.206-1.85a1.06 1.06 0 110-2.12 1.06 1.06 0 010 2.12z" fill="#FFD43B" />
    </svg>
  );
}

function VueIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="shrink-0">
      <path d="M24 1.61h-6.894L12 9.597 6.894 1.61H0L12 22.39 24 1.61z" fill="#41B883" />
      <path d="M24 1.61h-6.894L12 9.597 6.894 1.61H0l4.8 8.3L12 22.39l7.2-12.48 4.8-8.3zM19.562 3.61L12 16.84 4.438 3.61h3.168L12 11.349l4.394-7.74h3.168z" fill="#41B883" />
      <path d="M4.438 3.61L12 16.84l7.562-13.23h-3.168L12 11.349 7.606 3.61H4.438z" fill="#34495E" />
    </svg>
  );
}

function CssIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="shrink-0">
      <path d="M1.5 0h21l-1.91 21.563L11.977 24l-8.565-2.438L1.5 0z" fill="#264DE4" />
      <path d="M12 2.25v19.512l6.93-1.922L20.58 2.25H12z" fill="#2965F1" />
      <path d="M5.95 9.045l.225 2.52H12v-2.52H5.95zM5.49 6.165H12V3.645H3l.225 2.52zM12 17.157l-.032.009-2.93-.792-.187-2.1H6.303l.369 4.125 5.296 1.47.032-.009v-2.703z" fill="#EBEBEB" />
      <path d="M11.985 9.045v2.52h5.82l-.549 6.108-5.271 1.422v2.703l5.3-1.47.039-.435L18.127 9.045h-.698zM11.985 6.165v-2.52H21l-.186 2.52h-8.829z" fill="#FFF" />
    </svg>
  );
}

function MarkdownIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="shrink-0 text-blue-600">
      <rect x="0.5" y="3.5" width="23" height="17" rx="2" ry="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4 16V8l3.5 4L11 8v8M14.5 12.5L17 15.5l2.5-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GoIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="shrink-0">
      <path d="M1.811 10.231c-.047 0-.058-.023-.035-.059l.246-.315c.023-.035.081-.058.128-.058h4.172c.046 0 .058.035.035.07l-.199.303c-.023.036-.082.07-.117.07zM.047 11.306c-.047 0-.059-.023-.035-.058l.245-.316c.023-.035.082-.058.129-.058h5.328c.047 0 .07.035.058.07l-.093.28c-.012.047-.058.07-.105.07zm2.828 1.075c-.047 0-.059-.035-.035-.07l.163-.292c.023-.035.07-.07.117-.07h2.337c.047 0 .07.035.07.082l-.023.28c0 .047-.047.082-.082.082zm12.129-2.36c-.736.187-1.239.327-1.963.514-.176.046-.187.058-.34-.117-.174-.199-.303-.327-.548-.444-.737-.362-1.45-.257-2.115.175-.789.514-1.195 1.273-1.183 2.196.012.91.629 1.659 1.53 1.776.786.105 1.448-.14 1.963-.726.105-.129.198-.27.315-.433H10.86c-.245 0-.304-.152-.222-.35.152-.362.432-.968.596-1.273.035-.07.117-.187.268-.187h4.348c-.023.292-.023.584-.07.876-.117.702-.363 1.366-.756 1.963-.721 1.088-1.683 1.858-2.898 2.22-.99.293-1.94.257-2.84-.187-1.075-.538-1.745-1.378-2.02-2.523-.327-1.367-.023-2.64.757-3.786.804-1.18 1.87-1.928 3.224-2.22.97-.21 1.91-.152 2.792.327.584.315 1.04.768 1.378 1.343.117.187.082.28-.152.339z" fill="#00ADD8" />
      <path d="M18.934 18.477c-.915-.047-1.777-.234-2.569-.714-.657-.398-1.122-.936-1.366-1.659-.339-1.006-.247-1.963.223-2.875.548-1.064 1.413-1.729 2.545-2.058.908-.27 1.812-.28 2.685.058.83.316 1.437.87 1.8 1.671.467 1.041.408 2.07-.093 3.065-.572 1.134-1.5 1.835-2.697 2.209-.351.105-.71.152-1.064.187-.152.012-.304.012-.456.023zm2.289-4.453c-.012-.152-.023-.268-.047-.385-.198-1.006-.99-1.578-2.008-1.46-.99.116-1.683.67-2.058 1.576-.292.703-.293 1.437.023 2.14.245.537.733.885 1.342.95.813.082 1.518-.199 2.046-.874.398-.516.596-1.11.702-1.947z" fill="#00ADD8" />
    </svg>
  );
}

function RustIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="shrink-0 text-[#CE412B]">
      <path d="M23.834 11.703l-1.707-.956a12.787 12.787 0 00-.073-.505l1.449-1.278a.393.393 0 00-.083-.594l-.609-.358a.393.393 0 00-.554.14l-.955 1.575a10.21 10.21 0 00-.428-.283l.676-1.78a.393.393 0 00-.312-.52l-.684-.106a.393.393 0 00-.445.36l-.12 1.918a11.628 11.628 0 00-.482-.137l-.122-1.265a.393.393 0 00-.41-.353l-.482.03a.393.393 0 00-.371.413l.082 1.258c-.325.02-.649.056-.972.106l-.537-1.17a.393.393 0 00-.499-.193l-.443.178a.393.393 0 00-.23.505l.452 1.145a10.24 10.24 0 00-.867.396l-.832-.976a.393.393 0 00-.546-.062l-.397.31a.393.393 0 00-.076.55l.732 1.01a11.6 11.6 0 00-.743.603l-1.077-.67a.393.393 0 00-.54.127l-.2.345a.393.393 0 00.12.545l1.048.672a12.11 12.11 0 00-.548.728l-1.22-.329a.393.393 0 00-.477.27l-.135.488a.393.393 0 00.277.484l1.233.34c-.126.267-.245.54-.35.82l-1.292.012a.393.393 0 00-.389.394v.502c0 .217.177.393.393.393l1.305-.02c-.076.277-.137.558-.186.842l-1.277.36a.393.393 0 00-.272.486l.139.49a.393.393 0 00.483.27l1.268-.348c-.009.147-.015.294-.015.442 0 .09.003.18.006.27l-1.15.538a.393.393 0 00-.182.527l.213.452a.393.393 0 00.527.183l1.11-.52c.135.523.317 1.027.544 1.505l-1.026.793a.393.393 0 00-.065.551l.315.41a.393.393 0 00.55.076l1.045-.808c.183.255.379.5.588.733l-.802.964a.393.393 0 00.053.554l.398.338a.393.393 0 00.547-.051l.786-.951c.282.254.58.49.891.705l-.626 1.13a.393.393 0 00.144.535l.442.264a.393.393 0 00.54-.134l.632-1.124c.231.114.468.217.711.31l-.37 1.216a.393.393 0 00.266.49l.494.155a.393.393 0 00.492-.261l.38-1.223c.305.075.617.133.935.173l-.106 1.277a.393.393 0 00.354.418l.508.053a.393.393 0 00.428-.353l.108-1.284c.312-.002.622-.022.93-.057l.157 1.272a.393.393 0 00.433.34l.506-.06a.393.393 0 00.346-.433l-.161-1.298a10.46 10.46 0 00.896-.312l.467 1.192a.393.393 0 00.508.222l.467-.19a.393.393 0 00.217-.51l-.465-1.186c.261-.168.514-.348.757-.54l.734.971a.393.393 0 00.55.082l.412-.313a.393.393 0 00.084-.548l-.718-.955c.218-.216.425-.442.618-.68l.97.775a.393.393 0 00.553-.056l.347-.39a.393.393 0 00-.039-.555l-.96-.77a11.29 11.29 0 00.46-.766l1.086.537a.393.393 0 00.527-.175l.227-.446a.393.393 0 00-.166-.53l-1.104-.546c.115-.276.217-.557.305-.843l1.228.235a.393.393 0 00.464-.307l.094-.502a.393.393 0 00-.31-.458l-1.244-.24c.056-.286.098-.575.126-.867l1.273-.066a.393.393 0 00.377-.408l-.018-.51a.393.393 0 00-.408-.378l-1.279.065a12.015 12.015 0 00-.078-.874l1.224-.387a.393.393 0 00.262-.494l-.154-.494a.393.393 0 00-.488-.262l-1.208.383a11.08 11.08 0 00-.327-.73l1.109-.638a.393.393 0 00.157-.534l-.287-.468a.393.393 0 00-.536-.153zM12 17.4a5.4 5.4 0 110-10.8 5.4 5.4 0 010 10.8zm0-9.3a3.9 3.9 0 100 7.8 3.9 3.9 0 000-7.8zm-1.95 2.1h1.5v1.65h1.05v-1.65h.45c.6 0 1.05-.3 1.05-.9v-.15c0-.6-.45-1.05-1.05-1.05H10.05v4.95h1.5v-1.65h.45l.9 1.65h1.65l-1.05-1.95c.45-.15.75-.6.75-1.05v-.15c0-.75-.6-1.35-1.35-1.35h-2.85v5.55z" fill="currentColor" />
    </svg>
  );
}

function HtmlIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="shrink-0">
      <path d="M1.5 0h21l-1.91 21.563L11.977 24l-8.565-2.438L1.5 0z" fill="#E44D26" />
      <path d="M12 2.25v19.512l6.93-1.922L20.58 2.25H12z" fill="#F16529" />
      <path d="M5.95 9.045l.225 2.52H12v-2.52H5.95zM5.49 6.165H12V3.645H3l.225 2.52zM12 17.157l-.032.009-2.93-.792-.187-2.1H6.303l.369 4.125 5.296 1.47.032-.009v-2.703z" fill="#EBEBEB" />
      <path d="M11.985 9.045v2.52h5.82l-.549 6.108-5.271 1.422v2.703l5.3-1.47.039-.435L18.127 9.045h-.698zM11.985 6.165v-2.52H21l-.186 2.52h-8.829z" fill="#FFF" />
    </svg>
  );
}

/** 根据扩展名返回彩色文件图标 */
export function getFileIcon(ext: string | null, size = 14): React.ReactNode {
  if (!ext) return <File size={size} className="shrink-0 text-slate-400" />;
  switch (ext.toLowerCase()) {
    // TypeScript / TSX
    case "ts":
    case "tsx":
      return <TypeScriptIcon size={size} />;
    // JavaScript / JSX
    case "js":
    case "jsx":
      return <JsIcon size={size} />;
    // Python
    case "py":
      return <PythonIcon size={size} />;
    // Vue
    case "vue":
      return <VueIcon size={size} />;
    // CSS / SCSS / LESS
    case "css":
    case "scss":
    case "less":
      return <CssIcon size={size} />;
    // Markdown
    case "md":
    case "mdx":
      return <MarkdownIcon size={size} />;
    // JSON
    case "json":
    case "jsonc":
      return <FileJson size={size} className="shrink-0 text-yellow-500" />;
    // YAML / TOML / Config
    case "yaml":
    case "yml":
    case "toml":
    case "ini":
    case "cfg":
      return <FileJson size={size} className="shrink-0 text-amber-400" />;
    // Java
    case "java":
      return <FileCode size={size} className="shrink-0 text-orange-500" />;
    // Rust
    case "rs":
      return <RustIcon size={size} />;
    // Go
    case "go":
      return <GoIcon size={size} />;
    // HTML
    case "html":
    case "htm":
      return <HtmlIcon size={size} />;
    // XML / SVG
    case "xml":
    case "svg":
      return <FileCode size={size} className="shrink-0 text-orange-500" />;
    // Shell / Terminal
    case "sh":
    case "bash":
    case "zsh":
    case "ps1":
    case "bat":
      return <Terminal size={size} className="shrink-0 text-emerald-500" />;
    // Images
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "ico":
    case "webp":
    case "bmp":
      return <Image size={size} className="shrink-0 text-violet-500" />;
    // Archives
    case "zip":
    case "rar":
    case "tar":
    case "gz":
    case "7z":
      return <Archive size={size} className="shrink-0 text-amber-600" />;
    // Text / Log
    case "txt":
    case "log":
    case "csv":
      return <FileText size={size} className="shrink-0 text-slate-400" />;
    // C / C++
    case "c":
    case "cpp":
    case "h":
    case "hpp":
      return <FileCode size={size} className="shrink-0 text-blue-500" />;
    // SQL
    case "sql":
      return <Database size={size} className="shrink-0 text-blue-400" />;
    // Other languages
    case "rb":
    case "php":
    case "swift":
    case "kt":
    case "dart":
    case "lua":
    case "graphql":
      return <FileCode size={size} className="shrink-0 text-blue-400" />;
    default:
      return <File size={size} className="shrink-0 text-slate-400" />;
  }
}

/** Git 状态颜色映射 */
const GIT_STATUS_COLORS: Record<string, string> = {
  modified: "text-yellow-400",
  added: "text-green-400",
  deleted: "text-red-400 line-through",
  untracked: "text-emerald-400",
  renamed: "text-blue-400",
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
      e.preventDefault();
      onContextMenu(e, node);
    },
    [node, onContextMenu]
  );

  const paddingLeft = depth * 14 + 12;
  const isSelected = !node.entry.isDir && node.entry.path === selectedFilePath;
  const gitStatus = gitStatuses?.[node.entry.path];
  const gitColorClass = gitStatus ? GIT_STATUS_COLORS[gitStatus] : undefined;

  return (
    <>
      <div
        className={`flex items-center gap-2 py-1.5 px-2 cursor-pointer select-none rounded-md transition-colors group ${
          isSelected
            ? "bg-[var(--editor-selection-bg)] text-[var(--app-text-primary)]"
            : "hover:bg-[var(--app-hover)] text-[var(--app-text-secondary)] hover:text-[var(--app-text-primary)]"
        }`}
        style={{ paddingLeft }}
        data-file-path={node.entry.path}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
      >
        {/* 展开箭头 / 占位 */}
        {node.entry.isDir ? (
          node.loading ? (
            <Loader2 size={14} className="shrink-0 animate-spin" style={{ color: "var(--app-text-tertiary)" }} />
          ) : node.expanded ? (
            <ChevronDown size={14} className="shrink-0" style={{ color: "var(--app-text-tertiary)" }} />
          ) : (
            <ChevronRight size={14} className="shrink-0" style={{ color: "var(--app-text-tertiary)" }} />
          )
        ) : (
          <span className="w-4 shrink-0" />
        )}

        {/* 图标 */}
        {node.entry.isDir ? (
          node.expanded ? (
            <FolderOpen size={14} className="shrink-0 text-blue-500" />
          ) : (
            <Folder size={14} className="shrink-0 text-blue-500" />
          )
        ) : (
          getFileIcon(node.entry.extension)
        )}

        {/* 文件名 */}
        <span className={`truncate text-sm leading-tight flex-1 ${gitColorClass || ""}`}>{node.entry.name}</span>
      </div>

      {/* 递归子节点 */}
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
