// 布局条上的单个可拖拽布局标签：拖动阈值 8px，点击/双击行为不受影响。
// 舒适档为三行卡片（名称+总数 / 绑定+状态桁 / 内容类型计数桁），紧凑档为单行；
// 右键菜单含重命名、绑定、密度切换、删除（与 corner 面板的行保持能力对等）。
// 绑定视觉语言：链条图标 + secondary 亮 = 右键显式绑定；无链 + tertiary 暗 + ? = 自动派生。
import { Link2, Pencil, Rows2, Rows3, Star, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useDndContext } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { LayoutWorkspaceBadge, LayoutWorkspaceMenuItems } from "./LayoutWorkspaceMenu";
import { getLayoutWorkspaceBinding } from "@/utils/layoutWorkspace";
import type { LayoutBarDensity } from "@/stores";
import type { LayoutEntry, PaneNode, TerminalStatusInfo } from "@/types";
import LayoutStatusRow from "./LayoutStatusRow";
import LayoutStatusGrid from "./LayoutStatusGrid";
import LayoutTypeCounts from "./LayoutTypeCounts";
import type { LayoutTypeSummary } from "./layoutTypeSummary";
import type { LayoutStatusSummary } from "./layoutStatusSummary";

/** 舒适档第二行的绑定标签：manual 亮+链条，derived 暗+问号 */
function LayoutBindingLabel({ layout, rootPane }: { layout: LayoutEntry; rootPane: PaneNode }) {
  const { t } = useTranslation("panes");
  const binding = getLayoutWorkspaceBinding({
    workspaceName: layout.workspaceName,
    rootPane,
  });
  if (!binding) return null;

  const manual = binding.source === "manual";
  return (
    <span
      title={t(manual ? "layoutWorkspaceBadgeManual" : "layoutWorkspaceBadgeDerived", {
        name: binding.workspaceName,
      })}
      data-binding-source={binding.source}
      className="flex min-w-0 items-center gap-1"
      style={{ color: manual ? "var(--app-text-secondary)" : "var(--app-text-tertiary)" }}
    >
      {manual ? <Link2 className="size-2.5 shrink-0" aria-hidden /> : null}
      <span className="truncate">
        {binding.workspaceName}
        {manual ? "" : "?"}
      </span>
    </span>
  );
}

export default function SortableLayoutTab({
  layout,
  tree,
  selected,
  tabCount,
  density,
  typeCounts,
  statusSummary,
  statusMap,
  idleLabel,
  densityToggleLabel,
  deletable,
  deleteLabel,
  onSelect,
  onStartRename,
  onRequestDelete,
  onToggleDensity,
  onJumpToTab,
}: {
  layout: LayoutEntry;
  tree: PaneNode;
  selected: boolean;
  tabCount: number;
  density: LayoutBarDensity;
  typeCounts: LayoutTypeSummary;
  statusSummary: LayoutStatusSummary;
  statusMap: Map<string, TerminalStatusInfo>;
  idleLabel: string;
  densityToggleLabel: string;
  deletable: boolean;
  deleteLabel: string;
  onSelect: () => void;
  onStartRename: () => void;
  onRequestDelete: () => void;
  onToggleDensity: () => void;
  onJumpToTab: (paneId: string, tabId: string) => void;
}) {
  const { t } = useTranslation("panes");
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } =
    useSortable({
      id: layout.id,
      data: { type: "layout", layoutId: layout.id, kind: layout.kind },
    });

  // 面板区的 tab 与布局条共用同一个 DndContext，所以这里能看到「正在拖 tab」。
  // 星标布局装不了终端 tab，当前布局落回自己是空操作——两者都不给反馈。
  const { active } = useDndContext();
  const draggingTab = active?.data.current?.type === "tab";
  const canAcceptTab = draggingTab && layout.kind !== "starred" && !selected;
  const dropState = canAcceptTab ? (isOver ? "active" : "candidate") : undefined;

  const DensityIcon = density === "comfortable" ? Rows2 : Rows3;
  const statusDots = layout.kind === "starred"
    ? null
    : <LayoutStatusRow rootPane={tree} statusMap={statusMap} />;
  const deleteButton = deletable ? (
    <span
      role="button"
      aria-label={deleteLabel}
      className="hidden h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm group-hover:flex hover:bg-[var(--app-hover)]"
      onClick={(event) => {
        event.stopPropagation();
        onRequestDelete();
      }}
    >
      <X className="h-3 w-3" />
    </span>
  ) : null;

  // ContextMenuTrigger asChild 通过 Radix Slot 合并 ref，与 dnd-kit 的 setNodeRef 共存。
  const tabButton = (
    <button
      ref={setNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      role="tab"
      aria-selected={selected}
      title={layout.name}
      data-density={density}
      data-drop-target={dropState}
      className={`group flex flex-shrink-0 cursor-pointer select-none whitespace-nowrap rounded-md border px-3 text-[13px] transition-colors duration-[var(--dur-fast)] ${
        density === "comfortable"
          ? "h-[64px] min-w-[176px] max-w-[240px] flex-col justify-center gap-0.5 py-1.5 text-left"
          : "h-[30px] items-center gap-1.5"
      } ${
        selected ? "" : "hover:bg-[var(--app-hover)]"
      }`}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : undefined,
        zIndex: isDragging ? 10 : undefined,
        ...(selected
          ? {
              background: "color-mix(in srgb, var(--app-accent) 12%, transparent)",
              borderColor: "var(--app-accent)",
              color: "var(--app-accent)",
              fontWeight: 600,
            }
          : {
              borderColor: "transparent",
              color: "var(--app-text-secondary)",
            }),
        // 落点态叠在选中态之后。悬停时用 accent 实线 + outline，让「可放置」与
        // 「已选中」除颜色外还有形状差异；候选态只给虚线弱提示。
        ...(dropState === "active"
          ? {
              background: "color-mix(in srgb, var(--app-accent) 12%, transparent)",
              borderColor: "var(--app-accent)",
              borderStyle: "solid",
              outline: "1px solid var(--app-accent)",
              outlineOffset: "1px",
            }
          : dropState === "candidate"
            ? {
                borderColor: "color-mix(in srgb, var(--app-accent) 40%, transparent)",
                borderStyle: "dashed",
              }
            : null),
      }}
      onClick={onSelect}
      onDoubleClick={onStartRename}
    >
      {density === "comfortable" ? (
        // 三行：①名称 + 全类型总数 + 删除 ②绑定标签 + 状态桁 ③内容类型计数桁
        <span className="flex w-full min-w-0 flex-col gap-1">
          <span className="flex w-full min-w-0 items-center gap-1.5">
            {layout.kind === "starred" && <Star className="h-3 w-3 shrink-0" aria-hidden />}
            <span
              className="min-w-0 flex-1 overflow-hidden text-ellipsis font-semibold"
              style={selected ? undefined : { color: "var(--app-text-primary)" }}
            >
              {layout.name}
            </span>
            {tabCount > 0 ? (
              <span
                className="shrink-0 text-[11px] tabular-nums"
                style={{ color: selected ? "inherit" : "var(--app-text-tertiary)" }}
              >
                {tabCount}
              </span>
            ) : null}
            {deleteButton}
          </span>
          <span
            className="flex h-[13px] w-full min-w-0 items-center gap-1.5 overflow-hidden text-[12px] leading-none"
            style={{ color: "var(--app-text-tertiary)" }}
          >
            <LayoutBindingLabel layout={layout} rootPane={tree} />
            {statusSummary.total === 0 ? <span className="shrink-0">{idleLabel}</span> : null}
            <span className="ml-auto shrink-0">
              {layout.kind !== "starred" ? <LayoutStatusGrid summary={statusSummary} /> : null}
            </span>
          </span>
          <span className="flex h-[13px] w-full min-w-0 items-center overflow-hidden">
            {layout.kind !== "starred" ? (
              <LayoutTypeCounts summary={typeCounts} selected={selected} onJump={onJumpToTab} />
            ) : null}
          </span>
        </span>
      ) : (
        <>
          {layout.kind === "starred" && <Star className="h-3 w-3 shrink-0" aria-hidden />}
          <span className="max-w-[140px] overflow-hidden text-ellipsis">{layout.name}</span>
          {layout.kind !== "starred" && <LayoutWorkspaceBadge layout={layout} rootPane={tree} mini />}
          {tabCount > 0 ? (
            <span
              className="text-[11px] tabular-nums"
              style={{ color: selected ? "inherit" : "var(--app-text-tertiary)" }}
            >
              {tabCount}
            </span>
          ) : null}
          {statusDots}
          {deleteButton}
        </>
      )}
    </button>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{tabButton}</ContextMenuTrigger>
      <ContextMenuContent className="z-[160] w-44">
        {layout.kind !== "starred" ? (
          <>
            <ContextMenuItem onSelect={onStartRename}>
              <Pencil />
              {t("renameLayout")}
            </ContextMenuItem>
            <LayoutWorkspaceMenuItems layout={layout} />
            <ContextMenuSeparator />
          </>
        ) : null}
        <ContextMenuItem onSelect={onToggleDensity}>
          <DensityIcon />
          {densityToggleLabel}
        </ContextMenuItem>
        {layout.kind !== "starred" ? (
          <>
            <ContextMenuSeparator />
            {/* 走与 hover × 同一条 onRequestDelete —— 删除是顺序敏感的
                （detachOutput/detachExit → killSession → deleteLayout，见
                LayoutDeleteDialog），不能另开一条路径绕过确认对话框。 */}
            <ContextMenuItem
              variant="destructive"
              disabled={!deletable}
              onSelect={() => {
                if (deletable) onRequestDelete();
              }}
            >
              <Trash2 />
              {deletable ? deleteLabel : t("cannotDeleteLastLayout")}
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}
