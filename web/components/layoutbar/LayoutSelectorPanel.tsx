import type { RefObject, PointerEvent as ReactPointerEvent, SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { Pin, PinOff, Plus } from "lucide-react";
import { DndContext, closestCenter, type DragEndEvent, type SensorDescriptor, type SensorOptions } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { TFunction } from "i18next";
import type { LayoutEntry, PaneNode, TerminalStatusInfo } from "@/types";
import { SortableLayoutRow } from "./SortableLayoutRow";
import type { FloatingPosition } from "./useFloatingPanelPosition";

export function LayoutSelectorPanel({
  floatingRef,
  floatingPosition,
  panelPinned,
  layouts,
  currentLayoutId,
  liveRootPane,
  statusMap,
  editingId,
  editingName,
  setEditingName,
  deletingLastLayout,
  sensors,
  openSelector,
  scheduleClose,
  handlePanelTitlePointerDown,
  handleTogglePanelPinned,
  handleCreateLayout,
  handleContextMenuOpenChange,
  handleLayoutDragStart,
  handleLayoutDragEnd,
  handleLayoutDragCancel,
  confirmRename,
  cancelRename,
  startRename,
  selectLayout,
  requestDelete,
  t,
}: {
  floatingRef: RefObject<HTMLDivElement | null>;
  floatingPosition: FloatingPosition;
  panelPinned: boolean;
  layouts: LayoutEntry[];
  currentLayoutId: string | null;
  liveRootPane: PaneNode;
  statusMap: Map<string, TerminalStatusInfo>;
  editingId: string | null;
  editingName: string;
  setEditingName: (value: string) => void;
  deletingLastLayout: boolean;
  sensors: SensorDescriptor<SensorOptions>[];
  openSelector: () => void;
  scheduleClose: () => void;
  handlePanelTitlePointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  handleTogglePanelPinned: (event: SyntheticEvent) => void;
  handleCreateLayout: () => void;
  handleContextMenuOpenChange: (open: boolean) => void;
  handleLayoutDragStart: () => void;
  handleLayoutDragEnd: (event: DragEndEvent) => void;
  handleLayoutDragCancel: () => void;
  confirmRename: () => void;
  cancelRename: () => void;
  startRename: (layout: LayoutEntry) => void;
  selectLayout: (layoutId: string) => void;
  requestDelete: (layout: LayoutEntry) => void;
  t: TFunction<"panes">;
}) {
  return createPortal(
    <div
      ref={floatingRef}
      role="dialog"
      aria-label={t("layouts")}
      className={`fixed w-64 rounded-md border p-2 shadow-md outline-none ${panelPinned ? "z-[140]" : "z-[100]"}`}
      onMouseEnter={openSelector}
      onMouseLeave={scheduleClose}
      style={{
        left: floatingPosition.left,
        top: floatingPosition.top,
        background: "var(--app-panel-bg)",
        borderColor: "var(--app-border)",
        color: "var(--app-text-primary)",
      }}
    >
      <div className="mb-2 flex items-center justify-between px-1">
        <div
          className="flex min-w-0 flex-1 cursor-move select-none items-center self-stretch pr-2"
          onPointerDown={handlePanelTitlePointerDown}
        >
          <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--app-text-tertiary)" }}>
            {t("layouts")}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label={panelPinned ? t("unpinLayoutPanel") : t("pinLayoutPanel")}
            aria-pressed={panelPinned}
            className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--app-hover)] ${
              panelPinned ? "text-[var(--app-accent)]" : ""
            }`}
            title={panelPinned ? t("unpinLayoutPanel") : t("pinLayoutPanel")}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={handleTogglePanelPinned}
          >
            {panelPinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
          </button>
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--app-hover)]"
            title={t("newLayout")}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={handleCreateLayout}
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleLayoutDragStart}
        onDragEnd={handleLayoutDragEnd}
        onDragCancel={handleLayoutDragCancel}
      >
        <SortableContext items={layouts.map((layout) => layout.id)} strategy={verticalListSortingStrategy}>
          <div className="flex max-h-[320px] flex-col gap-1 overflow-y-auto">
            {layouts.map((layout) => {
              const selected = layout.id === currentLayoutId;
              return (
                <SortableLayoutRow
                  key={layout.id}
                  layout={layout}
                  rootPane={selected ? liveRootPane : layout.rootPane}
                  selected={selected}
                  isEditing={editingId === layout.id}
                  editingName={editingName}
                  setEditingName={setEditingName}
                  confirmRename={confirmRename}
                  cancelRename={cancelRename}
                  startRename={startRename}
                  selectLayout={selectLayout}
                  requestDelete={requestDelete}
                  deletingLastLayout={layout.kind !== "starred" && deletingLastLayout}
                  isStarredLayout={layout.kind === "starred"}
                  handleContextMenuOpenChange={handleContextMenuOpenChange}
                  statusMap={statusMap}
                  onMouseEnter={openSelector}
                  t={t}
                />
              );
            })}
          </div>
        </SortableContext>
      </DndContext>
    </div>,
    document.body
  );
}
