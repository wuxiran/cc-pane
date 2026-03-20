import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Search, Clock, FileText } from "lucide-react";
import { useEditorTabsStore } from "@/stores/useEditorTabsStore";
import { useActivityBarStore } from "@/stores";
import { getFileIcon } from "@/components/filetree/FileTreeNode";

interface RecentFilesPickerProps {
  open: boolean;
  onClose: () => void;
}

export default function RecentFilesPicker({ open, onClose }: RecentFilesPickerProps) {
  const { t } = useTranslation("sidebar");

  const tabs = useEditorTabsStore((s) => s.tabs);
  const recentFiles = useEditorTabsStore((s) => s.recentFiles);

  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 构建分组列表：Open tabs + Recent (不在 tabs 中的)
  const { items, openCount } = useMemo(() => {
    const openFilePaths = new Set(tabs.map((t) => t.filePath));

    const openItems = tabs.map((t) => ({
      filePath: t.filePath,
      projectPath: t.projectPath,
      title: t.title,
      isOpen: true,
    }));

    const recentItems = recentFiles
      .filter((r) => !openFilePaths.has(r.filePath))
      .map((r) => ({
        filePath: r.filePath,
        projectPath: r.projectPath,
        title: r.title,
        isOpen: false,
      }));

    const all = [...openItems, ...recentItems];

    if (!query.trim()) {
      return { items: all, openCount: openItems.length };
    }

    const q = query.trim().toLowerCase();
    const filtered = all.filter((item) => {
      const fileName = item.title.toLowerCase();
      const path = item.filePath.toLowerCase();
      return fileName.includes(q) || path.includes(q);
    });

    // 过滤后重新计算 open 数量
    const filteredOpenCount = filtered.filter((i) => i.isOpen).length;
    return { items: filtered, openCount: filteredOpenCount };
  }, [tabs, recentFiles, query]);

  // 打开时聚焦输入框并重置状态
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const handleOpen = useCallback(
    (item: { filePath: string; projectPath: string; title: string }) => {
      useEditorTabsStore.getState().openFile(item.projectPath, item.filePath, item.title);
      const appViewMode = useActivityBarStore.getState().appViewMode;
      if (appViewMode !== "files") {
        useActivityBarStore.getState().toggleFilesMode();
      }
      onClose();
    },
    [onClose]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => {
          const next = Math.min(prev + 1, items.length - 1);
          const el = listRef.current?.children[next + (next >= openCount ? 2 : openCount > 0 ? 1 : 0)] as HTMLElement | undefined;
          el?.scrollIntoView({ block: "nearest" });
          return next;
        });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => {
          const next = Math.max(prev - 1, 0);
          const el = listRef.current?.children[next + (next >= openCount ? 2 : openCount > 0 ? 1 : 0)] as HTMLElement | undefined;
          el?.scrollIntoView({ block: "nearest" });
          return next;
        });
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (items[selectedIndex]) {
          handleOpen(items[selectedIndex]);
        }
      }
    },
    [items, selectedIndex, openCount, onClose, handleOpen]
  );

  if (!open) return null;

  const getExt = (name: string) => name.split(".").pop() || null;
  const getRelPath = (filePath: string, projectPath: string) => {
    const normalized = filePath.replace(/\\/g, "/");
    const normalizedRoot = projectPath.replace(/\\/g, "/");
    return normalized.startsWith(normalizedRoot)
      ? normalized.slice(normalizedRoot.length).replace(/^\//, "")
      : filePath;
  };

  let itemIndex = 0;

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/20"
        onClick={onClose}
      />
      <div
        className="quicksearch-enter fixed z-50 top-[40px] left-1/2 -translate-x-1/2 w-[520px] max-w-[90vw] max-h-[400px] flex flex-col rounded-md shadow-2xl border overflow-hidden"
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
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder={t("recentFiles.placeholder")}
            className="flex-1 bg-transparent text-[13px] outline-none placeholder:opacity-50"
            style={{ color: "var(--app-text-primary)" }}
          />
        </div>

        {/* 结果列表 */}
        <div ref={listRef} className="flex-1 overflow-y-auto max-h-[340px]">
          {items.length === 0 ? (
            <div className="text-[13px] text-center py-8 text-muted-foreground">
              {query.trim() ? t("recentFiles.noMatch") : t("recentFiles.noRecent")}
            </div>
          ) : (
            <>
              {/* Open 分组 */}
              {openCount > 0 && (
                <div
                  className="text-[11px] font-medium px-3 py-1.5 uppercase tracking-wider"
                  style={{ color: "var(--app-text-tertiary)" }}
                >
                  <FileText size={12} className="inline mr-1 -mt-0.5" />
                  {t("recentFiles.open")}
                </div>
              )}
              {items.slice(0, openCount).map((item) => {
                const idx = itemIndex++;
                return (
                  <div
                    key={item.filePath}
                    className="flex items-center gap-2 px-3 py-1 cursor-pointer transition-colors"
                    style={{
                      background: idx === selectedIndex ? "var(--editor-selection-bg)" : undefined,
                      color: "var(--app-text-primary)",
                    }}
                    onClick={() => handleOpen(item)}
                    onMouseEnter={() => setSelectedIndex(idx)}
                  >
                    {getFileIcon(getExt(item.title), 16)}
                    <div className="min-w-0 flex-1">
                      <span className="text-[13px] truncate block">{item.title}</span>
                      <span
                        className="text-[11px] truncate block"
                        style={{ color: "var(--app-text-tertiary)" }}
                      >
                        {getRelPath(item.filePath, item.projectPath)}
                      </span>
                    </div>
                  </div>
                );
              })}

              {/* Recent 分组 */}
              {items.length > openCount && (
                <div
                  className="text-[11px] font-medium px-3 py-1.5 uppercase tracking-wider"
                  style={{ color: "var(--app-text-tertiary)" }}
                >
                  <Clock size={12} className="inline mr-1 -mt-0.5" />
                  {t("recentFiles.recent")}
                </div>
              )}
              {items.slice(openCount).map((item) => {
                const idx = itemIndex++;
                return (
                  <div
                    key={item.filePath}
                    className="flex items-center gap-2 px-3 py-1 cursor-pointer transition-colors"
                    style={{
                      background: idx === selectedIndex ? "var(--editor-selection-bg)" : undefined,
                      color: "var(--app-text-primary)",
                    }}
                    onClick={() => handleOpen(item)}
                    onMouseEnter={() => setSelectedIndex(idx)}
                  >
                    {getFileIcon(getExt(item.title), 16)}
                    <div className="min-w-0 flex-1">
                      <span className="text-[13px] truncate block">{item.title}</span>
                      <span
                        className="text-[11px] truncate block"
                        style={{ color: "var(--app-text-tertiary)" }}
                      >
                        {getRelPath(item.filePath, item.projectPath)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
    </>
  );
}
