import { useState, useCallback, useRef, useEffect } from "react";
import { Search, X } from "lucide-react";
import type { SearchResult } from "@/types/filesystem";

interface FileTreeSearchProps {
  rootPath: string;
  onSearch: (rootPath: string, query: string) => Promise<SearchResult[]>;
  onFileClick: (filePath: string) => void;
}

export default function FileTreeSearch({
  rootPath,
  onSearch,
  onFileClick,
}: FileTreeSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setQuery(value);
      setSelectedIndex(-1);

      if (debounceRef.current) clearTimeout(debounceRef.current);

      if (!value.trim()) {
        setResults([]);
        setShowResults(false);
        setIsSearching(false);
        return;
      }

      debounceRef.current = setTimeout(async () => {
        const thisRequestId = ++requestIdRef.current;
        setIsSearching(true);
        try {
          const res = await onSearch(rootPath, value.trim());
          // 丢弃过期请求的结果
          if (thisRequestId !== requestIdRef.current) return;
          setResults(res);
          setShowResults(true);
        } catch {
          if (thisRequestId !== requestIdRef.current) return;
          setResults([]);
        } finally {
          if (thisRequestId === requestIdRef.current) {
            setIsSearching(false);
          }
        }
      }, 100);
    },
    [rootPath, onSearch]
  );

  const handleClear = useCallback(() => {
    setQuery("");
    setResults([]);
    setShowResults(false);
    setSelectedIndex(-1);
  }, []);

  const handleResultClick = useCallback(
    (result: SearchResult) => {
      if (!result.isDir) {
        onFileClick(result.path);
      }
      setShowResults(false);
    },
    [onFileClick]
  );

  // 键盘导航
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!showResults || results.length === 0) return;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev < results.length - 1 ? prev + 1 : 0
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev > 0 ? prev - 1 : results.length - 1
          );
          break;
        case "Enter":
          e.preventDefault();
          if (selectedIndex >= 0 && selectedIndex < results.length) {
            handleResultClick(results[selectedIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          setShowResults(false);
          setSelectedIndex(-1);
          break;
      }
    },
    [showResults, results, selectedIndex, handleResultClick]
  );

  // 卸载时清理 debounce timer
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // 点击外部关闭结果
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setShowResults(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // 选中项滚入可视区域
  const resultsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selectedIndex >= 0 && resultsRef.current) {
      const selected = resultsRef.current.children[selectedIndex] as HTMLElement;
      selected?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  return (
    <div ref={containerRef} className="relative px-2 py-1.5">
      <div
        className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-[var(--app-input-bg)] border border-transparent focus-within:border-[var(--app-accent)] focus-within:bg-[var(--app-content)] transition-all shadow-sm"
      >
        <Search size={14} className="shrink-0" style={{ color: "var(--app-text-tertiary)" }} />
        <input
          ref={inputRef}
          value={query}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Search files..."
          className="flex-1 min-w-0 bg-transparent text-[13px] outline-none placeholder:text-[var(--app-text-tertiary)]"
          style={{ color: "var(--app-text-primary)" }}
          onFocus={() => results.length > 0 && setShowResults(true)}
        />
        {query && (
          <button
            onClick={handleClear}
            className="shrink-0 p-0.5 rounded hover:bg-[var(--app-hover)]"
          >
            <X size={12} style={{ color: "var(--app-text-tertiary)" }} />
          </button>
        )}
      </div>

      {/* 搜索结果下拉 */}
      {showResults && results.length > 0 && (
        <div
          ref={resultsRef}
          className="absolute z-50 left-1 right-1 mt-1 max-h-48 overflow-y-auto rounded-md border bg-popover shadow-lg"
        >
          {results.map((result, idx) => (
            <div
              key={result.path}
              className={`flex items-center gap-2 px-3 py-2 text-[13px] cursor-pointer truncate ${
                idx === selectedIndex
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent"
              }`}
              onClick={() => handleResultClick(result)}
              onMouseEnter={() => setSelectedIndex(idx)}
            >
              <span className="truncate font-medium">{result.name}</span>
              <span className="truncate text-muted-foreground text-[11px]">
                {result.relPath}
              </span>
            </div>
          ))}
        </div>
      )}

      {showResults && query && results.length === 0 && !isSearching && (
        <div className="absolute z-50 left-1 right-1 mt-1 px-2 py-2 text-xs text-muted-foreground rounded-md border bg-popover shadow-lg">
          No results found
        </div>
      )}
    </div>
  );
}
