import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Files, Pin } from "lucide-react";
import { useEditorTabsStore, type EditorTab } from "@/stores/useEditorTabsStore";
import { useFileBrowserStore } from "@/stores/useFileBrowserStore";
import { useFileTreeStore } from "@/stores/useFileTreeStore";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { getFileIcon } from "@/components/filetree/FileTreeNode";
import EditorView from "./EditorView";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem,
  ContextMenuSeparator, ContextMenuTrigger,
} from "@/components/ui/context-menu";

/** 提取文件所在的父目录 */
function getParentDir(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) return normalized;
  return normalized.slice(0, lastSlash);
}

/** Chrome 风格密度配置 */
const DENSITY = {
  normal: {
    barHeight: 'h-[42px]', barPadding: 'px-2 pt-2',
    tabHeight: 'h-[34px]', tabPadding: 'px-3',
    tabRadius: 'rounded-t-[10px]', tabMaxW: 'max-w-[240px]', tabMinW: 'min-w-[140px]',
    inactiveRadius: 'rounded-[8px]', inactiveMargin: 'mx-0.5 mb-[4px]',
    skirtSize: 10, fontSize: 'text-[13px]', titleMaxW: 'max-w-[140px]',
    iconSize: 14, closeBtnSize: 'w-[22px] h-[22px]', closeIconSize: 13,
    separatorH: 'h-5', pinSize: 11, iconGap: 'mr-2.5', titleGap: 'pr-2',
  },
  compact: {
    barHeight: 'h-[36px]', barPadding: 'px-1.5 pt-1.5',
    tabHeight: 'h-[28px]', tabPadding: 'px-2.5',
    tabRadius: 'rounded-t-[8px]', tabMaxW: 'max-w-[200px]', tabMinW: 'min-w-[100px]',
    inactiveRadius: 'rounded-[6px]', inactiveMargin: 'mx-0.5 mb-[3px]',
    skirtSize: 8, fontSize: 'text-[12px]', titleMaxW: 'max-w-[110px]',
    iconSize: 13, closeBtnSize: 'w-[18px] h-[18px]', closeIconSize: 11,
    separatorH: 'h-4', pinSize: 10, iconGap: 'mr-2', titleGap: 'pr-1.5',
  },
  dense: {
    barHeight: 'h-[30px]', barPadding: 'px-1 pt-1',
    tabHeight: 'h-[24px]', tabPadding: 'px-2',
    tabRadius: 'rounded-t-[6px]', tabMaxW: 'max-w-[160px]', tabMinW: 'min-w-[80px]',
    inactiveRadius: 'rounded-[5px]', inactiveMargin: 'mx-0.5 mb-[2px]',
    skirtSize: 6, fontSize: 'text-[11px]', titleMaxW: 'max-w-[80px]',
    iconSize: 12, closeBtnSize: 'w-[16px] h-[16px]', closeIconSize: 10,
    separatorH: 'h-3', pinSize: 9, iconGap: 'mr-1.5', titleGap: 'pr-1',
  },
} as const;

type Density = keyof typeof DENSITY;

function getDensity(count: number): Density {
  if (count <= 3) return 'normal';
  if (count <= 6) return 'compact';
  return 'dense';
}

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

function EditorTabItem({
  tab,
  active,
  activeTabId,
  index,
  tabs,
  density,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onCloseToLeft,
  onTogglePin,
  onRevealInExplorer,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  draggingIndex,
}: {
  tab: EditorTab;
  active: boolean;
  activeTabId: string | null;
  index: number;
  tabs: EditorTab[];
  density: Density;
  onSelect: () => void;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseToRight: () => void;
  onCloseToLeft: () => void;
  onTogglePin: () => void;
  onRevealInExplorer: () => void;
  onDragStart: (e: React.DragEvent, index: number) => void;
  onDragOver: (e: React.DragEvent, index: number) => void;
  onDrop: (e: React.DragEvent, index: number) => void;
  onDragEnd: () => void;
  draggingIndex: number | null;
}) {
  const { t } = useTranslation("panes");
  const d = DENSITY[density];

  // 禁用状态计算
  const hasUnpinnedToLeft = tabs.slice(0, index).some((t) => !t.pinned);
  const hasUnpinnedToRight = tabs.slice(index + 1).some((t) => !t.pinned);
  const hasOtherUnpinned = tabs.some((t) => t.id !== tab.id && !t.pinned);
  const isDragging = draggingIndex === index;

  // 文件扩展名
  const ext = tab.filePath.split(".").pop() || null;

  // 竖线分隔符逻辑：非活跃标签之间显示，active 相邻时隐藏
  const showSeparator = index > 0
    && tab.id !== activeTabId
    && tabs[index - 1].id !== activeTabId;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className="relative flex items-center h-full group"
          draggable
          onDragStart={(e) => onDragStart(e, index)}
          onDragOver={(e) => onDragOver(e, index)}
          onDrop={(e) => onDrop(e, index)}
          onDragEnd={onDragEnd}
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
            className={`relative flex items-center ${d.tabHeight} ${d.tabPadding} ${d.tabMaxW} ${d.tabMinW}
              cursor-pointer select-none transition-colors ${d.fontSize}
              ${isDragging ? 'opacity-50' : ''}
              ${active
                ? `${d.tabRadius} z-20`
                : `${d.inactiveRadius} ${d.inactiveMargin} hover:bg-[var(--app-hover)]`
              }`}
            style={{
              background: active ? 'var(--editor-tab-active-bg)' : 'transparent',
              color: active ? 'var(--editor-tab-active-fg)' : 'var(--editor-tab-inactive-fg)',
            }}
            onClick={onSelect}
          >
            {/* SVG skirts — 仅活跃标签 */}
            {active && (
              <>
                <TabSkirtLeft size={d.skirtSize} />
                <TabSkirtRight size={d.skirtSize} />
              </>
            )}

            {/* 文件图标 */}
            <span className={`${d.iconGap} opacity-90 flex items-center justify-center shrink-0`}>
              {getFileIcon(ext, d.iconSize)}
            </span>

            {/* Pin 图标 */}
            {tab.pinned && (
              <Pin size={d.pinSize} className="shrink-0 rotate-45 mr-1" style={{ color: 'var(--app-accent)' }} />
            )}

            {/* 文件名 */}
            <span className={`truncate flex-1 ${d.titleGap} ${d.titleMaxW} ${active ? 'font-medium' : ''}`}>
              {tab.dirty && <span className="mr-0.5 text-amber-400">●</span>}
              {tab.title}
            </span>

            {/* 关闭按钮 — active 常驻，inactive hover 显示 */}
            {!tab.pinned && (
              <div
                className={`flex items-center justify-center ${d.closeBtnSize} rounded-full
                  hover:bg-[var(--app-hover)] transition-colors
                  ${active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                style={{ color: 'var(--editor-tab-inactive-fg)' }}
                onClick={(e) => { e.stopPropagation(); onClose(); }}
              >
                <X size={d.closeIconSize} strokeWidth={2.5} />
              </div>
            )}
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {/* Pin / Unpin */}
        <ContextMenuItem onClick={onTogglePin}>
          {tab.pinned
            ? t("unpinTab", { defaultValue: "Unpin" })
            : t("pinTab", { defaultValue: "Pin Tab" })}
        </ContextMenuItem>
        <ContextMenuSeparator />
        {/* 定位到文件 */}
        <ContextMenuItem onClick={onRevealInExplorer}>
          {t("revealInExplorer", { defaultValue: "Reveal in File Tree" })}
        </ContextMenuItem>
        <ContextMenuSeparator />
        {/* 关闭左侧 */}
        <ContextMenuItem onClick={onCloseToLeft} disabled={!hasUnpinnedToLeft}>
          {t("closeTabsToLeft", { defaultValue: "Close Tabs to the Left" })}
        </ContextMenuItem>
        {/* 关闭右侧 */}
        <ContextMenuItem onClick={onCloseToRight} disabled={!hasUnpinnedToRight}>
          {t("closeTabsToRight", { defaultValue: "Close Tabs to the Right" })}
        </ContextMenuItem>
        {/* 关闭其他 */}
        <ContextMenuItem onClick={onCloseOthers} disabled={!hasOtherUnpinned}>
          {t("closeOtherTabs", { defaultValue: "Close Other Tabs" })}
        </ContextMenuItem>
        {/* 关闭当前 - pinned 时隐藏 */}
        {!tab.pinned && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              onClick={onClose}
              className="text-destructive"
            >
              {t("closeTab", { defaultValue: "Close Tab" })}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

export default function FileEditorPanel() {
  const { t } = useTranslation("sidebar");
  const tabs = useEditorTabsStore((s) => s.tabs);
  const activeTabId = useEditorTabsStore((s) => s.activeTabId);
  const selectTab = useEditorTabsStore((s) => s.selectTab);
  const closeTab = useEditorTabsStore((s) => s.closeTab);
  const closeOtherTabs = useEditorTabsStore((s) => s.closeOtherTabs);
  const closeTabsToRight = useEditorTabsStore((s) => s.closeTabsToRight);
  const closeTabsToLeft = useEditorTabsStore((s) => s.closeTabsToLeft);
  const togglePin = useEditorTabsStore((s) => s.togglePin);
  const reorderTabs = useEditorTabsStore((s) => s.reorderTabs);
  const setDirty = useEditorTabsStore((s) => s.setDirty);

  const navigateTo = useFileBrowserStore((s) => s.navigateTo);
  const revealFile = useFileTreeStore((s) => s.revealFile);
  const toggleView = useActivityBarStore((s) => s.toggleView);
  const activeView = useActivityBarStore((s) => s.activeView);
  const appViewMode = useActivityBarStore((s) => s.appViewMode);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  // 拖拽状态
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [, setDragOverIndex] = useState<number | null>(null);

  const handleDragStart = useCallback(
    (e: React.DragEvent, index: number) => {
      setDraggingIndex(index);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(index));
    },
    []
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent, index: number) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDragOverIndex(index);
    },
    []
  );

  const handleDrop = useCallback(
    (e: React.DragEvent, toIndex: number) => {
      e.preventDefault();
      const fromIndex = Number(e.dataTransfer.getData("text/plain"));
      if (!isNaN(fromIndex) && fromIndex !== toIndex) {
        reorderTabs(fromIndex, toIndex);
      }
      setDraggingIndex(null);
      setDragOverIndex(null);
    },
    [reorderTabs]
  );

  const handleDragEnd = useCallback(() => {
    setDraggingIndex(null);
    setDragOverIndex(null);
  }, []);

  const handleRevealInExplorer = useCallback(
    (tab: EditorTab) => {
      const parentDir = getParentDir(tab.filePath);
      // 确保切换到 files 视图
      if (activeView !== "files" || appViewMode !== "files") {
        toggleView("files");
      }
      // 导航到父目录
      navigateTo(parentDir);
      // 展开并高亮文件
      revealFile(parentDir, tab.filePath);
    },
    [activeView, appViewMode, toggleView, navigateTo, revealFile]
  );

  const handleDirtyChange = useCallback(
    (tabId: string) => (dirty: boolean) => {
      setDirty(tabId, dirty);
    },
    [setDirty]
  );

  if (tabs.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center h-full gap-3 border text-muted-foreground"
        style={{ background: "var(--editor-bg)", borderColor: "var(--app-border)" }}
      >
        <Files size={48} className="opacity-30" />
        <span className="text-sm">
          {t("noOpenFiles", { defaultValue: "No open files" })}
        </span>
        <span className="text-xs opacity-60">
          {t("openFileHint", { defaultValue: "Click a file in the explorer to open it" })}
        </span>
      </div>
    );
  }

  const density = getDensity(tabs.length);
  const d = DENSITY[density];

  return (
    <div
      className="flex flex-col h-full overflow-hidden border"
      style={{ background: "var(--editor-bg)", borderColor: "var(--app-border)" }}
    >
      {/* Chrome-style Tab Bar */}
      <div
        className={`flex items-end ${d.barHeight} ${d.barPadding} overflow-x-auto no-scrollbar shrink-0`}
        style={{ background: 'var(--app-tabbar)' }}
      >
        {tabs.map((tab, index) => (
          <EditorTabItem
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            activeTabId={activeTabId}
            index={index}
            tabs={tabs}
            density={density}
            onSelect={() => selectTab(tab.id)}
            onClose={() => closeTab(tab.id)}
            onCloseOthers={() => closeOtherTabs(tab.id)}
            onCloseToRight={() => closeTabsToRight(tab.id)}
            onCloseToLeft={() => closeTabsToLeft(tab.id)}
            onTogglePin={() => togglePin(tab.id)}
            onRevealInExplorer={() => handleRevealInExplorer(tab)}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onDragEnd={handleDragEnd}
            draggingIndex={draggingIndex}
          />
        ))}
      </div>

      {/* 编辑器区域 */}
      <div className="flex-1 overflow-hidden">
        {activeTab && (
          <EditorView
            key={activeTab.id}
            filePath={activeTab.filePath}
            projectPath={activeTab.projectPath}
            onDirtyChange={handleDirtyChange(activeTab.id)}
          />
        )}
      </div>
    </div>
  );
}
