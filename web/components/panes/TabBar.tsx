import { useState, useRef, useCallback, useEffect, memo } from "react";
import { X, Plus, PanelRight, PanelBottom, Pin, Pencil, FolderTree, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useTerminalStatusStore } from "@/stores";
import StatusIndicator from "@/components/StatusIndicator";
import type { Tab, TerminalStatusType } from "@/types";
import type { TFunction } from "i18next";

/** Notch 风格密度配置 */
const DENSITY = {
  normal: {
    barPadding: 'px-2 pt-1',
    tabHeight: 'h-[34px]', tabPadding: 'px-3',
    tabRadius: 'rounded-t-[8px]', tabMaxW: 'max-w-[200px]',
    inactiveRadius: 'rounded-t-[6px]', inactiveMargin: 'mx-0.5',
    fontSize: 'text-[13px]', titleMaxW: 'max-w-[120px]',
    closeBtnSize: 'w-[22px] h-[22px]', closeIconSize: 13,
    separatorH: 'h-5',
    statusSize: 6, pinSize: 12, addBtn: 'p-2', addIcon: 'w-4 h-4',
  },
  compact: {
    barPadding: 'px-1.5 pt-0.5',
    tabHeight: 'h-[28px]', tabPadding: 'px-2.5',
    tabRadius: 'rounded-t-[6px]', tabMaxW: 'max-w-[200px]',
    inactiveRadius: 'rounded-t-[5px]', inactiveMargin: 'mx-0.5',
    fontSize: 'text-[12px]', titleMaxW: 'max-w-[100px]',
    closeBtnSize: 'w-[18px] h-[18px]', closeIconSize: 11,
    separatorH: 'h-4',
    statusSize: 5, pinSize: 10, addBtn: 'p-1.5', addIcon: 'w-3.5 h-3.5',
  },
  dense: {
    barPadding: 'px-1 pt-0.5',
    tabHeight: 'h-[24px]', tabPadding: 'px-2',
    tabRadius: 'rounded-t-[6px]', tabMaxW: 'max-w-[160px]',
    inactiveRadius: 'rounded-t-[5px]', inactiveMargin: 'mx-0.5',
    fontSize: 'text-[11px]', titleMaxW: 'max-w-[80px]',
    closeBtnSize: 'w-[16px] h-[16px]', closeIconSize: 10,
    separatorH: 'h-3',
    statusSize: 4, pinSize: 10, addBtn: 'p-1', addIcon: 'w-3 h-3',
  },
} as const;

type Density = keyof typeof DENSITY;

interface TabBarProps {
  paneId: string;
  tabs: Tab[];
  activeId: string;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onTogglePin: (tabId: string) => void;
  onAdd: () => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  onFullscreen: (tabId: string) => void;
  onRename: (tabId: string, newTitle: string) => void;
  onSplitAndMoveRight: (tabId: string) => void;
  onSplitAndMoveDown: (tabId: string) => void;
  onSplitTerminalRight: (tabId: string) => void;
  onSplitTerminalDown: (tabId: string) => void;
  onCloseTerminalPane: (tabId: string) => void;
  onCloseTabsToLeft: (tabId: string) => void;
  onCloseTabsToRight: (tabId: string) => void;
  onCloseOtherTabs: (tabId: string) => void;
  onRevealInExplorer?: (tab: Tab) => void;
  onPopOutTab?: (tabId: string) => void;
  activeTabBg?: string;
  activeTabFg?: string;
}

/** 单个可拖拽标签 */
function SortableTab({
  tab,
  index,
  paneId,
  activeId,
  tabs,
  density,
  editingTabId,
  editingTitle,
  setEditingTitle,
  editInputRef,
  confirmRename,
  cancelRename,
  startRename,
  onSelect,
  onClose,
  onTogglePin,
  onFullscreen,
  onSplitRight,
  onSplitDown,
  onSplitAndMoveRight,
  onSplitAndMoveDown,
  onSplitTerminalRight,
  onSplitTerminalDown,
  onCloseTerminalPane,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onRevealInExplorer,
  onPopOutTab,
  activeTabBg,
  activeTabFg,
  getStatus,
  t,
}: {
  tab: Tab;
  index: number;
  paneId: string;
  activeId: string;
  tabs: Tab[];
  density: Density;
  editingTabId: string | null;
  editingTitle: string;
  setEditingTitle: (v: string) => void;
  editInputRef: React.RefObject<HTMLInputElement | null>;
  confirmRename: () => void;
  cancelRename: () => void;
  startRename: (tab: Tab) => void;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onTogglePin: (tabId: string) => void;
  onFullscreen: (tabId: string) => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  onSplitAndMoveRight: (tabId: string) => void;
  onSplitAndMoveDown: (tabId: string) => void;
  onSplitTerminalRight: (tabId: string) => void;
  onSplitTerminalDown: (tabId: string) => void;
  onCloseTerminalPane: (tabId: string) => void;
  onCloseTabsToLeft: (tabId: string) => void;
  onCloseTabsToRight: (tabId: string) => void;
  onCloseOtherTabs: (tabId: string) => void;
  onRevealInExplorer?: (tab: Tab) => void;
  onPopOutTab?: (tabId: string) => void;
  activeTabBg?: string;
  activeTabFg?: string;
  getStatus: (sessionId: string | null) => TerminalStatusType | null;
  t: TFunction<"panes">;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: tab.id,
    data: { type: "tab", paneId, tab },
    disabled: editingTabId === tab.id,
  });

  const d = DENSITY[density];
  const active = tab.id === activeId;
  const terminalLeafCount =
    tab.contentType === "terminal" && tab.terminalRootPane
      ? countTerminalLeaves(tab.terminalRootPane)
      : 0;

  const showSeparator = index > 0
    && tab.id !== activeId
    && tabs[index - 1].id !== activeId;

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          style={style}
          {...attributes}
          {...listeners}
          className="relative flex items-center h-full group"
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
              ${active
                ? `${d.tabRadius} z-20`
                : `${d.inactiveRadius} ${d.inactiveMargin} hover:bg-[var(--notch-tab-hover-bg)] hover:text-[var(--notch-tab-hover-fg)]`
              }`}
            style={active ? {
              background: activeTabBg ?? 'var(--notch-tab-active-bg)',
              color: activeTabFg ?? 'var(--notch-tab-active-fg)',
              borderLeft: '1px solid var(--notch-tab-border)',
              borderRight: '1px solid var(--notch-tab-border)',
              borderTop: '1px solid var(--notch-tab-border)',
            } : {
              color: 'var(--notch-tab-inactive-fg)',
            }}
            onClick={() => onSelect(tab.id)}
            onDoubleClick={() => onFullscreen(tab.id)}
          >
            <StatusIndicator status={getStatus(tab.sessionId ?? null)} size={d.statusSize} />
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
                onPointerDown={(e) => e.stopPropagation()}
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
        {tab.contentType === "terminal" && tab.sessionId && onPopOutTab && (
          <ContextMenuItem onClick={() => onPopOutTab(tab.id)}>
            <ExternalLink /> {t("popOutWindow")}
          </ContextMenuItem>
        )}
        {tab.contentType === "editor" && tab.filePath && onRevealInExplorer && (
          <ContextMenuItem onClick={() => onRevealInExplorer(tab)}>
            <FolderTree /> {t("revealInExplorer")}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onSplitRight}>
          <PanelRight /> {t("splitPanelRight")}
        </ContextMenuItem>
        <ContextMenuItem onClick={onSplitDown}>
          <PanelBottom /> {t("splitPanelDown")}
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
        {tab.contentType === "terminal" && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onSplitTerminalRight(tab.id)}>
              <PanelRight /> {t("splitRight")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onSplitTerminalDown(tab.id)}>
              <PanelBottom /> {t("splitDown")}
            </ContextMenuItem>
            <ContextMenuItem
              disabled={terminalLeafCount <= 1}
              onSelect={() => onCloseTerminalPane(tab.id)}
            >
              {t("closeTerminalPane")}
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
}

export default memo(function TabBar({
  paneId,
  tabs,
  activeId,
  onSelect,
  onClose,
  onTogglePin,
  onAdd,
  onSplitRight,
  onSplitDown,
  onFullscreen,
  onRename,
  onSplitAndMoveRight,
  onSplitAndMoveDown,
  onSplitTerminalRight,
  onSplitTerminalDown,
  onCloseTerminalPane,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onRevealInExplorer,
  onPopOutTab,
  activeTabBg,
  activeTabFg,
}: TabBarProps) {
  const { t } = useTranslation("panes");
  const getStatus = useTerminalStatusStore((s) => s.getStatus);

  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

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
      className={`flex items-start ${d.barPadding} overflow-x-auto no-scrollbar transition-colors`}
      style={{ background: "transparent" }}
    >
      <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
        <div className="flex items-start flex-1">
          {tabs.map((tab, index) => (
            <SortableTab
              key={tab.id}
              tab={tab}
              index={index}
              paneId={paneId}
              activeId={activeId}
              tabs={tabs}
              density={density}
              editingTabId={editingTabId}
              editingTitle={editingTitle}
              setEditingTitle={setEditingTitle}
              editInputRef={editInputRef}
              confirmRename={confirmRename}
              cancelRename={cancelRename}
              startRename={startRename}
              onSelect={onSelect}
              onClose={onClose}
              onTogglePin={onTogglePin}
              onFullscreen={onFullscreen}
              onSplitRight={onSplitRight}
              onSplitDown={onSplitDown}
              onSplitAndMoveRight={onSplitAndMoveRight}
              onSplitAndMoveDown={onSplitAndMoveDown}
              onSplitTerminalRight={onSplitTerminalRight}
              onSplitTerminalDown={onSplitTerminalDown}
              onCloseTerminalPane={onCloseTerminalPane}
              onCloseTabsToLeft={onCloseTabsToLeft}
              onCloseTabsToRight={onCloseTabsToRight}
              onCloseOtherTabs={onCloseOtherTabs}
              onRevealInExplorer={onRevealInExplorer}
              onPopOutTab={onPopOutTab}
              activeTabBg={activeTabBg}
              activeTabFg={activeTabFg}
              getStatus={getStatus}
              t={t}
            />
          ))}
          <button
            className={`${d.addBtn} rounded-lg transition-colors text-[var(--app-icon-inactive)] hover:bg-[var(--app-hover)] hover:text-[var(--app-icon-active)]`}
            onClick={onAdd}
          >
            <Plus className={d.addIcon} />
          </button>
        </div>
      </SortableContext>
    </div>
  );
});

function countTerminalLeaves(node: Tab["terminalRootPane"]): number {
  if (!node) return 0;
  if (node.type === "leaf") return 1;
  return node.children.reduce((total, child) => total + countTerminalLeaves(child), 0);
}
