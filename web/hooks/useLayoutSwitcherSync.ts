import { useEffect } from "react";
import { emitTo } from "@tauri-apps/api/event";
import { usePanesStore } from "@/stores";
import { collectPanels } from "@/lib/paneTree";
import { collectTerminalLeaves } from "@/lib/paneSessions";
import { layoutSwitcherService, type LayoutSwitcherSnapshot } from "@/services/layoutSwitcherService";
import { isTauriRuntime, listenIfTauri } from "@/services/runtime";
import type { PaneNode, Panel } from "@/types";

const STATE_EVENT = "layout-switcher:state";
const REQUEST_STATE_EVENT = "layout-switcher:request-state";
const SWITCH_EVENT = "layout-switcher:switch";

function collectPanelSessionIds(panel: Panel): string[] {
  return panel.tabs.flatMap((tab) => {
    if (tab.contentType !== "terminal") return [];
    if (!tab.terminalRootPane) return tab.sessionId ? [tab.sessionId] : [];
    return collectTerminalLeaves(tab.terminalRootPane)
      .map((leaf) => leaf.sessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId));
  });
}

function paneSessionIds(rootPane: PaneNode): string[][] {
  return collectPanels(rootPane).map(collectPanelSessionIds);
}

function buildSnapshot(): LayoutSwitcherSnapshot {
  const state = usePanesStore.getState();
  return {
    currentLayoutId: state.currentLayoutId,
    layouts: state.layouts.map((layout) => ({
      id: layout.id,
      name: layout.name,
      kind: layout.kind,
      paneSessionIds: layout.kind === "starred"
        ? []
        : paneSessionIds(layout.id === state.currentLayoutId ? state.rootPane : layout.rootPane),
    })),
  };
}

function emitSnapshot() {
  const snapshot = buildSnapshot();
  void layoutSwitcherService.saveSnapshot(snapshot).catch(() => {});
  void emitTo("layout-switcher", STATE_EVENT, snapshot).catch(() => {});
}

export default function useLayoutSwitcherSync() {
  useEffect(() => {
    if (!isTauriRuntime()) return;

    let disposed = false;
    let unlistenRequest: (() => void) | null = null;
    let unlistenSwitch: (() => void) | null = null;

    const unsubscribeStore = usePanesStore.subscribe(() => {
      emitSnapshot();
    });

    listenIfTauri(REQUEST_STATE_EVENT, () => {
      emitSnapshot();
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        unlistenRequest = unlisten;
      }
    }).catch(() => {});

    listenIfTauri<{ layoutId?: string }>(SWITCH_EVENT, (event) => {
      const layoutId = event.payload?.layoutId;
      if (!layoutId) return;
      usePanesStore.getState().switchLayout(layoutId);
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        unlistenSwitch = unlisten;
      }
    }).catch(() => {});

    layoutSwitcherService.getState()
      .then((state) => {
        if (!disposed && state.pinned) {
          void layoutSwitcherService.saveState({ ...state, pinned: false }).catch(() => {});
        }
      })
      .catch(() => {});

    emitSnapshot();

    return () => {
      disposed = true;
      unsubscribeStore();
      unlistenRequest?.();
      unlistenSwitch?.();
    };
  }, []);
}
