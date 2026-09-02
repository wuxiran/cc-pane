// 布局条（topbar 模式）：终端标签上方的一层，水平列出全部布局。
// 点击切换、双击重命名、悬停删除、＋新建；与左下角 LayoutBar 共用同一份
// layouts 状态（usePanesStore），只是展示位置不同。右端按钮可切回 corner 模式。
// 布局预设收在 LayoutPresetPicker 的浮层里，不再常驻一排图标。
import { useEffect, useRef, useState } from "react";
import { ArrowDownLeft, Command, Plus, Rows2, Rows3 } from "lucide-react";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { focusTab } from "@/hooks/useFocusTab";
import { asTabId } from "@/types/ids";
import {
  useActivityBarStore,
  useLayoutUiStore,
  usePanesStore,
  useTerminalStatusStore,
} from "@/stores";
import { matchLayoutPreset } from "@/stores/usePanesStore";
import type { LayoutEntry } from "@/types";
import LayoutDeleteDialog, { summarizeLayoutDelete, type DeleteSummary } from "./LayoutDeleteDialog";
import CanvasDisplayToggle from "@/components/canvas/CanvasDisplayToggle";
import LayoutPresetPicker from "./LayoutPresetPicker";
import SortableLayoutTab from "./SortableLayoutTab";
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
  const setSwitcherMode = useLayoutUiStore((s) => s.setSwitcherMode);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [deleteSummary, setDeleteSummary] = useState<DeleteSummary | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editingId) editInputRef.current?.select();
  }, [editingId]);

  const normalLayoutCount = layouts.filter((layout) => layout.kind !== "starred").length;
  const deletingLastLayout = normalLayoutCount <= 1;
  const currentLayoutStarred =
    layouts.find((layout) => layout.id === currentLayoutId)?.kind === "starred";
  const matchedPreset = currentLayoutStarred ? null : matchLayoutPreset(liveRootPane);
  const nextDensity = density === "comfortable" ? "compact" : "comfortable";
  const densityToggleLabel = t(
    nextDensity === "compact" ? "layoutDensityCompact" : "layoutDensityComfortable",
  );

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
      className={`flex flex-shrink-0 items-center gap-1 overflow-x-auto border-b px-2 ${
        density === "comfortable" ? "h-[72px]" : "h-9"
      }`}
      style={{
        background: "var(--app-panel-bg)",
        borderColor: "var(--app-border)",
      }}
      role="tablist"
      aria-label={t("layouts")}
      data-density={density}
    >
      <Command
        aria-hidden
        className="mx-1 h-3.5 w-3.5 flex-shrink-0"
        style={{ color: "var(--app-text-tertiary)" }}
      />

      <SortableContext items={layouts.map((layout) => layout.id)} strategy={horizontalListSortingStrategy}>
          {layouts.map((layout) => {
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
                densityToggleLabel={densityToggleLabel}
                deletable={layout.kind !== "starred" && !deletingLastLayout}
                deleteLabel={t("deleteLayout")}
                onSelect={() => selectLayout(layout.id)}
                onStartRename={() => startRename(layout)}
                onRequestDelete={() => requestDelete(layout)}
                onToggleDensity={() => setDensity(nextDensity)}
                onJumpToTab={(paneId, tabId) => jumpToTab(layout.id, paneId, tabId)}
              />
            );
          })}
      </SortableContext>

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

      {currentLayoutStarred ? null : <LayoutPresetPicker matchedPreset={matchedPreset} />}

      <div
        className="ml-1 flex flex-shrink-0 items-center border-l pl-1.5"
        style={{ borderColor: "var(--app-border)" }}
      >
        <CanvasDisplayToggle />
      </div>

      <div
        className={`flex flex-shrink-0 items-center border-l pl-1.5 ${
          currentLayoutStarred ? "ml-auto" : "ml-1"
        }`}
        style={{ borderColor: "var(--app-border)" }}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t("layoutModeCorner")}
              className="flex h-[26px] w-[26px] items-center justify-center rounded-md transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)]"
              style={{ color: "var(--app-text-tertiary)" }}
              onClick={() => setSwitcherMode("corner")}
            >
              <ArrowDownLeft className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t("layoutModeCorner")}</TooltipContent>
        </Tooltip>
        <IconTooltipButton
          label={densityToggleLabel}
          className="h-[26px] w-[26px] p-0 text-[var(--app-text-tertiary)]"
          onClick={() => setDensity(nextDensity)}
        >
          {density === "comfortable" ? (
            <Rows2 className="h-3.5 w-3.5" />
          ) : (
            <Rows3 className="h-3.5 w-3.5" />
          )}
        </IconTooltipButton>
      </div>

      <LayoutDeleteDialog
        summary={deleteSummary}
        onClose={() => setDeleteSummary(null)}
        t={t}
      />
    </div>
  );
}
