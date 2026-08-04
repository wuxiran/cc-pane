import type { SyntheticEvent } from "react";
import { Check, GripVertical, Star, Trash2 } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { TFunction } from "i18next";
import InlineRename from "@/components/ui/InlineRename";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { LayoutWorkspaceBadge, LayoutWorkspaceMenuItems } from "./LayoutWorkspaceMenu";
import type { LayoutEntry, PaneNode, TerminalStatusInfo } from "@/types";
import LayoutStatusRow from "./LayoutStatusRow";
import LayoutTypeCounts from "./LayoutTypeCounts";
import { deriveLayoutTypeSummary } from "./layoutTypeSummary";

export function layoutRowStyle(selected: boolean): React.CSSProperties {
  return {
    background: selected ? "var(--app-active-bg)" : "transparent",
    color: selected ? "var(--app-text-primary)" : "var(--app-text-secondary)",
  };
}

function stopLayoutRowAction(event: SyntheticEvent) {
  event.preventDefault();
  event.stopPropagation();
}

export function SortableLayoutRow({
  layout,
  rootPane,
  selected,
  isEditing,
  editingName,
  setEditingName,
  confirmRename,
  cancelRename,
  startRename,
  selectLayout,
  requestDelete,
  deletingLastLayout,
  isStarredLayout,
  handleContextMenuOpenChange,
  statusMap,
  onMouseEnter,
  onJumpToTab,
  t,
}: {
  layout: LayoutEntry;
  rootPane: PaneNode;
  selected: boolean;
  isEditing: boolean;
  editingName: string;
  setEditingName: (value: string) => void;
  confirmRename: () => void;
  cancelRename: () => void;
  startRename: (layout: LayoutEntry) => void;
  selectLayout: (layoutId: string) => void;
  requestDelete: (layout: LayoutEntry) => void;
  deletingLastLayout: boolean;
  isStarredLayout: boolean;
  handleContextMenuOpenChange: (open: boolean) => void;
  statusMap: Map<string, TerminalStatusInfo>;
  onMouseEnter: () => void;
  onJumpToTab: (layoutId: string, paneId: string, tabId: string) => void;
  t: TFunction<"panes">;
}) {
  const typeCounts = deriveLayoutTypeSummary(rootPane, layout.kind);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: layout.id,
    disabled: isEditing,
  });

  const style: React.CSSProperties = {
    ...layoutRowStyle(selected),
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  };

  if (isEditing) {
    return (
      <div
        ref={setNodeRef}
        className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm"
        style={style}
        onMouseEnter={onMouseEnter}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          {selected ? <Check className="h-3.5 w-3.5" /> : null}
        </span>
        <InlineRename
          value={editingName}
          onChange={setEditingName}
          onConfirm={confirmRename}
          onCancel={cancelRename}
          confirmOnBlur={false}
          confirmOnOutsidePointerDown
          className="h-6 min-w-0 flex-1 rounded px-1 text-xs outline-none"
          style={{
            background: "var(--app-content)",
            border: "1px solid var(--app-accent)",
            color: "var(--app-text-primary)",
          }}
        />
      </div>
    );
  }

  return (
    <ContextMenu onOpenChange={handleContextMenuOpenChange}>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          className="group flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-[var(--app-hover)]"
          style={style}
          onMouseEnter={onMouseEnter}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!isStarredLayout) {
              startRename(layout);
            }
          }}
        >
          <button
            ref={setActivatorNodeRef}
            type="button"
            aria-label={t("reorderLayout")}
            title={t("reorderLayout")}
            className="flex h-6 w-5 shrink-0 cursor-grab items-center justify-center rounded text-[var(--app-text-tertiary)] transition-colors hover:bg-[var(--app-hover)] active:cursor-grabbing"
            {...attributes}
            {...listeners}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              selectLayout(layout.id);
            }}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              {selected ? (
                <Check className="h-3.5 w-3.5" />
              ) : isStarredLayout ? (
                <Star className="h-3.5 w-3.5" fill="currentColor" style={{ color: "var(--app-accent)" }} />
              ) : null}
            </span>
            <span className="min-w-0 flex-1 truncate">{layout.name}</span>
            {isStarredLayout ? null : <LayoutWorkspaceBadge layout={layout} rootPane={rootPane} />}
            {isStarredLayout ? null : <LayoutStatusRow rootPane={rootPane} statusMap={statusMap} />}
          </button>
          {/* 类型计数桁自身是一组 button，必须放在选择按钮**外面**——嵌套 button
              是非法 HTML，React 会警告且点击行为不可预期。 */}
          {isStarredLayout ? null : (
            <LayoutTypeCounts
              summary={typeCounts}
              selected={selected}
              onJump={(paneId, tabId) => onJumpToTab(layout.id, paneId, tabId)}
            />
          )}
          {!isStarredLayout ? (
            <button
              type="button"
              aria-label={deletingLastLayout ? t("cannotDeleteLastLayout") : t("deleteLayout")}
              title={deletingLastLayout ? t("cannotDeleteLastLayout") : t("deleteLayout")}
              disabled={deletingLastLayout}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md opacity-0 transition-opacity hover:bg-[var(--app-hover)] focus:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
              onPointerDown={stopLayoutRowAction}
              onClick={(event) => {
                stopLayoutRowAction(event);
                requestDelete(layout);
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </ContextMenuTrigger>
      {!isStarredLayout ? (
        <ContextMenuContent className="z-[160] w-44">
          <ContextMenuItem onClick={() => startRename(layout)}>
            {t("renameLayout")}
          </ContextMenuItem>
          <LayoutWorkspaceMenuItems layout={layout} />
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            disabled={deletingLastLayout}
            onClick={() => requestDelete(layout)}
          >
            <Trash2 />
            {deletingLastLayout ? t("cannotDeleteLastLayout") : t("deleteLayout")}
          </ContextMenuItem>
        </ContextMenuContent>
      ) : null}
    </ContextMenu>
  );
}
