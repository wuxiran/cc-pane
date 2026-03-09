import { useState, useCallback, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Search, File, Folder, Loader2 } from "lucide-react";
import { handleErrorSilent } from "@/utils";
import { useWorkspacesStore, useActivityBarStore } from "@/stores";
import { useFileBrowserStore } from "@/stores/useFileBrowserStore";
import { filesystemService } from "@/services/filesystemService";
import type { SearchResult } from "@/types/filesystem";

interface GroupedResult extends SearchResult {
  projectName: string;
}

export default function SearchView() {
  const { t } = useTranslation("common");
  const workspaces = useWorkspacesStore((s) => s.workspaces);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GroupedResult[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);

  // 卸载时清理 debounce timer
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleSearch = useCallback(
    (q: string) => {
      setQuery(q);

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
          // 并行搜索所有项目
          const searches: Array<{
            promise: Promise<SearchResult[]>;
            projectName: string;
          }> = [];
          for (const ws of workspaces) {
            for (const project of ws.projects) {
              const projectName =
                project.alias ||
                project.path.split(/[/\\]/).pop() ||
                project.path;
              searches.push({
                promise: filesystemService.searchFiles(
                  project.path,
                  q.trim(),
                  10
                ),
                projectName,
              });
            }
          }

          const settled = await Promise.allSettled(
            searches.map((s) => s.promise)
          );

          // 丢弃过期请求的结果
          if (thisRequestId !== requestIdRef.current) return;

          const allResults: GroupedResult[] = [];
          for (let i = 0; i < settled.length; i++) {
            const result = settled[i];
            if (result.status === "fulfilled") {
              for (const r of result.value) {
                allResults.push({
                  ...r,
                  projectName: searches[i].projectName,
                });
              }
            }
          }

          // 按 score 降序排序
          allResults.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
          setResults(allResults.slice(0, 50));
        } catch (e) {
          handleErrorSilent(e, "search files");
        } finally {
          if (thisRequestId === requestIdRef.current) {
            setSearching(false);
          }
        }
      }, 150);
    },
    [workspaces]
  );

  const handleResultClick = useCallback((result: GroupedResult) => {
    if (result.isDir) {
      // 目录 → 在文件浏览器中打开
      useFileBrowserStore.getState().navigateTo(result.path);
      useActivityBarStore.getState().toggleFilesMode();
    } else {
      // 文件 → 在文件浏览器中打开其所在目录
      const dir = result.path.replace(/\\/g, "/");
      const lastSlash = dir.lastIndexOf("/");
      const parentDir = lastSlash > 0 ? dir.slice(0, lastSlash) : dir;
      useFileBrowserStore.getState().navigateTo(parentDir);
      useActivityBarStore.getState().toggleFilesMode();
    }
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* 视图标题栏 */}
      <div className="flex items-center justify-between px-4 py-2 shrink-0">
        <span
          className="text-[11px] font-bold tracking-wider"
          style={{ color: "var(--app-text-secondary)" }}
        >
          SEARCH
        </span>
      </div>

      {/* 搜索输入框 */}
      <div className="px-3 pb-2 shrink-0">
        <div
          className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg"
          style={{
            background: "var(--app-input-bg)",
            border: "1px solid var(--app-border)",
          }}
        >
          <Search
            className="w-3.5 h-3.5 shrink-0"
            style={{ color: "var(--app-text-tertiary)" }}
          />
          <input
            type="text"
            value={query}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder={t("search")}
            className="flex-1 bg-transparent text-[12px] outline-none placeholder:text-[var(--app-text-tertiary)]"
            style={{ color: "var(--app-text-primary)" }}
          />
          {searching && (
            <Loader2
              className="w-3 h-3 animate-spin"
              style={{ color: "var(--app-text-tertiary)" }}
            />
          )}
        </div>
      </div>

      {/* 搜索结果 */}
      <div className="flex-1 overflow-y-auto px-3">
        {results.length > 0 ? (
          <div className="space-y-0.5">
            {results.map((r, idx) => (
              <div
                key={`${r.path}-${idx}`}
                className="flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors cursor-pointer hover:bg-[var(--app-hover)] text-[var(--app-text-secondary)]"
                onClick={() => handleResultClick(r)}
              >
                {r.isDir ? (
                  <Folder
                    className="w-3.5 h-3.5 shrink-0"
                    style={{ color: "var(--app-accent)" }}
                  />
                ) : (
                  <File
                    className="w-3.5 h-3.5 shrink-0"
                    style={{ color: "var(--app-text-tertiary)" }}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <span className="text-[12px] truncate block">{r.name}</span>
                  <span
                    className="text-[10px] truncate block text-[var(--app-text-tertiary)]"
                  >
                    {r.relPath}
                    <span className="ml-1 opacity-60">· {r.projectName}</span>
                  </span>
                </div>
                {r.score != null && (
                  <span
                    className="text-[9px] shrink-0 px-1 rounded"
                    style={{
                      color: "var(--app-text-tertiary)",
                      background: "var(--app-hover)",
                    }}
                  >
                    {r.score}
                  </span>
                )}
              </div>
            ))}
          </div>
        ) : query.length >= 2 && !searching ? (
          <p
            className="text-xs text-center mt-8 text-[var(--app-text-tertiary)]"
          >
            No results found
          </p>
        ) : (
          <p
            className="text-xs text-center mt-8 text-[var(--app-text-tertiary)]"
          >
            Search across all projects
          </p>
        )}
      </div>
    </div>
  );
}
