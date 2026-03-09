import { useState, useRef, useCallback, useEffect, memo } from "react";
import { X, Plus, PanelRight, PanelBottom, Pin, Pencil, FolderTree } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useTerminalStatusStore } from "@/stores";
import StatusIndicator from "@/components/StatusIndicator";
import type { Tab } from "@/types";

interface TabBarProps {
  tabs: Tab[];
  activeId: string;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onTogglePin: (tabId: string) => void;
  onAdd: () => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  onFullscreen: (tabId: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onRename: (tabId: string, newTitle: string) => void;
  onSplitAndMoveRight: (tabId: string) => void;
  onSplitAndMoveDown: (tabId: string) => void;
  onCloseTabsToLeft: (tabId: string) => void;
  onCloseTabsToRight: (tabId: string) => void;
  onCloseOtherTabs: (tabId: string) => void;
  onRevealInExplorer?: (tab: Tab) => void;
}

export default memo(function TabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onTogglePin,
  onAdd,
  onSplitRight,
  onSplitDown,
  onFullscreen,
  onReorder,
  onRename,
  onSplitAndMoveRight,
  onSplitAndMoveDown,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onRevealInExplorer,
}: TabBarProps) {
  const { t } = useTranslation("panes");
  const getStatus = useTerminalStatusStore((s) => s.getStatus);

  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  // 标签拖拽排序
  function handleDragStart(e: React.DragEvent, index: number) {
    setDragIndex(index);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(index));
    }
  }

  function handleDragOver(e: React.DragEvent, index: number) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    setDropIndex(index);
  }

  function handleDrop(e: React.DragEvent, index: number) {
    e.preventDefault();
    if (dragIndex !== null && dragIndex !== index) {
      onReorder(dragIndex, index);
    }
    setDragIndex(null);
    setDropIndex(null);
  }

  function handleDragEnd() {
    setDragIndex(null);
    setDropIndex(null);
  }

  // 标签重命名
  const startRename = useCallback((tab: Tab) => {
    setEditingTabId(tab.id);
    setEditingTitle(tab.title);
  }, []);

  // Radix ContextMenu 关闭时焦点恢复在 rAF 之后，用 setTimeout 延迟聚焦避免抢占
  useEffect(() => {
    if (editingTabId) {
      const timer = setTimeout(() => {
        editInputRef.current?.focus();
        editInputRef.current?.select();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [editingTabId]);

  function confirmRename() {
    if (editingTabId && editingTitle.trim()) {
      onRename(editingTabId, editingTitle.trim());
    }
    setEditingTabId(null);
    setEditingTitle("");
  }

  function cancelRename() {
    setEditingTabId(null);
    setEditingTitle("");
  }

  // 根据标签数量自动选择紧凑级别
  type Density = 'normal' | 'compact' | 'dense';
  const density: Density = tabs.length <= 3 ? 'normal' : tabs.length <= 6 ? 'compact' : 'dense';

  const DENSITY = {
    normal:  { bar: 'h-11 px-4', tabList: 'gap-2 pt-1.5', tab: 'gap-2.5 px-4 h-9 rounded-t-lg text-sm', title: 'max-w-[120px]', statusSize: 6, pinSize: 12, closeBtn: 'w-3 h-3', addBtn: 'p-2', addIcon: 'w-4 h-4' },
    compact: { bar: 'h-9 px-3',  tabList: 'gap-1 pt-1',   tab: 'gap-1.5 px-2.5 h-7 rounded-t-md text-xs', title: 'max-w-[100px]', statusSize: 5, pinSize: 10, closeBtn: 'w-2.5 h-2.5', addBtn: 'p-1.5', addIcon: 'w-3.5 h-3.5' },
    dense:   { bar: 'h-8 px-2',  tabList: 'gap-0.5 pt-0.5', tab: 'gap-1 px-2 h-6 rounded-t text-[11px]',   title: 'max-w-[80px]',  statusSize: 4, pinSize: 10, closeBtn: 'w-2.5 h-2.5', addBtn: 'p-1', addIcon: 'w-3 h-3' },
  } as const;

  const d = DENSITY[density];

  return (
    <div
      className={`flex items-center ${d.bar} shrink-0 border-b transition-colors`}
      style={{ background: "var(--app-tabbar)", borderColor: "var(--app-border)" }}
    >
      <div
        className={`flex items-center ${d.tabList} overflow-x-auto flex-1 h-full`}
      >
        {tabs.map((tab, index) => (
          <ContextMenu key={tab.id}>
            <ContextMenuTrigger asChild>
              <div
                className={`relative group flex items-center ${d.tab} font-medium transition-all cursor-pointer
                  ${dragIndex === index ? "opacity-50" : ""}
                  ${dropIndex === index && dragIndex !== index ? "border-[var(--app-accent)] bg-[var(--app-active-bg)]" : ""}
                  ${tab.id !== activeId ? "hover:bg-[var(--app-hover)]" : ""}
                `}
                style={{
                  background: tab.id === activeId ? "var(--editor-tab-active-bg)" : "transparent",
                  color: tab.id === activeId ? "var(--editor-tab-active-fg)" : "var(--editor-tab-inactive-fg)",
                  borderTop: tab.id === activeId ? "2px solid var(--app-tab-active-border)" : "2px solid transparent",
                }}
                draggable
                onClick={() => onSelect(tab.id)}
                onDoubleClick={() => onFullscreen(tab.id)}
                onDragStart={(e) => handleDragStart(e, index)}
                onDragOver={(e) => handleDragOver(e, index)}
                onDragLeave={() => setDropIndex(null)}
                onDrop={(e) => handleDrop(e, index)}
                onDragEnd={handleDragEnd}
              >
                <StatusIndicator status={getStatus(tab.sessionId)} size={d.statusSize} />
                {tab.pinned && (
                  <Pin size={d.pinSize} className="shrink-0 opacity-60 rotate-45" style={{ color: "var(--app-accent)" }} onDoubleClick={(e) => e.stopPropagation()} />
                )}
                {editingTabId === tab.id ? (
                  <input
                    ref={editInputRef}
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    className={`${d.title} text-xs font-medium rounded px-1 py-0.5 outline-none`}
                    style={{
                      background: "var(--app-content)",
                      border: "1px solid var(--app-accent)",
                      color: "var(--app-text-primary)",
                    }}
                    onBlur={confirmRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") confirmRename();
                      else if (e.key === "Escape") cancelRename();
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span
                    className={`${d.title} truncate`}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      startRename(tab);
                    }}
                  >
                    {tab.title}
                  </span>
                )}
                {!tab.pinned && (
                  <button
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded-full transition-all hover:bg-[var(--app-hover)]"
                    onClick={(e) => {
                      e.stopPropagation();
                      onClose(tab.id);
                    }}
                  >
                    <X className={d.closeBtn} />
                  </button>
                )}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-48">
              <ContextMenuItem onClick={() => startRename(tab)}>
                <Pencil /> {t("renameTab")}
              </ContextMenuItem>
              <ContextMenuItem inset onClick={() => onTogglePin(tab.id)}>
                {tab.pinned ? t("unpinTab") : t("pinTab")}
              </ContextMenuItem>
              {tab.contentType === "editor" && tab.filePath && onRevealInExplorer && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => onRevealInExplorer(tab)}>
                    <FolderTree /> {t("revealInExplorer")}
                  </ContextMenuItem>
                </>
              )}
              <ContextMenuSeparator />
              <ContextMenuItem onClick={onSplitRight}>
                <PanelRight /> {t("splitRight")}
              </ContextMenuItem>
              <ContextMenuItem onClick={onSplitDown}>
                <PanelBottom /> {t("splitDown")}
              </ContextMenuItem>
              {tabs.length > 1 && (
                <>
                  <ContextMenuItem onClick={() => onSplitAndMoveRight(tab.id)}>
                    <PanelRight /> {t("splitAndMoveRight")}
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => onSplitAndMoveDown(tab.id)}>
                    <PanelBottom /> {t("splitAndMoveDown")}
                  </ContextMenuItem>
                </>
              )}
              {tabs.length > 1 && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    inset
                    disabled={tabs.slice(0, index).filter((t) => !t.pinned).length === 0}
                    onClick={() => onCloseTabsToLeft(tab.id)}
                  >
                    {t("closeTabsToLeft")}
                  </ContextMenuItem>
                  <ContextMenuItem
                    inset
                    disabled={tabs.slice(index + 1).filter((t) => !t.pinned).length === 0}
                    onClick={() => onCloseTabsToRight(tab.id)}
                  >
                    {t("closeTabsToRight")}
                  </ContextMenuItem>
                  <ContextMenuItem
                    inset
                    disabled={tabs.filter((_, i) => i !== index && !tabs[i].pinned).length === 0}
                    onClick={() => onCloseOtherTabs(tab.id)}
                  >
                    {t("closeOtherTabs")}
                  </ContextMenuItem>
                </>
              )}
              {!tab.pinned && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem variant="destructive" inset onClick={() => onClose(tab.id)}>
                    {t("closeTab")}
                  </ContextMenuItem>
                </>
              )}
            </ContextMenuContent>
          </ContextMenu>
        ))}
        <button
          className={`${d.addBtn} mb-1 rounded-lg transition-colors text-[var(--app-icon-inactive)] hover:bg-[var(--app-hover)] hover:text-[var(--app-icon-active)]`}
          onClick={onAdd}
        >
          <Plus className={d.addIcon} />
        </button>
      </div>
    </div>
  );
});
