import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Folder,
  FolderInput,
  FolderOpen,
  Loader2,
  Pencil,
  ShieldCheck,
  Terminal,
  Trash2,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { getFileIcon } from "@/components/filetree/FileTreeNode";
import type {
  SshFileSortDirection,
  SshFileSortKey,
  SshFileViewMode,
} from "@/stores";
import type { FsEntry } from "@/types/filesystem";

interface SshRemoteFileBrowserProps {
  entries: FsEntry[];
  currentPath: string;
  viewMode: SshFileViewMode;
  sortKey: SshFileSortKey;
  sortDirection: SshFileSortDirection;
  search: string;
  onSort: (key: SshFileSortKey) => void;
  onOpen: (entry: FsEntry) => void;
  onRename: (entry: FsEntry) => void;
  onDelete: (entry: FsEntry) => void;
  onDownload: (entry: FsEntry) => void;
  onPermissions: (entry: FsEntry) => void;
  onOpenTerminal: (entry: FsEntry) => void;
  onChangeDirectory: (entry: FsEntry) => void;
  onLoadDirectory: (path: string) => Promise<FsEntry[]>;
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatModified(value: string | null, language: string): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const locale = language.startsWith("zh") ? "zh-CN" : "en-US";
  return new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function sortEntries(
  entries: FsEntry[],
  search: string,
  key: SshFileSortKey,
  direction: SshFileSortDirection,
): FsEntry[] {
  const query = search.trim().toLocaleLowerCase();
  const filtered = query
    ? entries.filter((entry) => entry.name.toLocaleLowerCase().includes(query))
    : entries;
  const multiplier = direction === "asc" ? 1 : -1;
  return [...filtered].sort((left, right) => {
    if (left.isDir !== right.isDir) return left.isDir ? -1 : 1;
    let comparison = 0;
    if (key === "size") comparison = left.size - right.size;
    else if (key === "modified") {
      comparison = (left.modified ?? "").localeCompare(right.modified ?? "");
    } else comparison = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    return comparison * multiplier;
  });
}

export default function SshRemoteFileBrowser(props: SshRemoteFileBrowserProps) {
  const sortedEntries = useMemo(
    () => sortEntries(
      props.entries,
      props.search,
      props.sortKey,
      props.sortDirection,
    ),
    [props.entries, props.search, props.sortDirection, props.sortKey],
  );

  if (props.viewMode === "tree") {
    return <RemoteTree {...props} entries={sortedEntries} />;
  }
  return <RemoteTable {...props} entries={sortedEntries} />;
}

function RemoteTable({
  entries,
  sortKey,
  sortDirection,
  onSort,
  ...actions
}: SshRemoteFileBrowserProps) {
  const { t, i18n } = useTranslation("sidebar");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div role="table" className="min-w-[490px] text-[11px]">
        <div
          role="row"
          className="sticky top-0 z-10 grid h-7 grid-cols-[minmax(170px,1fr)_72px_96px_132px] items-center border-b bg-[var(--app-sidebar-bg)] text-[10px] text-[var(--app-text-muted)]"
          style={{ borderColor: "var(--app-border)" }}
        >
          <SortHeader label={t("sshFiles.name")} column="name" {...{ sortKey, sortDirection, onSort }} />
          <SortHeader label={t("sshFiles.size")} column="size" {...{ sortKey, sortDirection, onSort }} />
          <div role="columnheader" className="px-2">{t("sshFiles.permissions")}</div>
          <SortHeader label={t("sshFiles.modified")} column="modified" {...{ sortKey, sortDirection, onSort }} />
        </div>
        {entries.map((entry) => (
          <EntryContextMenu key={entry.path} entry={entry} {...actions}>
            <div
              role="row"
              tabIndex={0}
              aria-selected={selectedPath === entry.path}
              className="grid h-8 cursor-default grid-cols-[minmax(170px,1fr)_72px_96px_132px] items-center border-b border-transparent outline-none hover:bg-[var(--app-hover)] focus:bg-[var(--app-hover)] aria-selected:bg-[var(--app-hover)]"
              onClick={() => {
                setSelectedPath(entry.path);
                if (!entry.isDir) actions.onOpen(entry);
              }}
              onDoubleClick={() => !entry.isDir && actions.onOpen(entry)}
              onKeyDown={(event) => event.key === "Enter" && actions.onOpen(entry)}
            >
              <div role="cell" className="flex min-w-0 items-center gap-2 px-2">
                <EntryIcon entry={entry} />
                <span className="truncate text-[var(--app-text-primary)]">{entry.name}</span>
              </div>
              <div role="cell" className="truncate px-2 text-[var(--app-text-muted)]">
                {entry.isDir ? "-" : formatSize(entry.size)}
              </div>
              <div role="cell" className="truncate px-2 font-mono text-[var(--app-text-muted)]">
                {entry.permissions ?? "---------"}
              </div>
              <div role="cell" className="truncate px-2 text-[var(--app-text-muted)]">
                {formatModified(entry.modified, language)}
              </div>
            </div>
          </EntryContextMenu>
        ))}
      </div>
    </div>
  );
}

function SortHeader({
  label,
  column,
  sortKey,
  sortDirection,
  onSort,
}: {
  label: string;
  column: SshFileSortKey;
  sortKey: SshFileSortKey;
  sortDirection: SshFileSortDirection;
  onSort: (key: SshFileSortKey) => void;
}) {
  return (
    <button
      type="button"
      role="columnheader"
      className="flex h-full items-center gap-1 px-2 text-left hover:text-[var(--app-text-primary)]"
      onClick={() => onSort(column)}
    >
      <span>{label}</span>
      {sortKey === column && <span aria-hidden>{sortDirection === "asc" ? "↑" : "↓"}</span>}
    </button>
  );
}

function RemoteTree(props: SshRemoteFileBrowserProps) {
  const [expandedPaths, setExpandedPaths] = useState<string[]>([]);
  const [children, setChildren] = useState<Record<string, FsEntry[]>>({});
  const [loadingPaths, setLoadingPaths] = useState<string[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const toggleDirectory = useCallback(async (entry: FsEntry) => {
    if (!entry.isDir) return;
    if (expandedPaths.includes(entry.path)) {
      setExpandedPaths((paths) => paths.filter((path) => path !== entry.path));
      return;
    }
    setExpandedPaths((paths) => [...paths, entry.path]);
    if (children[entry.path]) return;
    setLoadingPaths((paths) => [...paths, entry.path]);
    try {
      const loaded = await props.onLoadDirectory(entry.path);
      setChildren((current) => ({ ...current, [entry.path]: loaded }));
    } catch {
      setExpandedPaths((paths) => paths.filter((path) => path !== entry.path));
    } finally {
      setLoadingPaths((paths) => paths.filter((path) => path !== entry.path));
    }
  }, [children, expandedPaths, props]);

  return (
    <div role="tree" className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1">
      <div
        role="treeitem"
        aria-expanded="true"
        className="flex h-7 select-none items-center gap-1.5 rounded-md px-2 text-[var(--app-text-primary)]"
        style={{ paddingLeft: 12 }}
      >
        <ChevronDown size={16} className="shrink-0 text-[var(--app-text-tertiary)]" />
        <FolderOpen size={16} className="shrink-0 text-[var(--app-accent)]" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-5">
          {remoteRootLabel(props.currentPath)}
        </span>
      </div>
      {props.entries.map((entry) => (
        <TreeEntry
          key={entry.path}
          entry={entry}
          depth={1}
          expandedPaths={expandedPaths}
          loadingPaths={loadingPaths}
          childrenByPath={children}
          selectedPath={selectedPath}
          onSelect={setSelectedPath}
          onToggle={toggleDirectory}
          actions={props}
        />
      ))}
    </div>
  );
}

function TreeEntry({
  entry,
  depth,
  expandedPaths,
  loadingPaths,
  childrenByPath,
  selectedPath,
  onSelect,
  onToggle,
  actions,
}: {
  entry: FsEntry;
  depth: number;
  expandedPaths: string[];
  loadingPaths: string[];
  childrenByPath: Record<string, FsEntry[]>;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onToggle: (entry: FsEntry) => void;
  actions: SshRemoteFileBrowserProps;
}) {
  const expanded = expandedPaths.includes(entry.path);
  const children = sortEntries(
    childrenByPath[entry.path] ?? [],
    actions.search,
    actions.sortKey,
    actions.sortDirection,
  );
  const loading = loadingPaths.includes(entry.path);
  const selected = !entry.isDir && selectedPath === entry.path;

  const handleClick = () => {
    onSelect(entry.path);
    if (entry.isDir) void onToggle(entry);
    else actions.onOpen(entry);
  };

  return (
    <>
      <EntryContextMenu entry={entry} {...actions}>
        <div
          role="treeitem"
          aria-expanded={entry.isDir ? expanded : undefined}
          tabIndex={0}
          aria-selected={selected}
          className={`group flex h-7 cursor-pointer select-none items-center gap-1.5 rounded-md px-2 text-[var(--app-text-primary)] outline-none transition-colors ${
            selected ? "bg-[var(--editor-selection-bg)]" : "hover:bg-[var(--app-hover)]"
          }`}
          style={{ paddingLeft: `${depth * 14 + 12}px` }}
          data-file-path={entry.path}
          data-current={selected ? "true" : undefined}
          onClick={handleClick}
          onKeyDown={(event) => event.key === "Enter" && handleClick()}
        >
          {entry.isDir ? (
            loading ? (
              <Loader2 size={16} className="shrink-0 animate-spin text-[var(--app-text-tertiary)]" />
            ) : expanded ? (
              <ChevronDown size={16} className="shrink-0 text-[var(--app-text-tertiary)]" />
            ) : (
              <ChevronRight size={16} className="shrink-0 text-[var(--app-text-tertiary)]" />
            )
          ) : (
            <span className="w-4 shrink-0" />
          )}
          <EntryIcon entry={entry} open={expanded} />
          <span
            className={`min-w-0 flex-1 truncate text-[13px] leading-5 text-[var(--app-text-primary)] ${
              entry.isDir ? "font-semibold" : ""
            }`}
          >
            {entry.name}
          </span>
        </div>
      </EntryContextMenu>
      {expanded && children.map((child) => (
        <TreeEntry
          key={child.path}
          entry={child}
          depth={depth + 1}
          expandedPaths={expandedPaths}
          loadingPaths={loadingPaths}
          childrenByPath={childrenByPath}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onToggle={onToggle}
          actions={actions}
        />
      ))}
    </>
  );
}

function EntryIcon({ entry, open = false }: { entry: FsEntry; open?: boolean }) {
  if (entry.isDir) {
    const Icon = open ? FolderOpen : Folder;
    return <Icon className="h-4 w-4 shrink-0 text-[var(--app-accent)]" />;
  }
  return getFileIcon(entry.extension);
}

function remoteRootLabel(path: string): string {
  if (path === "~") return "~";
  const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "/";
}

function EntryContextMenu({
  entry,
  children,
  onOpen,
  onRename,
  onDelete,
  onDownload,
  onPermissions,
  onOpenTerminal,
  onChangeDirectory,
}: Pick<
  SshRemoteFileBrowserProps,
  "onOpen" | "onRename" | "onDelete" | "onDownload" | "onPermissions" | "onOpenTerminal" | "onChangeDirectory"
> & {
  entry: FsEntry;
  children: React.ReactNode;
}) {
  const { t } = useTranslation("sidebar");
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        <ContextMenuItem onClick={() => onOpen(entry)}>
          <FolderOpen className="mr-2 h-3.5 w-3.5" />
          {t(entry.isDir ? "sshFiles.openFolder" : "sshFiles.openFile")}
        </ContextMenuItem>
        {entry.isDir && (
          <>
            <ContextMenuItem onClick={() => onChangeDirectory(entry)}>
              <FolderInput className="mr-2 h-3.5 w-3.5" />
              {t("sshFiles.cdToDirectory")}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onOpenTerminal(entry)}>
              <Terminal className="mr-2 h-3.5 w-3.5" />
              {t("sshFiles.openTerminalHere")}
            </ContextMenuItem>
          </>
        )}
        {!entry.isDir && (
          <ContextMenuItem onClick={() => onDownload(entry)}>
            <Download className="mr-2 h-3.5 w-3.5" />
            {t("sshFiles.download")}
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={() => onRename(entry)}>
          <Pencil className="mr-2 h-3.5 w-3.5" />
          {t("sshFiles.rename")}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onPermissions(entry)}>
          <ShieldCheck className="mr-2 h-3.5 w-3.5" />
          {t("sshFiles.changePermissions")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => void navigator.clipboard.writeText(entry.name)}>
          <Copy className="mr-2 h-3.5 w-3.5" />
          {t("sshFiles.copyName")}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void navigator.clipboard.writeText(entry.path)}>
          <Copy className="mr-2 h-3.5 w-3.5" />
          {t("sshFiles.copyPath")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() => onDelete(entry)}
          className="text-[var(--app-status-danger)] focus:text-[var(--app-status-danger)]"
        >
          <Trash2 className="mr-2 h-3.5 w-3.5" />
          {t("sshFiles.delete")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
