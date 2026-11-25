import { Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SettingsSearchResult } from "./settingsSearch";

interface SettingsSearchBoxProps {
  query: string;
  results: readonly SettingsSearchResult[];
  onQueryChange: (query: string) => void;
  onSelect: (result: SettingsSearchResult) => void;
}

export default function SettingsSearchBox({
  query,
  results,
  onQueryChange,
  onSelect,
}: SettingsSearchBoxProps) {
  const { t } = useTranslation("settings");
  const [focused, setFocused] = useState(false);
  const showResults = focused && query.trim().length > 0;
  const inputRef = useRef<HTMLInputElement>(null);

  // 「/」聚焦搜索：正在输入（input/textarea/可编辑区）时不抢键。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="relative w-full">
      <Search aria-hidden="true" size={14} strokeWidth={1.6} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--app-text-tertiary)]" />
      <input
        ref={inputRef}
        type="search"
        value={query}
        aria-label={t("searchLabel")}
        placeholder={t("searchPlaceholder")}
        onChange={(event) => onQueryChange(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => window.setTimeout(() => setFocused(false), 100)}
        className="h-8 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-content)] pl-8 pr-8 text-[length:var(--text-row)] text-[var(--app-text-primary)] outline-none placeholder:text-[var(--app-text-tertiary)] focus:border-[var(--app-accent)] focus:ring-2 focus:ring-[var(--app-active-bg)] [&::-webkit-search-cancel-button]:hidden"
      />
      {!query && !focused && (
        <kbd
          aria-hidden="true"
          title={t("searchShortcutHint")}
          className="pointer-events-none absolute right-2 top-1/2 flex h-5 min-w-5 -translate-y-1/2 items-center justify-center rounded border border-[var(--app-border)] px-1 font-mono text-[length:var(--text-caption)] leading-none text-[var(--app-text-tertiary)]"
        >
          /
        </kbd>
      )}
      {query && (
        <button
          type="button"
          aria-label={t("clearSearch")}
          onClick={() => onQueryChange("")}
          className="absolute right-1.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded text-[var(--app-text-tertiary)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
        >
          <X aria-hidden="true" size={13} />
        </button>
      )}
      {showResults && (
        <div className="absolute left-0 right-0 top-10 z-50 max-h-80 overflow-y-auto rounded-md border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-1 shadow-lg">
          {results.length === 0 ? (
            <p className="px-3 py-5 text-center text-[length:var(--text-small)] text-[var(--app-text-tertiary)]">{t("searchEmpty")}</p>
          ) : results.slice(0, 12).map((result) => (
            <button
              key={result.id}
              type="button"
              className="flex w-full items-start gap-3 rounded px-3 py-2 text-left hover:bg-[var(--app-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelect(result)}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[length:var(--text-row)] font-medium text-[var(--app-text-primary)]">{result.title}</span>
                {result.description && (
                  <span className="mt-0.5 block line-clamp-2 text-[length:var(--text-caption)] text-[var(--app-text-tertiary)]">{result.description}</span>
                )}
              </span>
              <span className="text-[length:var(--text-caption)] text-[var(--app-text-tertiary)]">{t(`searchLayers.${result.layer}`)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
