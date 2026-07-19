import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, SyntheticEvent } from "react";
import { PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { useActivityBarStore, usePanesStore } from "@/stores";
import type { LayoutEntry } from "@/types";
import { useFloatingPanelPosition } from "./useFloatingPanelPosition";

export const LAYOUT_BAR_TOGGLE_EVENT = "cc-panes:toggle-layout-selector";

export function useLayoutSelectorState() {
  const layouts = usePanesStore((s) => s.layouts);
  const switchLayout = usePanesStore((s) => s.switchLayout);
  const createLayout = usePanesStore((s) => s.createLayout);
  const renameLayout = usePanesStore((s) => s.renameLayout);
  const reorderLayouts = usePanesStore((s) => s.reorderLayouts);
  const setAppViewMode = useActivityBarStore((s) => s.setAppViewMode);

  const {
    rootRef,
    floatingRef,
    floatingPosition,
    setFloatingPosition,
    clampFloatingPosition,
    updateFloatingPosition,
  } = useFloatingPanelPosition();

  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoveringRef = useRef(false);
  const draggingRef = useRef(false);
  const panelDraggingRef = useRef(false);
  const editingIdRef = useRef<string | null>(null);
  const contextMenuOpenRef = useRef(false);
  const panelPinnedRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [panelPinned, setPanelPinnedState] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const normalLayoutCount = layouts.filter((layout) => layout.kind !== "starred").length;
  const deletingLastLayout = normalLayoutCount <= 1;
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
  );

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

  function setPanelPinned(nextPinned: boolean) {
    panelPinnedRef.current = nextPinned;
    setPanelPinnedState(nextPinned);
  }

  function closeSelector() {
    clearCloseTimer();
    editingIdRef.current = null;
    contextMenuOpenRef.current = false;
    setPanelPinned(false);
    setOpen(false);
    setFloatingPosition(null);
    setEditingId(null);
    setEditingName("");
  }

  function openSelector() {
    hoveringRef.current = true;
    clearCloseTimer();
    if (!floatingPosition) {
      updateFloatingPosition();
    }
    setOpen(true);
  }

  function queueClose() {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      if (
        panelPinnedRef.current ||
        hoveringRef.current ||
        editingIdRef.current ||
        contextMenuOpenRef.current ||
        draggingRef.current ||
        panelDraggingRef.current
      ) {
        return;
      }
      closeSelector();
    }, 180);
  }

  function scheduleClose() {
    hoveringRef.current = false;
    if (panelPinnedRef.current) return;
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

  function handleLayoutButtonClick(event: SyntheticEvent) {
    event.preventDefault();
    hoveringRef.current = true;
    clearCloseTimer();

    if (open && panelPinnedRef.current) {
      closeSelector();
      return;
    }

    if (!floatingPosition) {
      updateFloatingPosition();
    }
    setPanelPinned(true);
    setOpen(true);
  }

  function handleTogglePanelPinned(event: SyntheticEvent) {
    event.preventDefault();
    event.stopPropagation();
    const nextPinned = !panelPinnedRef.current;
    setPanelPinned(nextPinned);
    setOpen(true);
    clearCloseTimer();
    if (!nextPinned && !hoveringRef.current) {
      queueClose();
    }
  }

  function handlePanelTitlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !floatingPosition) return;
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startY = event.clientY;
    const startPosition = floatingPosition;
    panelDraggingRef.current = true;
    clearCloseTimer();

    function handlePointerMove(moveEvent: PointerEvent) {
      moveEvent.preventDefault();
      setFloatingPosition(clampFloatingPosition({
        left: startPosition.left + moveEvent.clientX - startX,
        top: startPosition.top + moveEvent.clientY - startY,
      }));
    }

    function stopDragging() {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
      panelDraggingRef.current = false;
      if (!hoveringRef.current && !panelPinnedRef.current) {
        queueClose();
      }
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);
  }

  useEffect(() => {
    return () => clearCloseTimer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      const root = rootRef.current;
      const floating = floatingRef.current;
      const target = event.target;
      if (
        panelPinnedRef.current ||
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

    function handleViewportChange() {
      updateFloatingPosition({ preserve: panelPinnedRef.current });
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !editingIdRef.current && !contextMenuOpenRef.current) {
        closeSelector();
      }
    }

    updateFloatingPosition();
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  function selectLayout(layoutId: string) {
    setAppViewMode("panes");
    switchLayout(layoutId);
  }

  function handleCreateLayout() {
    setAppViewMode("panes");
    createLayout();
    setOpen(true);
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

  return {
    rootRef,
    floatingRef,
    floatingPosition,
    open,
    panelPinned,
    editingId,
    editingName,
    setEditingName,
    deletingLastLayout,
    sensors,
    startRename,
    closeSelector,
    openSelector,
    scheduleClose,
    handleContextMenuOpenChange,
    handleLayoutButtonClick,
    handleTogglePanelPinned,
    handlePanelTitlePointerDown,
    confirmRename,
    cancelRename,
    selectLayout,
    handleCreateLayout,
    handleLayoutDragStart,
    handleLayoutDragEnd,
    handleLayoutDragCancel,
  };
}
