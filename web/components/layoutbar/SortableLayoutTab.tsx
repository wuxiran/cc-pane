// 布局条上的单个可拖拽布局标签：拖动阈值 8px，点击/双击行为不受影响。
// 舒适档为两行卡片（名称行 + 运行项目摘要行），紧凑档为单行；右键菜单含密度切换。
import { Rows2, Rows3, Star, X } from "lucide-react";
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
import type { LayoutBarDensity } from "@/stores";
import type { LayoutEntry, PaneNode, TerminalStatusInfo } from "@/types";
import LayoutProjectSummaryView from "./LayoutProjectSummaryView";
import LayoutStatusDots from "./LayoutStatusDots";
import type { LayoutProjectSummary as LayoutProjectSummaryData } from "./layoutProjectSummary";

export default function SortableLayoutTab({
  layout,
  tree,
  selected,
  tabCount,
  density,
  projectSummary,
  statusMap,
  idleLabel,
  densityToggleLabel,
  deletable,
  deleteLabel,
  onSelect,
  onStartRename,
  onRequestDelete,
  onToggleDensity,
}: {
  layout: LayoutEntry;
  tree: PaneNode;
  selected: boolean;
  tabCount: number;
  density: LayoutBarDensity;
  projectSummary: LayoutProjectSummaryData;
  statusMap: Map<string, TerminalStatusInfo>;
  idleLabel: string;
  densityToggleLabel: string;
  deletable: boolean;
  deleteLabel: string;
  onSelect: () => void;
  onStartRename: () => void;
  onRequestDelete: () => void;
  onToggleDensity: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: layout.id,
  });

  const DensityIcon = density === "comfortable" ? Rows2 : Rows3;
  const statusDots = layout.kind === "starred"
    ? null
    : <LayoutStatusDots rootPane={tree} statusMap={statusMap} />;
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
      className={`group flex flex-shrink-0 cursor-pointer select-none whitespace-nowrap rounded-md border px-3 text-[13px] transition-colors duration-[var(--dur-fast)] ${
        density === "comfortable"
          ? "h-[50px] min-w-[176px] max-w-[240px] flex-col justify-center gap-0.5 py-1.5 text-left"
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
      }}
      onClick={onSelect}
      onDoubleClick={onStartRename}
    >
      {density === "comfortable" ? (
        <>
          <span className="flex w-full min-w-0 items-center gap-1.5">
            {layout.kind === "starred" && <Star className="h-3 w-3 shrink-0" aria-hidden />}
            <span className="min-w-0 flex-1 overflow-hidden text-ellipsis">{layout.name}</span>
            {layout.kind !== "starred" && <LayoutWorkspaceBadge layout={layout} rootPane={tree} mini />}
            {tabCount > 0 ? (
              <span
                className="shrink-0 text-[11px] tabular-nums"
                style={{ color: selected ? "inherit" : "var(--app-text-tertiary)" }}
              >
                {tabCount}
              </span>
            ) : null}
            {statusDots}
            {deleteButton}
          </span>
          <span
            className="flex w-full min-w-0 items-center overflow-hidden text-[11px] leading-none"
            style={{ color: "var(--app-text-tertiary)" }}
          >
            <LayoutProjectSummaryView summary={projectSummary} idleLabel={idleLabel} />
          </span>
        </>
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
      <ContextMenuContent className="z-[120] w-44">
        {layout.kind !== "starred" ? (
          <>
            <LayoutWorkspaceMenuItems layout={layout} />
            <ContextMenuSeparator />
          </>
        ) : null}
        <ContextMenuItem onSelect={onToggleDensity}>
          <DensityIcon />
          {densityToggleLabel}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
