import { useState, useRef, useCallback, useEffect, useMemo, memo } from "react";
import { X, Plus, PanelRight, PanelBottom, Pin, Pencil, FolderTree, ExternalLink, ChevronLeft, ChevronRight, Settings2 } from "lucide-react";
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
import { computeTabNumbers } from "@/lib/tabNumbering";
import type { Tab, TerminalStatusType } from "@/types";
import type { TFunction } from "i18next";

/** Notch 风格密度配置 */
const DENSITY = {
  normal: {
    barPadding: 'px-2 pt-1',
    tabHeight: 'h-[34px]', tabPadding: 'px-3',
    tabRadius: 'rounded-t-[8px]', tabMaxW: 'max-w-[180px]', tabMinW: 'min-w-[112px]',
    inactiveRadius: 'rounded-t-[6px]', inactiveMargin: 'mx-0.5',
    fontSize: 'text-[13px]', titleMaxW: 'max-w-[108px]',
    closeBtnSize: 'w-[22px] h-[22px]', closeIconSize: 13,
    separatorH: 'h-5',
    statusSize: 6, pinSize: 12, addBtn: 'p-2', addIcon: 'w-4 h-4',
  },
  compact: {
    barPadding: 'px-1.5 pt-0.5',
    tabHeight: 'h-[28px]', tabPadding: 'px-2.5',
    tabRadius: 'rounded-t-[6px]', tabMaxW: 'max-w-[156px]', tabMinW: 'min-w-[94px]',
    inactiveRadius: 'rounded-t-[5px]', inactiveMargin: 'mx-0.5',
    fontSize: 'text-[12px]', titleMaxW: 'max-w-[76px]',
    closeBtnSize: 'w-[18px] h-[18px]', closeIconSize: 11,
    separatorH: 'h-4',
    statusSize: 5, pinSize: 10, addBtn: 'p-1.5', addIcon: 'w-3.5 h-3.5',
  },
  dense: {
    barPadding: 'px-1 pt-0.5',
    tabHeight: 'h-[24px]', tabPadding: 'px-2',
    tabRadius: 'rounded-t-[6px]', tabMaxW: 'max-w-[132px]', tabMinW: 'min-w-[74px]',
    inactiveRadius: 'rounded-t-[5px]', inactiveMargin: 'mx-0.5',
    fontSize: 'text-[11px]', titleMaxW: 'max-w-[54px]',
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
  tabNumbers?: Map<string, string>;
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
  onEditWorkspaceEnvironment?: (tab: Tab) => void;
  canEditWorkspaceEnvironment?: (tab: Tab) => boolean;
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
  onEditWorkspaceEnvironment,
  canEditWorkspaceEnvironment,
  activeTabFg,
  getStatus,
  registerTabNode,
  displayNumber,
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
  onEditWorkspaceEnvironment?: (tab: Tab) => void;
  canEditWorkspaceEnvironment?: (tab: Tab) => boolean;
  activeTabBg?: string;
  activeTabFg?: string;
  getStatus: (sessionId: string | null) => TerminalStatusType | null;
  registerTabNode: (tabId: string, node: HTMLDivElement | null) => void;
  displayNumber?: string;
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
          ref={(node) => {
            setNodeRef(node);
            registerTabNode(tab.id, node);
          }}
          style={style}
          {...attributes}
          {...listeners}
          data-tab-id={tab.id}
          className="relative flex shrink-0 items-center h-full group"
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
            className={`relative flex shrink-0 items-center gap-1.5 ${d.tabHeight} ${d.tabPadding} ${d.tabMaxW} ${d.tabMinW}
              cursor-pointer select-none transition-colors ${d.fontSize} font-medium
              ${active
                ? `${d.tabRadius} z-20`
                : `${d.inactiveRadius} ${d.inactiveMargin} hover:bg-[var(--notch-tab-hover-bg)] hover:text-[var(--notch-tab-hover-fg)]`
              }`}
            style={active ? {
              background: 'transparent',
              color: activeTabFg ?? 'var(--app-text-primary)',
              borderTop: '2px solid var(--app-accent)',
              fontWeight: 600,
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
                onPointerDown={(e) => {
                  if (e.detail > 1) {
                    e.stopPropagation();
                  }
                }}
                onDoubleClickCapture={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  startRename(tab);
                }}
              >
                {displayNumber ? (
                  <span
                    className="opacity-60 mr-1"
                    aria-hidden="true"
                  >{`#${displayNumber}`}</span>
                ) : null}
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
        {onEditWorkspaceEnvironment && canEditWorkspaceEnvironment?.(tab) ? (
          <ContextMenuItem onClick={() => onEditWorkspaceEnvironment(tab)}>
            <Settings2 /> {t("editWorkspaceEnvironment")}
          </ContextMenuItem>
        ) : null}
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
  tabNumbers: providedTabNumbers,
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
  onEditWorkspaceEnvironment,
  canEditWorkspaceEnvironment,
  activeTabBg,
  activeTabFg,
}: TabBarProps) {
  const { t } = useTranslation("panes");
  const getStatus = useTerminalStatusStore((s) => s.getStatus);

  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const tabNodeRefs = useRef(new Map<string, HTMLDivElement>());
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  // 标签重命名
  const startRename = useCallback((tab: Tab) => {
    setEditingTabId(tab.id);
    setEditingTitle(tab.title);
  }, []);

  // Radix ContextMenu 关闭时焦点恢复在 rAF 之后，用 setTimeout 延迟聚焦避免抢占
  useEffect(() => {
    if (editingTabId) {
      const initialTitle = editingTitle;
      const timer = setTimeout(() => {
        const input = editInputRef.current;
        if (!input) return;
        input.focus();
        if (input.value === initialTitle) {
          input.select();
        }
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

  const localTabNumbers = useMemo(() => computeTabNumbers(tabs), [tabs]);
  const tabNumbers = providedTabNumbers ?? localTabNumbers;

  const registerTabNode = useCallback((tabId: string, node: HTMLDivElement | null) => {
    if (node) {
      tabNodeRefs.current.set(tabId, node);
      return;
    }
    tabNodeRefs.current.delete(tabId);
  }, []);

  const updateScrollAffordance = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) {
      setCanScrollLeft(false);
      setCanScrollRight(false);
      return;
    }

    const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(el.scrollLeft < maxScrollLeft - 1);
  }, []);

  const scrollTabs = useCallback((direction: -1 | 1) => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollBy({
      left: direction * Math.max(180, Math.floor(el.clientWidth * 0.75)),
      behavior: "smooth",
    });
    window.requestAnimationFrame(updateScrollAffordance);
  }, [updateScrollAffordance]);

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
    if (maxScrollLeft <= 0) return;

    const delta = Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (delta === 0) return;

    event.preventDefault();
    el.scrollLeft = Math.max(0, Math.min(maxScrollLeft, el.scrollLeft + delta));
    updateScrollAffordance();
  }, [updateScrollAffordance]);

  useEffect(() => {
    const activeTabNode = tabNodeRefs.current.get(activeId);
    if (!activeTabNode || !scrollContainerRef.current) return;
    if (typeof activeTabNode.scrollIntoView !== "function") return;
    activeTabNode.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "nearest",
    });
    window.requestAnimationFrame(updateScrollAffordance);
  }, [activeId, tabs.length, updateScrollAffordance]);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    updateScrollAffordance();
    el.addEventListener("scroll", updateScrollAffordance, { passive: true });
    window.addEventListener("resize", updateScrollAffordance);

    const resizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(updateScrollAffordance)
      : null;
    resizeObserver?.observe(el);

    return () => {
      el.removeEventListener("scroll", updateScrollAffordance);
      window.removeEventListener("resize", updateScrollAffordance);
      resizeObserver?.disconnect();
    };
  }, [tabs.length, updateScrollAffordance]);

  return (
    <div className="flex min-w-0 items-stretch">
      {canScrollLeft && (
        <button
          type="button"
          aria-label={t("scrollTabsLeft", { defaultValue: "Scroll tabs left" })}
          className="flex w-6 shrink-0 items-center justify-center border-r transition-colors hover:bg-[var(--app-hover)]"
          style={{ borderColor: "var(--app-border)", color: "var(--app-icon-inactive)" }}
          onClick={() => scrollTabs(-1)}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
      )}
      <div
        ref={scrollContainerRef}
        data-testid="pane-tabbar-scroll"
        className={`${d.barPadding} cc-tabbar-scroll min-w-0 flex-1 overflow-x-auto overflow-y-hidden transition-colors`}
        style={{ background: "transparent" }}
        onWheel={handleWheel}
      >
        <SortableContext items={tabs.map((tab) => tab.id)} strategy={horizontalListSortingStrategy}>
          <div data-testid="pane-tabbar-items" className="inline-flex min-w-max items-start">
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
                onEditWorkspaceEnvironment={onEditWorkspaceEnvironment}
                canEditWorkspaceEnvironment={canEditWorkspaceEnvironment}
                activeTabBg={activeTabBg}
                activeTabFg={activeTabFg}
                getStatus={getStatus}
                registerTabNode={registerTabNode}
                displayNumber={tabNumbers.get(tab.id)}
                t={t}
              />
            ))}
            <button
              type="button"
              aria-label="New tab"
              className={`${d.addBtn} shrink-0 rounded-lg transition-colors text-[var(--app-icon-inactive)] hover:bg-[var(--app-hover)] hover:text-[var(--app-icon-active)]`}
              onClick={onAdd}
            >
              <Plus className={d.addIcon} />
            </button>
          </div>
        </SortableContext>
      </div>
      {canScrollRight && (
        <button
          type="button"
          aria-label={t("scrollTabsRight", { defaultValue: "Scroll tabs right" })}
          className="flex w-6 shrink-0 items-center justify-center border-l transition-colors hover:bg-[var(--app-hover)]"
          style={{ borderColor: "var(--app-border)", color: "var(--app-icon-inactive)" }}
          onClick={() => scrollTabs(1)}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
});

function countTerminalLeaves(node: Tab["terminalRootPane"]): number {
  if (!node) return 0;
  if (node.type === "leaf") return 1;
  return node.children.reduce((total, child) => total + countTerminalLeaves(child), 0);
}
