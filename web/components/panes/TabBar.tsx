import { useState, useRef, useCallback, useEffect, useMemo, memo } from "react";
import { X, Pin, ChevronLeft, ChevronRight, Link2, Star } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useTerminalStatusStore } from "@/stores";
import { useTabAttentionStore } from "@/stores/useTabAttentionStore";
import InlineRename from "@/components/ui/InlineRename";
import SessionBindDialog from "@/components/panes/SessionBindDialog";
import { computeTabNumbers } from "@/lib/tabNumbering";
import type { Tab, TerminalStatusType } from "@/types";
import type { TFunction } from "i18next";
import { DENSITY, type Density } from "./tabBarDensity";
import NewTabMenu from "./NewTabMenu";
import TabTypeIcon from "./TabTypeIcon";
import TabContextMenu, {
  type LayoutMoveTarget,
  type PaneMoveTarget,
} from "./TabContextMenu";

interface TabBarProps {
  paneId: string;
  tabs: Tab[];
  activeId: string;
  tabNumbers?: Map<string, string>;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onTogglePin: (tabId: string) => void;
  onToggleStar: (tabId: string) => void;
  onAdd: () => void;
  /** 新建浏览器 tab（桌面端此前无入口，只能靠 MCP open_browser_tab） */
  onAddBrowser?: () => void;
  /** 打开文件（走系统文件选择器，落在本 pane 的 editor tab） */
  onAddFile?: () => void;
  /** 打开目录树 tab（file-explorer，桌面端此前无入口） */
  onAddFileExplorer?: () => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  onFullscreen: (tabId: string) => void;
  onRename: (tabId: string, newTitle: string) => void;
  onSplitAndMoveRight: (tabId: string) => void;
  onSplitAndMoveDown: (tabId: string) => void;
  moveTargets: PaneMoveTarget[];
  onMoveTabToPane: (tabId: string, targetPaneId: string) => void;
  layoutMoveTargets: LayoutMoveTarget[];
  onMoveTabToLayoutPane: (tabId: string, targetLayoutId: string, targetPaneId: string) => void;
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
  /** 克隆终端：同目录/同 CLI 配置在本窗格再开一个标签。 */
  onCloneTab?: (tab: Tab) => void;
  /** 全屏切换：当前面板已全屏则退出，否则进入。 */
  onToggleFullscreen?: (tabId: string) => void;
  /** 当前面板是否处于全屏，用于切换菜单文案。 */
  isPaneFullscreen?: boolean;
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
  confirmRename,
  cancelRename,
  startRename,
  onSelect,
  onClose,
  onTogglePin,
  onToggleStar,
  onFullscreen,
  onSplitRight,
  onSplitDown,
  onSplitAndMoveRight,
  onSplitAndMoveDown,
  moveTargets,
  onMoveTabToPane,
  layoutMoveTargets,
  onMoveTabToLayoutPane,
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
  onCloneTab,
  onToggleFullscreen,
  isPaneFullscreen,
  activeTabFg,
  getStatus,
  registerTabNode,
  displayNumber,
  onOpenSessionBind,
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
  confirmRename: () => void;
  cancelRename: () => void;
  startRename: (tab: Tab) => void;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onTogglePin: (tabId: string) => void;
  onToggleStar: (tabId: string) => void;
  onFullscreen: (tabId: string) => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  onSplitAndMoveRight: (tabId: string) => void;
  onSplitAndMoveDown: (tabId: string) => void;
  moveTargets: PaneMoveTarget[];
  onMoveTabToPane: (tabId: string, targetPaneId: string) => void;
  layoutMoveTargets: LayoutMoveTarget[];
  onMoveTabToLayoutPane: (tabId: string, targetLayoutId: string, targetPaneId: string) => void;
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
  onCloneTab?: (tab: Tab) => void;
  onToggleFullscreen?: (tabId: string) => void;
  isPaneFullscreen?: boolean;
  activeTabFg?: string;
  getStatus: (sessionId: string | null) => TerminalStatusType | null;
  registerTabNode: (tabId: string, node: HTMLDivElement | null) => void;
  displayNumber?: string;
  onOpenSessionBind: (tab: Tab) => void;
  t: TFunction<"panes">;
}) {
  // 每 tab 只订阅自己的条目存在性，避免任何标记变化全列表重渲
  const hasAttentionMark = useTabAttentionStore((st) => Boolean(st.entries[tab.id]));
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
  const showSeparator = index > 0
    && tab.id !== activeId
    && tabs[index - 1].id !== activeId;

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
  };
  const isEditing = editingTabId === tab.id;

  const tabNode = (
    <div
      ref={(node) => {
        setNodeRef(node);
        registerTabNode(tab.id, node);
      }}
      style={style}
      {...(isEditing ? {} : attributes)}
      {...(isEditing ? {} : listeners)}
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
          ${isEditing ? "cursor-text" : "cursor-pointer"} select-none transition-colors ${d.fontSize} font-medium
          ${active
            ? `${d.tabRadius} z-20`
            : `${d.inactiveRadius} ${d.inactiveMargin} hover:bg-[var(--notch-tab-hover-bg)] hover:text-[var(--notch-tab-hover-fg)]`
          }`}
        style={active ? {
          background: 'transparent',
          color: activeTabFg ?? 'var(--app-text-primary)',
          fontWeight: 600,
        } : {
          color: 'var(--notch-tab-inactive-fg)',
        }}
        onClick={isEditing ? undefined : () => onSelect(tab.id)}
        onDoubleClick={isEditing ? undefined : () => onFullscreen(tab.id)}
      >
        {/* 激活态:底部 accent 下划线,一眼分明 */}
        {active ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-2.5 bottom-0 h-[2px] rounded-full"
            style={{ background: "var(--app-accent)" }}
          />
        ) : null}
        <TabTypeIcon tab={tab} statusSize={d.statusSize} iconSize={d.pinSize} getStatus={getStatus} />
        {/* 会话绑定标志：绿=已确定 resume id（重启可恢复），灰=未绑定（点击手动绑定） */}
        {tab.contentType === "terminal" && tab.cliTool && tab.cliTool !== "none" && (
          <button
            type="button"
            title={
              tab.resumeId
                ? t("sessionBindBoundTooltip", {
                    id: tab.resumeId.slice(0, 8),
                    source: tab.resumeIdSource ?? "?",
                  })
                : t("sessionBindUnboundTooltip")
            }
            className="shrink-0 flex items-center cursor-pointer"
            onClick={(e) => {
              e.stopPropagation();
              onOpenSessionBind(tab);
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <Link2
              size={d.pinSize}
              style={{
                color: tab.resumeId ? "var(--app-status-success)" : "var(--app-text-tertiary)",
                opacity: tab.resumeId ? 0.95 : 0.5,
              }}
            />
          </button>
        )}
        {tab.pinned && (
          <Pin size={d.pinSize} className="shrink-0 opacity-60 rotate-45" style={{ color: "var(--app-accent)" }} onDoubleClick={(e) => e.stopPropagation()} />
        )}
        {tab.starred && (
          <Star
            size={d.pinSize}
            className="shrink-0 opacity-80"
            fill="currentColor"
            style={{ color: "var(--app-accent)" }}
            onDoubleClick={(e) => e.stopPropagation()}
          />
        )}
        {/* #N 编号移出标题截断预算：shrink-0 独立渲染，长标题只截标题本身 */}
        {displayNumber && !isEditing ? (
          <span className="shrink-0 opacity-60" aria-hidden="true">{`#${displayNumber}`}</span>
        ) : null}
        {isEditing ? (
          <InlineRename
            value={editingTitle}
            onChange={setEditingTitle}
            onConfirm={confirmRename}
            onCancel={cancelRename}
            confirmOnBlur={false}
            confirmOnOutsidePointerDown
            className="min-w-0 flex-1 text-xs font-medium rounded px-1 py-0.5 outline-none"
            style={{
              background: "var(--app-content)",
              border: "1px solid var(--app-accent)",
              color: "var(--app-text-primary)",
            }}
          />
        ) : (
          <span
            className="min-w-0 flex-1 truncate"
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
            {tab.title}
          </span>
        )}
        {/* 后台注意红点：会话完成/出错/等输入且标签不可见时亮，切过去自动灭 */}
        {hasAttentionMark && (
          <span
            aria-label={t("tabAttentionDot")}
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: "var(--app-status-danger)" }}
          />
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
  );

  if (isEditing) {
    return tabNode;
  }

  return (
    <TabContextMenu
      tab={tab}
      index={index}
      paneId={paneId}
      tabs={tabs}
      startRename={startRename}
      onClose={onClose}
      onTogglePin={onTogglePin}
      onToggleStar={onToggleStar}
      onSplitRight={onSplitRight}
      onSplitDown={onSplitDown}
      onSplitAndMoveRight={onSplitAndMoveRight}
      onSplitAndMoveDown={onSplitAndMoveDown}
      moveTargets={moveTargets}
      onMoveTabToPane={onMoveTabToPane}
      layoutMoveTargets={layoutMoveTargets}
      onMoveTabToLayoutPane={onMoveTabToLayoutPane}
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
      onCloneTab={onCloneTab}
      onToggleFullscreen={onToggleFullscreen}
      isPaneFullscreen={isPaneFullscreen}
      t={t}
    >
      {tabNode}
    </TabContextMenu>
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
  onToggleStar,
  onAddBrowser,
  onAddFile,
  onAddFileExplorer,
  onAdd,
  onSplitRight,
  onSplitDown,
  onFullscreen,
  onRename,
  onSplitAndMoveRight,
  onSplitAndMoveDown,
  moveTargets,
  onMoveTabToPane,
  layoutMoveTargets,
  onMoveTabToLayoutPane,
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
  onCloneTab,
  onToggleFullscreen,
  isPaneFullscreen,
  activeTabFg,
}: TabBarProps) {
  const { t } = useTranslation("panes");
  const getStatus = useTerminalStatusStore((s) => s.getStatus);

  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [sessionBindTab, setSessionBindTab] = useState<Tab | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const tabNodeRefs = useRef(new Map<string, HTMLDivElement>());
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  // 标签重命名
  const startRename = useCallback((tab: Tab) => {
    setEditingTabId(tab.id);
    setEditingTitle(tab.title);
  }, []);

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
    <div className="shape-chrome flex min-w-0 items-stretch">
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
            confirmRename={confirmRename}
                cancelRename={cancelRename}
                startRename={startRename}
                onSelect={onSelect}
                onClose={onClose}
                onTogglePin={onTogglePin}
                onToggleStar={onToggleStar}
                onFullscreen={onFullscreen}
                onSplitRight={onSplitRight}
                onSplitDown={onSplitDown}
                onSplitAndMoveRight={onSplitAndMoveRight}
                onSplitAndMoveDown={onSplitAndMoveDown}
                moveTargets={moveTargets}
                onMoveTabToPane={onMoveTabToPane}
                layoutMoveTargets={layoutMoveTargets}
                onMoveTabToLayoutPane={onMoveTabToLayoutPane}
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
                onCloneTab={onCloneTab}
                onToggleFullscreen={onToggleFullscreen}
                isPaneFullscreen={isPaneFullscreen}
                activeTabFg={activeTabFg}
                getStatus={getStatus}
                registerTabNode={registerTabNode}
                displayNumber={tabNumbers.get(tab.id)}
                onOpenSessionBind={setSessionBindTab}
                t={t}
              />
            ))}
            <NewTabMenu
              addBtnClass={d.addBtn}
              addIconClass={d.addIcon}
              onAdd={onAdd}
              onAddBrowser={onAddBrowser}
              onAddFile={onAddFile}
              onAddFileExplorer={onAddFileExplorer}
              t={t}
            />
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
      <SessionBindDialog
        tab={sessionBindTab}
        open={sessionBindTab !== null}
        onOpenChange={(open) => {
          if (!open) setSessionBindTab(null);
        }}
      />
    </div>
  );
});
