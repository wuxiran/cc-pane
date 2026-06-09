import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Command, Plus, Trash2 } from "lucide-react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useActivityBarStore, usePanesStore } from "@/stores";
import { terminalService, getPoppedTabs, markTabReclaimed as popupMarkReclaimed } from "@/services";
import { handleErrorSilent } from "@/utils";
import { collectTerminalLeaves, collectTerminalSessionIdsFromTree, collectTerminalTabs } from "@/lib/paneSessions";
import InlineRename from "@/components/ui/InlineRename";
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { LayoutEntry } from "@/types";

interface DeleteSummary {
  layout: LayoutEntry;
  sessionIds: string[];
  poppedTabIds: string[];
  sshCount: number;
  restoringCount: number;
}

function summarizeLayoutDelete(layout: LayoutEntry): DeleteSummary {
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

export default function LayoutBar() {
  const { t } = useTranslation("panes");
  const layouts = usePanesStore((s) => s.layouts);
  const currentLayoutId = usePanesStore((s) => s.currentLayoutId);
  const switchLayout = usePanesStore((s) => s.switchLayout);
  const createLayout = usePanesStore((s) => s.createLayout);
  const renameLayout = usePanesStore((s) => s.renameLayout);
  const deleteLayout = usePanesStore((s) => s.deleteLayout);
  const appViewMode = useActivityBarStore((s) => s.appViewMode);
  const setAppViewMode = useActivityBarStore((s) => s.setAppViewMode);

  const rootRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoveringRef = useRef(false);
  const editingIdRef = useRef<string | null>(null);
  const contextMenuOpenRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [deleteSummary, setDeleteSummary] = useState<DeleteSummary | null>(null);

  const deletingLastLayout = layouts.length <= 1;
  const active = appViewMode === "home" || open;
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

  function closeSelector() {
    clearCloseTimer();
    editingIdRef.current = null;
    contextMenuOpenRef.current = false;
    setOpen(false);
    setEditingId(null);
    setEditingName("");
  }

  function openSelector() {
    hoveringRef.current = true;
    clearCloseTimer();
    setOpen(true);
  }

  function queueClose() {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      if (hoveringRef.current || editingIdRef.current || contextMenuOpenRef.current) return;
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
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      const root = rootRef.current;
      const target = event.target;
      if (!root || !(target instanceof Node) || root.contains(target) || contextMenuOpenRef.current) {
        return;
      }
      closeSelector();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !editingIdRef.current && !contextMenuOpenRef.current) {
        closeSelector();
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
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
    if (deletingLastLayout) return;
    editingIdRef.current = null;
    contextMenuOpenRef.current = false;
    closeSelector();
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

  function rowStyle(selected: boolean): React.CSSProperties {
    return {
      background: selected ? "var(--app-active-bg)" : "transparent",
      color: selected ? "var(--app-text-primary)" : "var(--app-text-secondary)",
    };
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

  return (
    <div
      ref={rootRef}
      className="relative flex items-center justify-center pb-2 pt-0.5"
      onMouseEnter={openSelector}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        aria-label={t("layoutSwitcher")}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`relative flex h-8 w-8 cursor-pointer items-center justify-center rounded-xl transition-all duration-200 hover:scale-105 ${
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

      {open && (
        <div
          role="dialog"
          aria-label={t("layouts")}
          className="absolute left-[calc(100%+10px)] top-0 z-50 w-64 rounded-md border p-2 shadow-md outline-none"
          onMouseEnter={openSelector}
          onMouseLeave={scheduleClose}
          style={{
            background: "var(--app-panel-bg)",
            borderColor: "var(--app-border)",
            color: "var(--app-text-primary)",
          }}
        >
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--app-text-tertiary)" }}>
              {t("layouts")}
            </span>
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--app-hover)]"
              title={t("newLayout")}
              onClick={handleCreateLayout}
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>

          <div className="flex max-h-[320px] flex-col gap-1 overflow-y-auto">
            {layouts.map((layout) => {
              const selected = layout.id === currentLayoutId;
              if (editingId === layout.id) {
                return (
                  <div
                    key={layout.id}
                    className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm"
                    style={rowStyle(selected)}
                    onMouseEnter={openSelector}
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
                <ContextMenu key={layout.id} onOpenChange={handleContextMenuOpenChange}>
                  <ContextMenuTrigger asChild>
                    <div
                      role="button"
                      tabIndex={0}
                      className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-[var(--app-hover)]"
                      style={rowStyle(selected)}
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
                        startRename(layout);
                      }}
                    >
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                        {selected ? <Check className="h-3.5 w-3.5" /> : null}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{layout.name}</span>
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-44">
                    <ContextMenuItem onClick={() => startRename(layout)}>
                      {t("renameLayout")}
                    </ContextMenuItem>
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
            })}
          </div>
        </div>
      )}

      <Dialog open={deleteSummary !== null} onOpenChange={(open) => !open && setDeleteSummary(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("deleteLayoutTitle", { name: deleteSummary?.layout.name ?? "" })}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm" style={{ color: "var(--app-text-secondary)" }}>
            <p>{t("deleteLayoutDescription")}</p>
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
