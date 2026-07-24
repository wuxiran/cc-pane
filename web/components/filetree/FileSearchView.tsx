import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { File, Search, X } from "lucide-react";
import { filesystemService } from "@/services/filesystemService";
import { usePanesStore } from "@/stores";
import type { ProjectContentMatch } from "@/types/filesystem";

type SearchMode = "name" | "content";
type SearchResult =
  | { mode: "name"; paths: string[]; truncated: boolean }
  | { mode: "content"; matches: ProjectContentMatch[]; truncated: boolean };

interface FileSearchViewProps {
  rootPath: string;
  children: ReactNode;
}

function joinProjectPath(rootPath: string, relativePath: string): string {
  const separator = rootPath.includes("\\") && !rootPath.includes("/") ? "\\" : "/";
  const root = rootPath.replace(/[/\\]+$/, "");
  return `${root}${separator}${relativePath.replace(/[/\\]/g, separator)}`;
}

function useFileSearch(rootPath: string, query: string, mode: SearchMode) {
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latestRequest = useRef(0);

  useEffect(() => {
    const requestId = ++latestRequest.current;
    const trimmed = query.trim();
    setResult(null);
    setLoading(false);
    setError(null);
    if (!trimmed) return;

    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const nextResult: SearchResult = mode === "name"
          ? { mode, ...(await filesystemService.searchProjectFiles(rootPath, trimmed, 200)) }
          : { mode, ...(await filesystemService.searchProjectContents(rootPath, trimmed, 300)) };
        if (requestId === latestRequest.current) setResult(nextResult);
      } catch (searchError) {
        if (requestId !== latestRequest.current) return;
        setError(searchError instanceof Error ? searchError.message : String(searchError));
      } finally {
        if (requestId === latestRequest.current) setLoading(false);
      }
    }, 200);

    return () => window.clearTimeout(timer);
  }, [mode, query, rootPath]);

  return { result, loading, error };
}

function SearchInput({ query, onQueryChange }: { query: string; onQueryChange: (value: string) => void }) {
  const { t } = useTranslation("sidebar");
  return (
    <div className="relative min-w-0">
      <Search
        aria-hidden
        className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--app-text-tertiary)]"
      />
      <input
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => event.key === "Escape" && onQueryChange("")}
        placeholder={t("filetree.searchPlaceholder")}
        className="h-7 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-input-bg)] pl-7 pr-7 text-[13px] text-[var(--app-text-primary)] outline-none placeholder:text-[var(--app-text-tertiary)] focus-visible:ring-1 focus-visible:ring-[var(--app-accent)]"
      />
      {query.trim() && (
        <button
          type="button"
          aria-label={t("filetree.clearSearch")}
          onClick={() => onQueryChange("")}
          className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-sm text-[var(--app-text-tertiary)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-accent)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function SearchModeTabs({ mode, onModeChange }: { mode: SearchMode; onModeChange: (mode: SearchMode) => void }) {
  const { t } = useTranslation("sidebar");
  return (
    <div
      role="tablist"
      aria-label={t("filetree.searchMode")}
      className="flex h-7 items-center rounded-md border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-0.5"
    >
      {(["name", "content"] as const).map((item) => {
        const labelKey = item === "name" ? "filetree.searchModeName" : "filetree.searchModeContent";
        const selected = mode === item;
        return (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-label={t(labelKey)}
            onClick={() => onModeChange(item)}
            className={`h-5 rounded px-1.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-accent)] ${
              selected
                ? "bg-[var(--app-hover)] text-[var(--app-text-primary)]"
                : "text-[var(--app-text-tertiary)] hover:text-[var(--app-text-primary)]"
            }`}
          >
            {t(labelKey)}
          </button>
        );
      })}
    </div>
  );
}

function SearchToolbar(props: {
  query: string;
  mode: SearchMode;
  onQueryChange: (value: string) => void;
  onModeChange: (mode: SearchMode) => void;
}) {
  return (
    <div className="sticky top-0 z-10 grid shrink-0 grid-cols-[minmax(0,1fr)_auto] gap-1.5 bg-[var(--app-sidebar-bg)] pb-2">
      <SearchInput query={props.query} onQueryChange={props.onQueryChange} />
      <SearchModeTabs mode={props.mode} onModeChange={props.onModeChange} />
    </div>
  );
}

function NameResults({ paths, onOpen }: { paths: string[]; onOpen: (path: string) => void }) {
  return paths.map((path) => (
    <button
      key={path}
      type="button"
      onClick={() => onOpen(path)}
      className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left text-[13px] text-[var(--app-text-primary)] hover:bg-[var(--app-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-accent)]"
    >
      <File className="h-4 w-4 shrink-0 text-[var(--app-text-tertiary)]" />
      <span className="truncate">{path}</span>
    </button>
  ));
}

function ContentResults({ matches, onOpen }: { matches: ProjectContentMatch[]; onOpen: (path: string) => void }) {
  return matches.map((match) => (
    <button
      key={`${match.path}:${match.line}`}
      type="button"
      onClick={() => onOpen(match.path)}
      className="flex w-full min-w-0 flex-col rounded-md px-2 py-1.5 text-left hover:bg-[var(--app-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-accent)]"
    >
      <span className="w-full truncate text-xs text-[var(--app-text-secondary)]">
        {match.path}:{match.line}
      </span>
      <span className="w-full truncate text-xs text-[var(--app-text-tertiary)]">
        {match.preview}
      </span>
    </button>
  ));
}

function SearchResults(props: {
  result: SearchResult | null;
  loading: boolean;
  error: string | null;
  onOpen: (path: string) => void;
}) {
  const { t } = useTranslation("sidebar");
  if (props.loading) {
    return <div className="px-2 py-3 text-xs text-[var(--app-text-tertiary)]">{t("filetree.searching")}</div>;
  }
  if (props.error) {
    return <div className="px-2 py-3 text-xs text-[var(--app-status-danger)]">{t("filetree.searchFailed", { message: props.error })}</div>;
  }
  if (!props.result) return null;
  const empty = props.result.mode === "name"
    ? props.result.paths.length === 0
    : props.result.matches.length === 0;
  return (
    <>
      {props.result.truncated && (
        <div className="px-2 pb-1 text-xs text-[var(--app-status-warning)]">{t("filetree.searchTruncated")}</div>
      )}
      {empty && <div className="px-2 py-3 text-xs text-[var(--app-text-tertiary)]">{t("filetree.searchNoResults")}</div>}
      {props.result.mode === "name"
        ? <NameResults paths={props.result.paths} onOpen={props.onOpen} />
        : <ContentResults matches={props.result.matches} onOpen={props.onOpen} />}
    </>
  );
}

export default function FileSearchView({ rootPath, children }: FileSearchViewProps) {
  const openEditor = usePanesStore((state) => state.openEditor);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("name");
  const search = useFileSearch(rootPath, query, mode);
  const openResult = (relativePath: string) => {
    const title = relativePath.split(/[/\\]/).pop() || relativePath;
    openEditor(rootPath, joinProjectPath(rootPath, relativePath), title);
  };

  return (
    <div className="flex min-h-0 flex-col">
      <SearchToolbar query={query} mode={mode} onQueryChange={setQuery} onModeChange={setMode} />
      {!query.trim() ? children : (
        <div className="min-h-0 flex-1">
          <SearchResults {...search} onOpen={openResult} />
        </div>
      )}
    </div>
  );
}
