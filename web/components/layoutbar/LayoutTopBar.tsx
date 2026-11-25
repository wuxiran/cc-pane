// 布局条（topbar 模式）：终端标签上方的一层，水平列出全部布局。
// 点击切换、双击重命名、悬停删除、＋新建；与左下角 LayoutBar 共用同一份
// layouts 状态（usePanesStore），只是展示位置不同。右端按钮可切回 corner 模式。
// 布局预设 / 星标 / Agent Chat 收在 LayoutPresetPicker 簇里；顶栏卡片只列用户布局。
// 从左到右：布局卡片（可横向滚动）│ 视图菜单 · 星标/预设簇 · ＋新建（固定在右端，不随卡片滚动）。
// 自动适配布局的开关只留在 corner 模式的 LayoutSelectorPanel，顶栏不再放。
import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { focusTab } from "@/hooks/useFocusTab";
import { asTabId } from "@/types/ids";
import {
  useActivityBarStore,
  useLayoutUiStore,
  usePanesStore,
  useTerminalStatusStore,
} from "@/stores";
import { matchLayoutPreset } from "@/stores/usePanesStore";
import { isNormalLayout } from "@/stores/paneLayoutHelpers";
import type { LayoutEntry } from "@/types";
import LayoutDeleteDialog, { summarizeLayoutDelete, type DeleteSummary } from "./LayoutDeleteDialog";
import LayoutViewMenu from "./LayoutViewMenu";
import LayoutPresetPicker from "./LayoutPresetPicker";
import SortableLayoutTab from "./SortableLayoutTab";
import LayoutGroupChip from "./LayoutGroupChip";
import LayoutAllMenu from "./LayoutAllMenu";
import PinnedLayoutTab from "./PinnedLayoutTab";
import { buildLayoutStripEntries } from "./layoutStripGroups";
import LayoutTabStrip from "./LayoutTabStrip";
import { deriveLayoutStatusSummary } from "./layoutStatusSummary";
import { deriveLayoutTypeSummary } from "./layoutTypeSummary";

export default function LayoutTopBar() {
  const { t } = useTranslation("panes");
  const layouts = usePanesStore((s) => s.layouts);
  const currentLayoutId = usePanesStore((s) => s.currentLayoutId);
  const liveRootPane = usePanesStore((s) => s.rootPane);
  const switchLayout = usePanesStore((s) => s.switchLayout);
  const createLayout = usePanesStore((s) => s.createLayout);
  const renameLayout = usePanesStore((s) => s.renameLayout);
  const selectTab = usePanesStore((s) => s.selectTab);
  const setActivePane = usePanesStore((s) => s.setActivePane);
  const statusMap = useTerminalStatusStore((s) => s.statusMap);
  const setAppViewMode = useActivityBarStore((s) => s.setAppViewMode);
  const density = useLayoutUiStore((s) => s.layoutBarDensity);
  const setDensity = useLayoutUiStore((s) => s.setLayoutBarDensity);
  const collapsedGroups = useLayoutUiStore((s) => s.collapsedLayoutGroups);
  const setGroupCollapsed = useLayoutUiStore((s) => s.setLayoutGroupCollapsed);
  const pinnedIds = useLayoutUiStore((s) => s.pinnedLayoutIds);
  const pinnedSide = useLayoutUiStore((s) => s.pinnedLayoutSide);
  const setLayoutPinned = useLayoutUiStore((s) => s.setLayoutPinned);
  const setPinnedSide = useLayoutUiStore((s) => s.setPinnedLayoutSide);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [deleteSummary, setDeleteSummary] = useState<DeleteSummary | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editingId) editInputRef.current?.select();
  }, [editingId]);

  const stripLayouts = layouts.filter(isNormalLayout);
  const deletingLastLayout = stripLayouts.length <= 1;
  const currentLayoutStarred =
    layouts.find((layout) => layout.id === currentLayoutId)?.kind === "starred";
  const matchedPreset = currentLayoutStarred ? null : matchLayoutPreset(liveRootPane);
  // 按工作空间成组（Chrome 标签组式）；折叠的组只剩组头，当前布局仍紧跟组头显示。
  // 固定的布局缩成图标常驻一端（不随卡片区滚动、不参与分组）。
  const pinnedLayouts = stripLayouts.filter((layout) => pinnedIds.includes(layout.id));
  const scrollingLayouts = stripLayouts.filter((layout) => !pinnedIds.includes(layout.id));
  const stripEntries = buildLayoutStripEntries(scrollingLayouts, {
    currentLayoutId,
    liveRootPane,
    collapsedGroups,
  });
  const visibleLayoutIds = stripEntries.flatMap((entry) => entry.type === "layout" ? [entry.layout.id] : []);

  const pinnedZone = pinnedLayouts.length > 0 ? (
    <div
      data-testid="layout-pinned-zone"
      data-side={pinnedSide}
      className={`flex flex-shrink-0 items-center gap-0.5 ${pinnedSide === "left" ? "pr-1" : "pl-1"}`}
      style={{ [pinnedSide === "left" ? "borderRight" : "borderLeft"]: "1px solid var(--app-border)" }}
    >
      {pinnedLayouts.map((layout) => (
        <PinnedLayoutTab
          key={layout.id}
          layout={layout}
          tree={layout.id === currentLayoutId ? liveRootPane : layout.rootPane}
          selected={layout.id === currentLayoutId}
          density={density}
          statusMap={statusMap}
          side={pinnedSide}
          onSelect={() => selectLayout(layout.id)}
          onUnpin={() => setLayoutPinned(layout.id, false)}
          onMoveSide={setPinnedSide}
        />
      ))}
    </div>
  ) : null;

  function selectLayout(layoutId: string) {
    setAppViewMode("panes");
    switchLayout(layoutId);
  }

  // 类型计数桁的跳转：先切到目标布局，再把 active 指针指过去。
  // 只改指针不动挂载——切布局的 keep-alive 靠 display:none，卸载会重建终端。
  function jumpToTab(layoutId: string, paneId: string, tabId: string) {
    if (focusTab(asTabId(tabId), { switchAppView: true })) return;
    setAppViewMode("panes");
    if (layoutId !== currentLayoutId) switchLayout(layoutId);
    setActivePane(paneId);
    selectTab(paneId, tabId);
  }

  function startRename(layout: LayoutEntry) {
    if (layout.kind === "starred") return;
    setEditingId(layout.id);
    setEditingName(layout.name);
  }

  function confirmRename() {
    if (editingId && editingName.trim()) {
      renameLayout(editingId, editingName.trim());
    }
    setEditingId(null);
    setEditingName("");
  }

  function cancelRename() {
    setEditingId(null);
    setEditingName("");
  }

  function requestDelete(layout: LayoutEntry) {
    if (layout.kind === "starred" || deletingLastLayout) return;
    setDeleteSummary(summarizeLayoutDelete(layout));
  }

  // 拖拽排序与"把 tab 拖到布局上"共用 DndPaneProvider 的 context（见
  // MainViewSwitcher）。本组件不再自建 DndContext——嵌套 context 会让布局条
  // 的 droppable 对面板区的 tab 不可见。SortableContext 只需祖先有 DndContext。

  return (
    <div
      className={`flex min-w-0 max-w-full flex-shrink-0 items-center gap-1 overflow-hidden border-b px-2 ${
        density === "comfortable" ? "h-[52px]" : "h-9"
      }`}
      style={{
        background: "var(--app-panel-bg)",
        borderColor: "var(--app-border)",
      }}
      role="tablist"
      aria-label={t("layouts")}
      data-density={density}
    >
      {pinnedSide === "left" ? pinnedZone : null}

      <LayoutTabStrip
        activeLayoutId={currentLayoutId}
        revealKey={JSON.stringify([density, editingId, visibleLayoutIds])}
      >
        <SortableContext items={visibleLayoutIds} strategy={horizontalListSortingStrategy}>
          {stripEntries.map((entry) => {
            if (entry.type === "group") {
              return (
                <LayoutGroupChip
                  key={`group:${entry.group.key}`}
                  group={entry.group}
                  density={density}
                  currentLayoutId={currentLayoutId}
                  liveRootPane={liveRootPane}
                  statusMap={statusMap}
                  onToggle={(collapsed) => setGroupCollapsed(entry.group.key, collapsed)}
                  onSelectLayout={selectLayout}
                />
              );
            }
            const { layout, group } = entry;
            const selected = layout.id === currentLayoutId;
            const tree = selected ? liveRootPane : layout.rootPane;
            // tabCount 是**全类型** tab 总数，与下方类型计数桁各桁之和一致——
            // 顶部写 5 而下面加起来是 3 会让人以为少的两个丢了。
            const typeCounts = deriveLayoutTypeSummary(tree, layout.kind);
            const tabCount = typeCounts.total;
            const statusSummary = deriveLayoutStatusSummary(tree, statusMap);
            const isEditing = editingId === layout.id;

            if (isEditing) {
              return (
                <input
                  key={layout.id}
                  ref={editInputRef}
                  data-layout-id={layout.id}
                  value={editingName}
                  onChange={(event) => setEditingName(event.target.value)}
                  onBlur={confirmRename}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") confirmRename();
                    if (event.key === "Escape") cancelRename();
                  }}
                  className="h-[26px] w-28 flex-shrink-0 rounded-md border px-2 text-xs outline-none"
                  style={{
                    background: "var(--app-panel-bg)",
                    borderColor: "var(--app-accent)",
                    color: "var(--app-text-primary)",
                  }}
                />
              );
            }

            return (
              <SortableLayoutTab
                key={layout.id}
                layout={layout}
                tree={tree}
                selected={selected}
                tabCount={tabCount}
                density={density}
                typeCounts={typeCounts}
                statusSummary={statusSummary}
                statusMap={statusMap}
                idleLabel={t("layoutNoSessions")}
                densityToggleLabel={t(density === "comfortable" ? "layoutDensityCompact" : "layoutDensityComfortable")}
                deletable={layout.kind !== "starred" && !deletingLastLayout}
                deleteLabel={t("deleteLayout")}
                onSelect={() => selectLayout(layout.id)}
                onStartRename={() => startRename(layout)}
                onRequestDelete={() => requestDelete(layout)}
                onToggleDensity={() => setDensity(density === "comfortable" ? "compact" : "comfortable")}
                onJumpToTab={(paneId, tabId) => jumpToTab(layout.id, paneId, tabId)}
                groupKey={group?.key ?? null}
                onCollapseGroup={group ? () => setGroupCollapsed(group.key, true) : undefined}
                onPin={() => setLayoutPinned(layout.id, true)}
              />
            );
          })}
        </SortableContext>
      </LayoutTabStrip>

      {pinnedSide === "right" ? pinnedZone : null}

      {/* 工具组固定在右端：竖线与卡片区分隔，卡片溢出滚动时它不跟着动。 */}
      <div data-testid="layout-tools" className="flex flex-shrink-0 items-center gap-1 self-stretch">
        <span aria-hidden="true" className="mx-0.5 h-4 w-px flex-shrink-0" style={{ background: "var(--app-border)" }} />
        <LayoutAllMenu
          layouts={stripLayouts}
          currentLayoutId={currentLayoutId}
          liveRootPane={liveRootPane}
          statusMap={statusMap}
          onSelect={selectLayout}
        />
        <LayoutViewMenu />
        {/* 舒适档：星标 / 预设纯图标上下叠放；紧凑档同一组并排。 */}
        <div
          data-testid="layout-preset-cluster"
          data-density={density}
          className={
            density === "comfortable"
              ? "flex h-[44px] flex-shrink-0 items-stretch gap-0.5"
              : "flex flex-shrink-0 items-center gap-0.5"
          }
        >
          <LayoutPresetPicker matchedPreset={matchedPreset} stacked={density === "comfortable"} />
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t("newLayout")}
              className="flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-md transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)]"
              style={{ color: "var(--app-text-tertiary)" }}
              onClick={() => {
                setAppViewMode("panes");
                createLayout();
              }}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t("newLayout")}</TooltipContent>
        </Tooltip>
      </div>

      <LayoutDeleteDialog
        summary={deleteSummary}
        onClose={() => setDeleteSummary(null)}
        t={t}
      />
    </div>
  );
}
