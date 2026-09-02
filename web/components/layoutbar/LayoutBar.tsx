import { useState } from "react";
import { Command } from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePanesStore, useTerminalStatusStore } from "@/stores";
import type { LayoutEntry } from "@/types";
import { useLayoutSelectorState, LAYOUT_BAR_TOGGLE_EVENT } from "./useLayoutSelectorState";
import { LayoutSelectorPanel } from "./LayoutSelectorPanel";
import LayoutDeleteDialog, { summarizeLayoutDelete, type DeleteSummary } from "./LayoutDeleteDialog";

export { LAYOUT_BAR_TOGGLE_EVENT };

export default function LayoutBar() {
  const { t } = useTranslation("panes");
  const layouts = usePanesStore((s) => s.layouts);
  const currentLayoutId = usePanesStore((s) => s.currentLayoutId);
  const liveRootPane = usePanesStore((s) => s.rootPane);
  const statusMap = useTerminalStatusStore((s) => s.statusMap);

  const {
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
  } = useLayoutSelectorState();

  const [deleteSummary, setDeleteSummary] = useState<DeleteSummary | null>(null);

  const active = open;

  function requestDelete(layout: LayoutEntry) {
    if (layout.kind === "starred") return;
    if (deletingLastLayout) return;
    closeSelector();
    setDeleteSummary(summarizeLayoutDelete(layout));
  }

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
        aria-pressed={panelPinned}
        className={`relative flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl transition-colors duration-[var(--dur-fast)] ${
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
        onClick={handleLayoutButtonClick}
      >
        <Command className="h-[14px] w-[14px]" />
        <span className="absolute -right-[4px] -top-[4px] flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-[var(--app-accent)] px-[3px] text-[9px] font-bold leading-none text-white ring-1 ring-[var(--app-activity-bar-bg)]">
          {layouts.length > 99 ? "99+" : layouts.length}
        </span>
      </button>

      {open && floatingPosition ? (
        <LayoutSelectorPanel
          floatingRef={floatingRef}
          floatingPosition={floatingPosition}
          panelPinned={panelPinned}
          layouts={layouts}
          currentLayoutId={currentLayoutId}
          liveRootPane={liveRootPane}
          statusMap={statusMap}
          editingId={editingId}
          editingName={editingName}
          setEditingName={setEditingName}
          deletingLastLayout={deletingLastLayout}
          sensors={sensors}
          openSelector={openSelector}
          scheduleClose={scheduleClose}
          handlePanelTitlePointerDown={handlePanelTitlePointerDown}
          handleTogglePanelPinned={handleTogglePanelPinned}
          handleCreateLayout={handleCreateLayout}
          handleContextMenuOpenChange={handleContextMenuOpenChange}
          handleLayoutDragStart={handleLayoutDragStart}
          handleLayoutDragEnd={handleLayoutDragEnd}
          handleLayoutDragCancel={handleLayoutDragCancel}
          confirmRename={confirmRename}
          cancelRename={cancelRename}
          startRename={startRename}
          selectLayout={selectLayout}
          requestDelete={requestDelete}
          t={t}
        />
      ) : null}

      <LayoutDeleteDialog
        summary={deleteSummary}
        onClose={() => setDeleteSummary(null)}
        t={t}
      />
    </div>
  );
}
