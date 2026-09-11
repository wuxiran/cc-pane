import { LayoutAutoFitButton } from "./LayoutAutoFit";
import { useCallback, useEffect, useRef, type RefObject, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from "react";
import { usePanelResize } from "@/hooks/usePanelResize";
import { usePanelPreferencesStore } from "@/stores/usePanelPreferencesStore";
import { setDragging } from "@/stores/splitDragState";
import { createPortal } from "react-dom";
import { LayoutPanelTop, Network, PanelTop, Pin, PinOff, Plus } from "lucide-react";
import { DndContext, closestCenter, type DragEndEvent, type SensorDescriptor, type SensorOptions } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useActivityBarStore, useCanvasDisplayStore, useLayoutUiStore, usePanesStore } from "@/stores";
import { isAgentChatLayout } from "@/stores/panes/agentChatLayout";
import type { TFunction } from "i18next";
import type { LayoutEntry, PaneNode, TerminalStatusInfo } from "@/types";
import { SortableLayoutRow } from "./SortableLayoutRow";
import type { FloatingPosition } from "./useFloatingPanelPosition";

// 布局列表纵向拉伸范围（与 usePanelPreferencesStore 的 layoutHeight clamp 同口径）
const LIST_HEIGHT_MIN = 160;
const LIST_HEIGHT_MAX = 800;

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
  const setSwitcherMode = useLayoutUiStore((s) => s.setSwitcherMode);
  const selectTab = usePanesStore((s) => s.selectTab);
  const setActivePane = usePanesStore((s) => s.setActivePane);
  const setAppViewMode = useActivityBarStore((s) => s.setAppViewMode);
  const canvasMode = useCanvasDisplayStore((s) => s.mode);
  const setCanvasMode = useCanvasDisplayStore((s) => s.setMode);
  const canvasVisible = canvasMode === "canvas";
  const width = usePanelPreferencesStore(s => s.layoutWidth);
  const setWidth = usePanelPreferencesStore(s => s.setLayoutWidth);
  const height = usePanelPreferencesStore(s => s.layoutHeight);
  const setHeight = usePanelPreferencesStore(s => s.setLayoutHeight);
  const resize = usePanelResize({ element: floatingRef, width, min: 288, max: 720, onCommit: setWidth });
  const listRef = useRef<HTMLDivElement | null>(null);

  // 纵向拉伸：列表默认由内容撑开（height=null）；拖下缘把手向上 = 设上限收缩
  // （出现滚动条），向下 = 放开上限直到内容高度/窗口底。顶边不动，下缘跟随光标。
  const startHeightResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const list = listRef.current, panel = floatingRef.current;
    if (!list || !panel) return;
    const start = event.clientY, original = list.offsetHeight;
    const content = list.scrollHeight;
    const chrome = panel.offsetHeight - list.offsetHeight;
    const panelTop = panel.getBoundingClientRect().top;
    const roomBottom = Math.max(LIST_HEIGHT_MIN, window.innerHeight - 12 - panelTop - chrome);
    const previousCursor = document.body.style.cursor, previousSelection = document.body.style.userSelect;
    let next = original, frame = 0;
    const preview = () => { list.style.maxHeight = next >= content ? "" : `${next}px`; };
    const move = (e: globalThis.PointerEvent) => {
      next = Math.round(Math.min(Math.min(content, roomBottom), Math.max(LIST_HEIGHT_MIN, original + (e.clientY - start))));
      cancelAnimationFrame(frame); frame = requestAnimationFrame(preview);
    };
    const finish = (cancelled: boolean) => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      document.body.style.cursor = previousCursor; document.body.style.userSelect = previousSelection;
      setDragging(false);
      if (cancelled) { list.style.maxHeight = height === null ? "" : `${height}px`; return; }
      preview(); setHeight(next >= content ? null : next);
    };
    const up = () => finish(false), cancel = () => finish(true);
    setDragging(true);
    document.body.style.cursor = "row-resize"; document.body.style.userSelect = "none";
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", cancel); window.addEventListener("blur", cancel);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, [height, setHeight, floatingRef]);
  useEffect(() => {
    floatingRef.current?.querySelector<HTMLElement>("[data-layout-selected=true]")?.scrollIntoView?.({ block: "nearest" });
  }, [currentLayoutId, floatingRef]);

  // 类型计数桁的跳转：先切到目标布局（selectLayout 已含切视图），再挪 active 指针。
  // 只改指针不动挂载——keep-alive 靠 display:none，卸载会重建终端。
  function jumpToTab(layoutId: string, paneId: string, tabId: string) {
    if (layoutId !== currentLayoutId) selectLayout(layoutId);
    setActivePane(paneId);
    selectTab(paneId, tabId);
  }

  return createPortal(
    <div
      ref={floatingRef}
      role="dialog"
      aria-label={t("layouts")}
      className={`fixed rounded-md border p-2 shadow-md outline-none ${panelPinned ? "z-[140]" : "z-[100]"}`}
      onMouseEnter={openSelector}
      onMouseLeave={scheduleClose}
      style={{
        width, maxWidth: "calc(100vw - 16px)",
        left: Math.max(8, Math.min(floatingPosition.left, window.innerWidth - width - 8)),
        top: floatingPosition.top,
        background: "var(--app-panel-bg)",
        borderColor: "var(--app-border)",
        color: "var(--app-text-primary)",
      }}
    >
      <div role="separator" aria-label={t("resizeLayoutList")} aria-orientation="vertical" tabIndex={0}
        aria-valuemin={288} aria-valuemax={720} aria-valuenow={width}
        className="absolute inset-y-0 -right-1 w-2 cursor-col-resize hover:bg-[var(--app-active-bg)]"
        onPointerDown={resize} onKeyDown={e => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); setWidth(width + (e.key === "ArrowRight" ? 10 : -10)); } }} />
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
          {layouts.find(l => l.id === currentLayoutId)?.kind === "starred" ? null : <LayoutAutoFitButton />}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t("layoutModeTopbar")}
                className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--app-hover)]"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => setSwitcherMode("topbar")}
              >
                <PanelTop className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{t("layoutModeTopbar")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={canvasVisible ? t("hideTerminalCanvas") : t("showTerminalCanvas")}
                aria-pressed={canvasVisible}
                data-testid="layout-selector-canvas"
                className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--app-hover)] ${
                  canvasVisible ? "text-[var(--app-accent)]" : ""
                }`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => {
                  setAppViewMode("panes");
                  setCanvasMode(canvasVisible ? "panel" : "canvas");
                }}
              >
                {canvasVisible
                  ? <LayoutPanelTop className="h-4 w-4" />
                  : <Network className="h-4 w-4" />}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {canvasVisible ? t("hideTerminalCanvas") : t("showTerminalCanvas")}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={panelPinned ? t("unpinLayoutPanel") : t("pinLayoutPanel")}
                aria-pressed={panelPinned}
                className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--app-hover)] ${
                  panelPinned ? "text-[var(--app-accent)]" : ""
                }`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={handleTogglePanelPinned}
              >
                {panelPinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
              </button>
            </TooltipTrigger>
            <TooltipContent>{panelPinned ? t("unpinLayoutPanel") : t("pinLayoutPanel")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t("newLayout")}
                className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--app-hover)]"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={handleCreateLayout}
              >
                <Plus className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{t("newLayout")}</TooltipContent>
          </Tooltip>
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
          <div ref={listRef} className="app-scrollbar flex flex-col gap-1 overflow-y-auto" style={{ maxHeight: height ?? undefined }}>
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
                  deletingLastLayout={layout.kind !== "starred" && !isAgentChatLayout(layout) && deletingLastLayout}
                  isStarredLayout={layout.kind === "starred"}
                  isReservedLayout={layout.kind === "starred" || isAgentChatLayout(layout)}
                  handleContextMenuOpenChange={handleContextMenuOpenChange}
                  statusMap={statusMap}
                  onMouseEnter={openSelector}
                  onJumpToTab={jumpToTab}
                  t={t}
                />
              );
            })}
          </div>
        </SortableContext>
      </DndContext>
      <div role="separator" aria-label={t("resizeLayoutListHeight")} aria-orientation="horizontal" tabIndex={0}
        aria-valuemin={LIST_HEIGHT_MIN} aria-valuemax={LIST_HEIGHT_MAX}
        aria-valuenow={height ?? undefined}
        className="absolute inset-x-0 -bottom-1 h-2 cursor-row-resize hover:bg-[var(--app-active-bg)]"
        onPointerDown={startHeightResize}
        onKeyDown={e => {
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
          e.preventDefault();
          const list = listRef.current;
          if (!list) return;
          if (e.key === "ArrowUp") {
            setHeight(Math.max(LIST_HEIGHT_MIN, list.offsetHeight - 10));
          } else {
            const next = list.offsetHeight + 10;
            setHeight(next >= list.scrollHeight ? null : next);
          }
        }} />
    </div>,
    document.body
  );
}
