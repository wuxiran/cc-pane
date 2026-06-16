import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SyntheticEvent } from "react";
import { Check, Command, Pin, Plus, Star, Trash2 } from "lucide-react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { toast } from "sonner";
import { useActivityBarStore, usePanesStore, useTerminalStatusStore } from "@/stores";
import { terminalService, getPoppedTabs, markTabReclaimed as popupMarkReclaimed, layoutSwitcherService } from "@/services";
import { handleErrorSilent } from "@/utils";
import { aggregatePaneStatus } from "@/utils/layoutStatus";
import { collectTerminalLeaves, collectTerminalSessionIdsFromTree, collectTerminalTabs } from "@/lib/paneSessions";
import InlineRename from "@/components/ui/InlineRename";
import StatusIndicator from "@/components/StatusIndicator";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { collectPanels } from "@/stores/paneTreeHelpers";
import type { LayoutEntry, PaneNode, TerminalStatusInfo } from "@/types";

export const LAYOUT_BAR_TOGGLE_EVENT = "cc-panes:toggle-layout-selector";

interface DeleteSummary {
  layout: LayoutEntry;
  sessionIds: string[];
  poppedTabIds: string[];
  sshCount: number;
  restoringCount: number;
}

interface FloatingPosition {
  left: number;
  top: number;
}

const MAX_LAYOUT_STATUS_DOTS = 6;

function layoutRowStyle(selected: boolean): React.CSSProperties {
  return {
    background: selected ? "var(--app-active-bg)" : "transparent",
    color: selected ? "var(--app-text-primary)" : "var(--app-text-secondary)",
  };
}

function summarizeLayoutDelete(layout: LayoutEntry): DeleteSummary {
  if (layout.kind === "starred") {
    return {
      layout,
      sessionIds: [],
      poppedTabIds: [],
      sshCount: 0,
      restoringCount: 0,
    };
  }
  const tabs = collectTerminalTabs(layout.rootPane);
  const poppedTabs = getPoppedTabs();
  const poppedTabIds = tabs
    .map((tab) => tab.id)
    .filter((tabId) => poppedTabs.has(tabId));
  let sshCount = 0;
  let restoringCount = 0;

  for (const tab of tabs) {
    if (tab.ssh) sshCount += 1;
    if (tab.restoring) restoringCount += 1;
    if (tab.terminalRootPane) {
      for (const leaf of collectTerminalLeaves(tab.terminalRootPane)) {
        if (leaf.ssh) sshCount += 1;
        if (leaf.restoring) restoringCount += 1;
      }
    }
  }

  return {
    layout,
    sessionIds: collectTerminalSessionIdsFromTree(layout.rootPane),
    poppedTabIds,
    sshCount,
    restoringCount,
  };
}

async function closePoppedWindows(tabIds: string[]) {
  const poppedTabs = getPoppedTabs();
  await Promise.all(tabIds.map(async (tabId) => {
    const label = poppedTabs.get(tabId);
    if (!label) return;
    try {
      const win = await WebviewWindow.getByLabel(label);
      await win?.close();
      popupMarkReclaimed(tabId);
    } catch (error) {
      handleErrorSilent(error, "close popup window");
    }
  }));
}

function stopLayoutRowAction(event: SyntheticEvent) {
  event.preventDefault();
  event.stopPropagation();
}

function LayoutStatusDots({
  rootPane,
  statusMap,
}: {
  rootPane: PaneNode;
  statusMap: Map<string, TerminalStatusInfo>;
}) {
  const paneStatuses = useMemo(
    () => collectPanels(rootPane).map((panel) =>
      aggregatePaneStatus(
        panel.tabs.map((tab) => (tab.sessionId ? statusMap.get(tab.sessionId)?.status ?? null : null)),
      ),
    ),
    [rootPane, statusMap],
  );
  const visibleStatuses = paneStatuses.slice(0, MAX_LAYOUT_STATUS_DOTS);
  const overflow = paneStatuses.length - visibleStatuses.length;

  return (
    <span className="flex shrink-0 items-center gap-[3px]">
      {visibleStatuses.map((status, index) => (
        status ? (
          <StatusIndicator key={index} status={status} size={6} />
        ) : (
          <span
            key={index}
            className="inline-block h-[6px] w-[6px] shrink-0 rounded-full border"
            style={{ borderColor: "var(--app-border)" }}
          />
        )
      ))}
      {overflow > 0 ? (
        <span className="text-[9px] leading-none" style={{ color: "var(--app-text-tertiary)" }}>
          +{overflow}
        </span>
      ) : null}
    </span>
  );
}

function SortableLayoutRow({
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
  t: TFunction<"panes">;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
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
          {...attributes}
          {...listeners}
          onMouseEnter={onMouseEnter}
          onClick={() => {
            selectLayout(layout.id);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              selectLayout(layout.id);
            }
          }}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!isStarredLayout) {
              startRename(layout);
            }
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
          {isStarredLayout ? null : <LayoutStatusDots rootPane={rootPane} statusMap={statusMap} />}
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
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="z-[120] w-44">
        {!isStarredLayout ? (
          <ContextMenuItem onClick={() => startRename(layout)}>
            {t("renameLayout")}
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem
          variant="destructive"
          disabled={deletingLastLayout}
          onClick={() => requestDelete(layout)}
        >
          <Trash2 />
          {deletingLastLayout ? t("cannotDeleteLastLayout") : t("deleteLayout")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export default function LayoutBar() {
  const { t } = useTranslation("panes");
  const layouts = usePanesStore((s) => s.layouts);
  const currentLayoutId = usePanesStore((s) => s.currentLayoutId);
  const switchLayout = usePanesStore((s) => s.switchLayout);
  const createLayout = usePanesStore((s) => s.createLayout);
  const renameLayout = usePanesStore((s) => s.renameLayout);
  const deleteLayout = usePanesStore((s) => s.deleteLayout);
  const reorderLayouts = usePanesStore((s) => s.reorderLayouts);
  const liveRootPane = usePanesStore((s) => s.rootPane);
  const statusMap = useTerminalStatusStore((s) => s.statusMap);
  const setAppViewMode = useActivityBarStore((s) => s.setAppViewMode);

  const rootRef = useRef<HTMLDivElement>(null);
  const floatingRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoveringRef = useRef(false);
  const draggingRef = useRef(false);
  const editingIdRef = useRef<string | null>(null);
  const contextMenuOpenRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [floatingPosition, setFloatingPosition] = useState<FloatingPosition | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [deleteSummary, setDeleteSummary] = useState<DeleteSummary | null>(null);

  const normalLayoutCount = layouts.filter((layout) => layout.kind !== "starred").length;
  const deletingLastLayout = normalLayoutCount <= 1;
  const active = open;
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
  );
  const summaryItems = useMemo(() => {
    if (!deleteSummary) return [];
    return [
      t("layoutDeleteActiveTerminals", { count: deleteSummary.sessionIds.length }),
      t("layoutDeletePoppedWindows", { count: deleteSummary.poppedTabIds.length }),
      t("layoutDeleteSshRestoring", {
        ssh: deleteSummary.sshCount,
        restoring: deleteSummary.restoringCount,
      }),
    ];
  }, [deleteSummary, t]);

  function startRename(layout: LayoutEntry) {
    if (layout.kind === "starred") return;
    clearCloseTimer();
    editingIdRef.current = layout.id;
    setEditingId(layout.id);
    setEditingName(layout.name);
    setOpen(true);
  }

  function clearCloseTimer() {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }

  function updateFloatingPosition() {
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const left = Math.min(rect.right + 10, Math.max(8, window.innerWidth - 264 - 8));
    const top = Math.min(rect.top, Math.max(8, window.innerHeight - 360 - 8));
    setFloatingPosition({ left, top: Math.max(8, top) });
  }

  function closeSelector() {
    clearCloseTimer();
    editingIdRef.current = null;
    contextMenuOpenRef.current = false;
    setOpen(false);
    setFloatingPosition(null);
    setEditingId(null);
    setEditingName("");
  }

  function openSelector() {
    hoveringRef.current = true;
    clearCloseTimer();
    updateFloatingPosition();
    setOpen(true);
  }

  function queueClose() {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      if (
        hoveringRef.current ||
        editingIdRef.current ||
        contextMenuOpenRef.current ||
        draggingRef.current
      ) {
        return;
      }
      closeSelector();
    }, 180);
  }

  function scheduleClose() {
    hoveringRef.current = false;
    queueClose();
  }

  function handleContextMenuOpenChange(nextOpen: boolean) {
    contextMenuOpenRef.current = nextOpen;
    if (nextOpen) {
      clearCloseTimer();
      setOpen(true);
      return;
    }
    queueClose();
  }

  useEffect(() => {
    return () => clearCloseTimer();
  }, []);

  useEffect(() => {
    function handleToggleSelector() {
      if (open) {
        closeSelector();
        return;
      }
      openSelector();
    }

    window.addEventListener(LAYOUT_BAR_TOGGLE_EVENT, handleToggleSelector);
    return () => {
      window.removeEventListener(LAYOUT_BAR_TOGGLE_EVENT, handleToggleSelector);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      const root = rootRef.current;
      const floating = floatingRef.current;
      const target = event.target;
      if (
        !root ||
        !(target instanceof Node) ||
        root.contains(target) ||
        floating?.contains(target) ||
        contextMenuOpenRef.current
      ) {
        return;
      }
      closeSelector();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !editingIdRef.current && !contextMenuOpenRef.current) {
        closeSelector();
      }
    }

    updateFloatingPosition();
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", updateFloatingPosition);
    window.addEventListener("scroll", updateFloatingPosition, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", updateFloatingPosition);
      window.removeEventListener("scroll", updateFloatingPosition, true);
    };
  }, [open]);

  function confirmRename() {
    if (editingId && editingName.trim()) {
      renameLayout(editingId, editingName.trim());
    }
    editingIdRef.current = null;
    setEditingId(null);
    setEditingName("");
    if (!hoveringRef.current) queueClose();
  }

  function cancelRename() {
    editingIdRef.current = null;
    setEditingId(null);
    setEditingName("");
    if (!hoveringRef.current) queueClose();
  }

  function requestDelete(layout: LayoutEntry) {
    if (layout.kind !== "starred" && deletingLastLayout) return;
    editingIdRef.current = null;
    contextMenuOpenRef.current = false;
    closeSelector();
    if (layout.kind === "starred") {
      deleteLayout(layout.id);
      toast.success(t("layoutDeleted", { name: layout.name }));
      return;
    }
    setDeleteSummary(summarizeLayoutDelete(layout));
  }

  function selectLayout(layoutId: string) {
    setAppViewMode("panes");
    switchLayout(layoutId);
  }

  function handleCreateLayout() {
    setAppViewMode("panes");
    createLayout();
    setOpen(true);
  }

  async function handlePinLayoutPanel() {
    try {
      await layoutSwitcherService.open();
      const state = await layoutSwitcherService.getState().catch(() => ({
        windowX: null,
        windowY: null,
        pinned: false,
      }));
      await layoutSwitcherService.saveState({ ...state, pinned: true });
      closeSelector();
    } catch (error) {
      handleErrorSilent(error, "pin layout panel");
    }
  }

  function handleLayoutDragStart() {
    draggingRef.current = true;
    clearCloseTimer();
  }

  function handleLayoutDragEnd(event: DragEndEvent) {
    draggingRef.current = false;
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const fromIndex = layouts.findIndex((layout) => layout.id === active.id);
      const toIndex = layouts.findIndex((layout) => layout.id === over.id);
      if (fromIndex !== -1 && toIndex !== -1) {
        reorderLayouts(fromIndex, toIndex);
      }
    }
    queueClose();
  }

  function handleLayoutDragCancel() {
    draggingRef.current = false;
    queueClose();
  }

  async function confirmDelete() {
    if (!deleteSummary) return;
    const { layout, sessionIds, poppedTabIds } = deleteSummary;
    try {
      for (const sessionId of sessionIds) {
        terminalService.detachOutput(sessionId);
        terminalService.detachExit(sessionId);
      }
      await Promise.all(sessionIds.map((sessionId) =>
        terminalService.killSession(sessionId).catch((error) => {
          handleErrorSilent(error, "kill layout session");
        })
      ));
      await closePoppedWindows(poppedTabIds);
      deleteLayout(layout.id);
      toast.success(t("layoutDeleted", { name: layout.name }));
    } finally {
      setDeleteSummary(null);
    }
  }

  const selectorPanel = open && floatingPosition
    ? createPortal(
      <div
        ref={floatingRef}
        role="dialog"
        aria-label={t("layouts")}
        className="fixed z-[100] w-64 rounded-md border p-2 shadow-md outline-none"
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
          <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--app-text-tertiary)" }}>
            {t("layouts")}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--app-hover)]"
              title={t("pinLayoutPanel")}
              onClick={() => void handlePinLayoutPanel()}
            >
              <Pin className="h-4 w-4" />
            </button>
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--app-hover)]"
              title={t("newLayout")}
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
    )
    : null;

  return (
    <div
      ref={rootRef}
      className="relative flex h-10 w-full items-center justify-center"
      onMouseEnter={openSelector}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        aria-label={t("layoutSwitcher")}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`relative flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl transition-all duration-200 ${
          active
            ? "text-[var(--primary-foreground)]"
            : "text-[var(--app-accent)] hover:bg-[var(--app-activity-item-hover)]"
        }`}
        style={{
          background: active ? "var(--app-accent)" : "var(--app-activity-bar-bg)",
          border: `1px solid ${active ? "var(--app-accent)" : "var(--app-activity-border)"}`,
          boxShadow: active
            ? "0 2px 8px color-mix(in srgb, var(--app-accent) 40%, transparent)"
            : "none",
        }}
        onClick={(event) => {
          event.preventDefault();
          openSelector();
        }}
      >
        <Command className="h-[14px] w-[14px]" />
        <span className="absolute -right-[4px] -top-[4px] flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-[var(--app-accent)] px-[3px] text-[9px] font-bold leading-none text-white ring-1 ring-[var(--app-activity-bar-bg)]">
          {layouts.length > 99 ? "99+" : layouts.length}
        </span>
      </button>

      {selectorPanel}

      <Dialog open={deleteSummary !== null} onOpenChange={(open) => !open && setDeleteSummary(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("deleteLayoutTitle", { name: deleteSummary?.layout.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("deleteLayoutDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm" style={{ color: "var(--app-text-secondary)" }}>
            <ul className="space-y-1 rounded-md border p-3" style={{ borderColor: "var(--app-border)" }}>
              {summaryItems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDeleteSummary(null)}>
              {t("cancel", { ns: "common" })}
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              {t("confirmDeleteLayout")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
