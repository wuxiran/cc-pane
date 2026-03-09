import { useState, useCallback, useRef, useEffect } from "react";
import { Search, Folder, Loader2 } from "lucide-react";
import { handleErrorSilent } from "@/utils";
import { useWorkspacesStore, useActivityBarStore } from "@/stores";
import { useFileBrowserStore } from "@/stores/useFileBrowserStore";
import { useEditorTabsStore } from "@/stores/useEditorTabsStore";
import { filesystemService } from "@/services/filesystemService";
import { getFileIcon } from "@/components/filetree/FileTreeNode";
import type { SearchResult } from "@/types/filesystem";

interface GroupedResult extends SearchResult {
  projectName: string;
  projectPath: string;
}

interface QuickSearchProps {
  open: boolean;
  onClose: () => void;
}

export default function QuickSearch({ open, onClose }: QuickSearchProps) {
  const workspaces = useWorkspacesStore((s) => s.workspaces);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GroupedResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  // 打开时聚焦输入框并重置状态
  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [open]);

  // 搜索逻辑
  const handleSearch = useCallback(
    (q: string) => {
      setQuery(q);
      setSelectedIndex(0);

      if (debounceRef.current) clearTimeout(debounceRef.current);

      if (q.trim().length < 2) {
        setResults([]);
        setSearching(false);
        return;
      }

      debounceRef.current = setTimeout(async () => {
        const thisRequestId = ++requestIdRef.current;
        setSearching(true);
        try {
          const searches: Array<{
            promise: Promise<SearchResult[]>;
            projectName: string;
            projectPath: string;
          }> = [];
          for (const ws of workspaces) {
            for (const project of ws.projects) {
              const projectName =
                project.alias ||
                project.path.split(/[/\\]/).pop() ||
                project.path;
              searches.push({
                promise: filesystemService.searchFiles(project.path, q.trim(), 10),
                projectName,
                projectPath: project.path,
              });
            }
          }

          const settled = await Promise.allSettled(searches.map((s) => s.promise));

          if (thisRequestId !== requestIdRef.current) return;

          const allResults: GroupedResult[] = [];
          for (let i = 0; i < settled.length; i++) {
            const result = settled[i];
            if (result.status === "fulfilled") {
              for (const r of result.value) {
                allResults.push({
                  ...r,
                  projectName: searches[i].projectName,
                  projectPath: searches[i].projectPath,
                });
              }
            }
          }

          allResults.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
          setResults(allResults.slice(0, 30));
        } catch (e) {
          handleErrorSilent(e, "QuickSearch");
        } finally {
          if (thisRequestId === requestIdRef.current) {
            setSearching(false);
          }
        }
      }, 150);
    },
    [workspaces]
  );

  // 打开选中的结果
  const handleOpen = useCallback(
    (result: GroupedResult) => {
      if (result.isDir) {
        useFileBrowserStore.getState().navigateTo(result.path);
        useActivityBarStore.getState().toggleFilesMode();
      } else {
        // 打开文件：切换到 Files mode + 打开编辑器标签
        const fileName = result.name;
        useEditorTabsStore.getState().openFile(result.projectPath, result.path, fileName);
        const appViewMode = useActivityBarStore.getState().appViewMode;
        if (appViewMode !== "files") {
          useActivityBarStore.getState().toggleFilesMode();
        }
      }
      onClose();
    },
    [onClose]
  );

  // 键盘导航
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => {
          const next = Math.min(prev + 1, results.length - 1);
          // 滚动到可见区域
          const el = listRef.current?.children[next] as HTMLElement | undefined;
          el?.scrollIntoView({ block: "nearest" });
          return next;
        });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => {
          const next = Math.max(prev - 1, 0);
          const el = listRef.current?.children[next] as HTMLElement | undefined;
          el?.scrollIntoView({ block: "nearest" });
          return next;
        });
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (results[selectedIndex]) {
          handleOpen(results[selectedIndex]);
        }
      }
    },
    [results, selectedIndex, onClose, handleOpen]
  );

  if (!open) return null;

  return (
    <>
      {/* 背景遮罩 */}
      <div
        className="fixed inset-0 z-50 bg-black/20"
        onClick={onClose}
      />
      {/* 搜索弹窗 */}
      <div
        className="quicksearch-enter fixed z-50 top-[40px] left-1/2 -translate-x-1/2 w-[560px] max-w-[90vw] max-h-[400px] flex flex-col rounded-md shadow-2xl border overflow-hidden"
        style={{
          background: "var(--editor-bg)",
          borderColor: "var(--app-border)",
        }}
      >
        {/* 输入框 */}
        <div
          className="flex items-center gap-2 px-3 py-2.5 border-b"
          style={{ borderColor: "var(--app-border)" }}
        >
          <Search size={16} style={{ color: "var(--app-text-tertiary)" }} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => handleSearch(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search files by name..."
            className="flex-1 bg-transparent text-[13px] outline-none placeholder:opacity-50"
            style={{ color: "var(--app-text-primary)" }}
          />
          {searching && <Loader2 size={14} className="animate-spin text-muted-foreground" />}
        </div>

        {/* 结果列表 */}
        <div ref={listRef} className="flex-1 overflow-y-auto max-h-[340px]">
          {results.length > 0 ? (
            results.map((r, idx) => {
              const ext = r.name.split(".").pop() || null;
              return (
                <div
                  key={`${r.path}-${idx}`}
                  className="flex items-center gap-2 px-3 py-1 cursor-pointer transition-colors"
                  style={{
                    background: idx === selectedIndex ? "var(--editor-selection-bg)" : undefined,
                    color: "var(--app-text-primary)",
                  }}
                  onClick={() => handleOpen(r)}
                  onMouseEnter={() => setSelectedIndex(idx)}
                >
                  {r.isDir ? (
                    <Folder size={16} className="shrink-0 text-amber-400" />
                  ) : (
                    getFileIcon(ext, 16)
                  )}
                  <div className="min-w-0 flex-1">
                    <span className="text-[13px] truncate block">{r.name}</span>
                    <span
                      className="text-[11px] truncate block"
                      style={{ color: "var(--app-text-tertiary)" }}
                    >
                      {r.relPath}
                      <span className="ml-1 opacity-60">· {r.projectName}</span>
                    </span>
                  </div>
                  {r.score != null && (
                    <span
                      className="text-[10px] shrink-0 px-1.5 py-0.5 rounded"
                      style={{ background: "var(--app-hover)", color: "var(--app-text-tertiary)" }}
                    >
                      {r.score}
                    </span>
                  )}
                </div>
              );
            })
          ) : query.length >= 2 && !searching ? (
            <div className="text-[13px] text-center py-8 text-muted-foreground">
              No results found
            </div>
          ) : query.length < 2 ? (
            <div className="text-[13px] text-center py-8 text-muted-foreground">
              Type to search across all projects
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
