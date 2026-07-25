// 布局条（topbar 模式）：终端标签上方的一层，水平列出全部布局。
// 点击切换、双击重命名、悬停删除、＋新建；与左下角 LayoutBar 共用同一份
// layouts 状态（usePanesStore），只是展示位置不同。右端按钮可切回 corner 模式。
import { useEffect, useRef, useState } from "react";
import { ArrowDownLeft, Command, Plus, Rows2, Rows3 } from "lucide-react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import {
  useActivityBarStore,
  useLayoutUiStore,
  usePanesStore,
  useTerminalStatusStore,
} from "@/stores";
import { matchLayoutPreset } from "@/stores/usePanesStore";
import { collectTerminalTabs } from "@/lib/paneSessions";
import type { LayoutEntry } from "@/types";
import type { LayoutPresetId } from "@/types/pane";
import LayoutDeleteDialog, { summarizeLayoutDelete, type DeleteSummary } from "./LayoutDeleteDialog";
import SortableLayoutTab from "./SortableLayoutTab";
import { deriveLayoutStatusSummary } from "./layoutStatusSummary";

// 预设示意图标：16×16 小色块拼出目标分屏结构
const PRESET_ICONS: Record<LayoutPresetId, React.ReactNode> = {
  "single": <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />,
  "two-col": (
    <>
      <rect x="1.5" y="2.5" width="6" height="11" rx="1" />
      <rect x="8.5" y="2.5" width="6" height="11" rx="1" />
    </>
  ),
  "three-col": (
    <>
      <rect x="1.5" y="2.5" width="3.6" height="11" rx="1" />
      <rect x="6.2" y="2.5" width="3.6" height="11" rx="1" />
      <rect x="10.9" y="2.5" width="3.6" height="11" rx="1" />
    </>
  ),
  "two-row": (
    <>
      <rect x="1.5" y="2.5" width="13" height="5" rx="1" />
      <rect x="1.5" y="8.5" width="13" height="5" rx="1" />
    </>
  ),
  "grid-2x2": (
    <>
      <rect x="1.5" y="2.5" width="6" height="5" rx="1" />
      <rect x="8.5" y="2.5" width="6" height="5" rx="1" />
      <rect x="1.5" y="8.5" width="6" height="5" rx="1" />
      <rect x="8.5" y="8.5" width="6" height="5" rx="1" />
    </>
  ),
  "main-side": (
    <>
      <rect x="1.5" y="2.5" width="7.5" height="11" rx="1" />
      <rect x="10" y="2.5" width="4.5" height="5" rx="1" />
      <rect x="10" y="8.5" width="4.5" height="5" rx="1" />
    </>
  ),
};

const PRESET_ORDER = [
  { id: "single", labelKey: "layoutPresetSingle" },
  { id: "two-col", labelKey: "layoutPresetTwoCol" },
  { id: "three-col", labelKey: "layoutPresetThreeCol" },
  { id: "two-row", labelKey: "layoutPresetTwoRow" },
  { id: "grid-2x2", labelKey: "layoutPresetGrid" },
  { id: "main-side", labelKey: "layoutPresetMainSide" },
] as const satisfies ReadonlyArray<{ id: LayoutPresetId; labelKey: string }>;

export default function LayoutTopBar() {
  const { t } = useTranslation("panes");
  const layouts = usePanesStore((s) => s.layouts);
  const currentLayoutId = usePanesStore((s) => s.currentLayoutId);
  const liveRootPane = usePanesStore((s) => s.rootPane);
  const switchLayout = usePanesStore((s) => s.switchLayout);
  const createLayout = usePanesStore((s) => s.createLayout);
  const renameLayout = usePanesStore((s) => s.renameLayout);
  const reorderLayouts = usePanesStore((s) => s.reorderLayouts);
  const applyLayoutPreset = usePanesStore((s) => s.applyLayoutPreset);
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

  // 拖拽排序：8px 阈值区分点击与拖动，复用左下角面板同一套 reorderLayouts
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  function handleLayoutDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const fromIndex = layouts.findIndex((layout) => layout.id === active.id);
    const toIndex = layouts.findIndex((layout) => layout.id === over.id);
    if (fromIndex !== -1 && toIndex !== -1) {
      reorderLayouts(fromIndex, toIndex);
    }
  }

  return (
    <div
      className={`flex flex-shrink-0 items-center gap-1 overflow-x-auto border-b px-2 ${
        density === "comfortable" ? "h-[58px]" : "h-9"
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

      <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleLayoutDragEnd}>
        <SortableContext items={layouts.map((layout) => layout.id)} strategy={horizontalListSortingStrategy}>
          {layouts.map((layout) => {
            const selected = layout.id === currentLayoutId;
            const tree = selected ? liveRootPane : layout.rootPane;
            const tabCount = layout.kind === "starred" ? 0 : collectTerminalTabs(tree).length;
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
                statusSummary={statusSummary}
                statusMap={statusMap}
                idleLabel={t("layoutIdle")}
                densityToggleLabel={densityToggleLabel}
                deletable={layout.kind !== "starred" && !deletingLastLayout}
                deleteLabel={t("deleteLayout")}
                onSelect={() => selectLayout(layout.id)}
                onStartRename={() => startRename(layout)}
                onRequestDelete={() => requestDelete(layout)}
                onToggleDensity={() => setDensity(nextDensity)}
              />
            );
          })}
        </SortableContext>
      </DndContext>

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

      {currentLayoutStarred ? null : (
        <div
          className="ml-auto flex flex-shrink-0 items-center gap-0.5 pl-1.5"
          role="group"
          aria-label={t("layoutPresets")}
        >
          {PRESET_ORDER.map(({ id, labelKey }) => {
            const active = matchedPreset === id;
            return (
              <Tooltip key={id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={t(labelKey)}
                    aria-pressed={active}
                    className={`flex h-[26px] w-[26px] items-center justify-center rounded-md transition-colors duration-[var(--dur-fast)] ${
                      active ? "" : "hover:bg-[var(--app-hover)]"
                    }`}
                    style={
                      active
                        ? {
                            background: "color-mix(in srgb, var(--app-accent) 12%, transparent)",
                            color: "var(--app-accent)",
                          }
                        : { color: "var(--app-text-tertiary)" }
                    }
                    onClick={() => {
                      setAppViewMode("panes");
                      applyLayoutPreset(id);
                    }}
                  >
                    <svg
                      viewBox="0 0 16 16"
                      className="h-3.5 w-3.5"
                      fill="currentColor"
                      aria-hidden
                    >
                      {PRESET_ICONS[id]}
                    </svg>
                  </button>
                </TooltipTrigger>
                <TooltipContent>{t(labelKey)}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      )}

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
