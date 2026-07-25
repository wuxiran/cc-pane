// 布局条上的单个可拖拽布局标签：拖动阈值 8px，点击/双击行为不受影响。
// 舒适档为「左双行文字 + 右 2×2 状态块」卡片，紧凑档为单行；右键菜单含密度切换。
// 绑定视觉语言：链条图标 + secondary 亮 = 右键显式绑定；无链 + tertiary 暗 + ? = 自动派生。
import { Link2, Rows2, Rows3, Star, X } from "lucide-react";
import { useTranslation } from "react-i18next";
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
import LayoutStatusDots from "./LayoutStatusDots";
import LayoutStatusGrid from "./LayoutStatusGrid";
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
}: {
  layout: LayoutEntry;
  tree: PaneNode;
  selected: boolean;
  tabCount: number;
  density: LayoutBarDensity;
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
        // 左块双行文字（可截断）+ 右块 2×2 状态格（永不挤压）
        <span className="flex w-full min-w-0 items-center gap-2">
          <span className="flex min-w-0 flex-1 flex-col gap-1">
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
              className="flex h-[13px] w-full min-w-0 items-center gap-1 overflow-hidden text-[12px] leading-none"
              style={{ color: "var(--app-text-tertiary)" }}
            >
              <LayoutBindingLabel layout={layout} rootPane={tree} />
              {statusSummary.total === 0 ? <span className="shrink-0">{idleLabel}</span> : null}
            </span>
          </span>
          {layout.kind !== "starred" ? <LayoutStatusGrid summary={statusSummary} /> : null}
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
