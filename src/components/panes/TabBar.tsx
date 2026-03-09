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

/** SVG Skirt — 活跃标签左侧圆弧过渡 */
function TabSkirtLeft({ size }: { size: number }) {
  return (
    <svg
      className="absolute bottom-0"
      style={{ width: size, height: size, left: -size, color: 'var(--editor-tab-active-bg)' }}
      viewBox="0 0 10 10"
      fill="currentColor"
    >
      <path d="M 0 10 A 10 10 0 0 0 10 0 L 10 10 Z" />
    </svg>
  );
}

/** SVG Skirt — 活跃标签右侧圆弧过渡 */
function TabSkirtRight({ size }: { size: number }) {
  return (
    <svg
      className="absolute bottom-0"
      style={{ width: size, height: size, right: -size, color: 'var(--editor-tab-active-bg)' }}
      viewBox="0 0 10 10"
      fill="currentColor"
    >
      <path d="M 10 10 A 10 10 0 0 1 0 0 L 0 10 Z" />
    </svg>
  );
}

/** Chrome 风格密度配置 */
const DENSITY = {
  normal: {
    barHeight: 'h-[42px]', barPadding: 'px-2 pt-2',
    tabHeight: 'h-[34px]', tabPadding: 'px-3',
    tabRadius: 'rounded-t-[10px]', tabMaxW: 'max-w-[200px]',
    inactiveRadius: 'rounded-[8px]', inactiveMargin: 'mx-0.5 mb-[4px]',
    skirtSize: 10, fontSize: 'text-[13px]', titleMaxW: 'max-w-[120px]',
    closeBtnSize: 'w-[22px] h-[22px]', closeIconSize: 13,
    separatorH: 'h-5',
    statusSize: 6, pinSize: 12, addBtn: 'p-2', addIcon: 'w-4 h-4',
  },
  compact: {
    barHeight: 'h-[36px]', barPadding: 'px-1.5 pt-1.5',
    tabHeight: 'h-[28px]', tabPadding: 'px-2.5',
    tabRadius: 'rounded-t-[8px]', tabMaxW: 'max-w-[200px]',
    inactiveRadius: 'rounded-[6px]', inactiveMargin: 'mx-0.5 mb-[3px]',
    skirtSize: 8, fontSize: 'text-[12px]', titleMaxW: 'max-w-[100px]',
    closeBtnSize: 'w-[18px] h-[18px]', closeIconSize: 11,
    separatorH: 'h-4',
    statusSize: 5, pinSize: 10, addBtn: 'p-1.5', addIcon: 'w-3.5 h-3.5',
  },
  dense: {
    barHeight: 'h-[30px]', barPadding: 'px-1 pt-1',
    tabHeight: 'h-[24px]', tabPadding: 'px-2',
    tabRadius: 'rounded-t-[6px]', tabMaxW: 'max-w-[160px]',
    inactiveRadius: 'rounded-[5px]', inactiveMargin: 'mx-0.5 mb-[2px]',
    skirtSize: 6, fontSize: 'text-[11px]', titleMaxW: 'max-w-[80px]',
    closeBtnSize: 'w-[16px] h-[16px]', closeIconSize: 10,
    separatorH: 'h-3',
    statusSize: 4, pinSize: 10, addBtn: 'p-1', addIcon: 'w-3 h-3',
  },
} as const;

type Density = keyof typeof DENSITY;

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
  const density: Density = tabs.length <= 3 ? 'normal' : tabs.length <= 6 ? 'compact' : 'dense';
  const d = DENSITY[density];

  return (
    <div
      className={`flex items-end ${d.barHeight} ${d.barPadding} shrink-0 overflow-x-auto no-scrollbar transition-colors`}
      style={{ background: "var(--app-tabbar)" }}
    >
      <div
        className="flex items-end h-full flex-1"
      >
        {tabs.map((tab, index) => {
          const active = tab.id === activeId;
          const isDragging = dragIndex === index;

          // 竖线分隔符逻辑：非活跃标签之间显示，active 相邻时隐藏
          const showSeparator = index > 0
            && tab.id !== activeId
            && tabs[index - 1].id !== activeId;

          return (
            <ContextMenu key={tab.id}>
              <ContextMenuTrigger asChild>
                <div
                  className="relative flex items-center h-full group"
                  draggable
                  onDragStart={(e) => handleDragStart(e, index)}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDragLeave={() => setDropIndex(null)}
                  onDrop={(e) => handleDrop(e, index)}
                  onDragEnd={handleDragEnd}
                >
                  {/* 竖线分隔符 */}
                  {showSeparator && (
                    <div
                      className={`absolute left-0 top-1/2 -translate-y-1/2 ${d.separatorH} w-px group-hover:opacity-0 transition-opacity`}
                      style={{ background: 'var(--app-border)' }}
                    />
                  )}

                  {/* 标签主体 */}
                  <div
                    className={`relative flex items-center gap-1.5 ${d.tabHeight} ${d.tabPadding} ${d.tabMaxW}
                      cursor-pointer select-none transition-colors ${d.fontSize} font-medium
                      ${isDragging ? 'opacity-50' : ''}
                      ${dropIndex === index && dragIndex !== index ? 'bg-[var(--app-active-bg)]' : ''}
                      ${active
                        ? `${d.tabRadius} z-20`
                        : `${d.inactiveRadius} ${d.inactiveMargin} hover:bg-[var(--app-hover)]`
                      }`}
                    style={{
                      background: active ? 'var(--editor-tab-active-bg)' : undefined,
                      color: active ? 'var(--editor-tab-active-fg)' : 'var(--editor-tab-inactive-fg)',
                    }}
                    onClick={() => onSelect(tab.id)}
                    onDoubleClick={() => onFullscreen(tab.id)}
                  >
                    {/* SVG skirts — 仅活跃标签 */}
                    {active && (
                      <>
                        <TabSkirtLeft size={d.skirtSize} />
                        <TabSkirtRight size={d.skirtSize} />
                      </>
                    )}

                    <StatusIndicator status={getStatus(tab.sessionId)} size={d.statusSize} />
                    {tab.pinned && (
                      <Pin size={d.pinSize} className="shrink-0 opacity-60 rotate-45" style={{ color: "var(--app-accent)" }} onDoubleClick={(e) => e.stopPropagation()} />
                    )}
                    {editingTabId === tab.id ? (
                      <input
                        ref={editInputRef}
                        value={editingTitle}
                        onChange={(e) => setEditingTitle(e.target.value)}
                        className={`${d.titleMaxW} text-xs font-medium rounded px-1 py-0.5 outline-none`}
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
                        className={`${d.titleMaxW} truncate`}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          startRename(tab);
                        }}
                      >
                        {tab.title}
                      </span>
                    )}
                    {!tab.pinned && (
                      <div
                        className={`flex items-center justify-center ${d.closeBtnSize} rounded-full
                          hover:bg-[var(--app-hover)] transition-colors
                          ${active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                        style={{ color: 'var(--editor-tab-inactive-fg)' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          onClose(tab.id);
                        }}
                      >
                        <X size={d.closeIconSize} strokeWidth={2.5} />
                      </div>
                    )}
                  </div>
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
          );
        })}
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
