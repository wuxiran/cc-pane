// 全局快捷键动作注册（从 App.tsx 原样搬出，勿在此做行为改动）。
// 所有 handler 通过 getState() 获取最新值，无需依赖。
import { useEffect } from "react";
import { toast } from "sonner";
import {
  usePanesStore,
  useFullscreenStore,
  useShortcutsStore,
  useMiniModeStore,
  useDialogStore,
  useActivityBarStore,
  useVoiceInputStore,
} from "@/stores";
import { terminalService } from "@/services";
import { LAYOUT_BAR_TOGGLE_EVENT } from "@/components/LayoutBar";
import { findPaneFocusTarget, readPaneFocusRects, type PaneFocusDirection } from "@/utils/paneFocus";
import i18n from "@/i18n";
import type { TerminalPaneLeaf, TerminalPaneNode } from "@/types";

function findTerminalLeaf(node: TerminalPaneNode, paneId: string): TerminalPaneLeaf | null {
  if (node.type === "leaf") return node.id === paneId ? node : null;
  for (const child of node.children) {
    const found = findTerminalLeaf(child, paneId);
    if (found) return found;
  }
  return null;
}

function firstTerminalLeaf(node: TerminalPaneNode): TerminalPaneLeaf | null {
  if (node.type === "leaf") return node;
  for (const child of node.children) {
    const found = firstTerminalLeaf(child);
    if (found) return found;
  }
  return null;
}

export function useShortcutRegistrations(): void {
  useEffect(() => {
    const register = useShortcutsStore.getState().registerAction;
    const focusPane = (direction: PaneFocusDirection) => {
      const s = usePanesStore.getState();
      const paneOrder = s.allPanels().map((pane) => pane.id);
      const targetPaneId = findPaneFocusTarget({
        activePaneId: s.activePaneId,
        direction,
        paneOrder,
        paneRects: readPaneFocusRects(),
      });
      if (targetPaneId && targetPaneId !== s.activePaneId) {
        s.setActivePane(targetPaneId);
      }
    };
    const requestVoiceInput = () => {
      const s = usePanesStore.getState();
      const pane = s.findPaneById(s.activePaneId);
      if (!pane || pane.type !== "panel") {
        toast.error(i18n.t("voiceUnavailable", { ns: "panes" }));
        return;
      }
      const tab = pane.tabs.find((item) => item.id === pane.activeTabId);
      if (!tab || tab.contentType !== "terminal" || !tab.terminalRootPane) {
        toast.error(i18n.t("voiceUnavailable", { ns: "panes" }));
        return;
      }
      const activeLeaf = tab.activeTerminalPaneId
        ? findTerminalLeaf(tab.terminalRootPane, tab.activeTerminalPaneId)
        : null;
      const leaf = activeLeaf ?? firstTerminalLeaf(tab.terminalRootPane);
      if (!leaf?.sessionId) {
        toast.error(i18n.t("voiceNoSession", { ns: "panes" }));
        return;
      }
      if (leaf.disconnected || leaf.restoring) {
        toast.error(i18n.t("voiceUnavailable", { ns: "panes" }));
        return;
      }
      useVoiceInputStore.getState().requestToggle(`${leaf.id}:${leaf.sessionId}`);
    };
    register({
      id: "toggle-sidebar",
      label: i18n.t("toggle-sidebar", { ns: "shortcuts" }),
      handler: () => useActivityBarStore.getState().toggleSidebar(),
    });
    register({
      id: "toggle-fullscreen",
      label: i18n.t("toggle-fullscreen", { ns: "shortcuts" }),
      handler: () => useFullscreenStore.getState().toggleFullscreen(),
    });
    register({
      id: "new-tab",
      label: i18n.t("new-tab", { ns: "shortcuts" }),
      handler: () => {
        const s = usePanesStore.getState();
        if (s.activePaneId) s.addTab(s.activePaneId, { projectId: "", projectPath: "" });
      },
    });
    register({
      id: "close-tab",
      label: i18n.t("close-tab", { ns: "shortcuts" }),
      handler: () => {
        const s = usePanesStore.getState();
        if (!s.activePaneId) return;
        const panel = s.findPaneById(s.activePaneId);
        if (panel && panel.type === "panel" && panel.activeTabId) {
          const tab = panel.tabs.find((t) => t.id === panel.activeTabId);
          if (tab?.sessionId) {
            terminalService.killSession(tab.sessionId).catch(console.error);
          }
          s.closeTab(s.activePaneId, panel.activeTabId);
        }
      },
    });
    register({
      id: "settings",
      label: i18n.t("settings", { ns: "shortcuts" }),
      handler: () => useDialogStore.getState().openSettings(),
    });
    register({
      id: "toggle-layouts",
      label: i18n.t("toggle-layouts", { ns: "shortcuts" }),
      handler: () => window.dispatchEvent(new Event(LAYOUT_BAR_TOGGLE_EVENT)),
    });
    register({
      id: "split-right",
      label: i18n.t("split-right", { ns: "shortcuts" }),
      handler: () => {
        const s = usePanesStore.getState();
        if (s.activePaneId) s.splitRight(s.activePaneId);
      },
    });
    register({
      id: "split-down",
      label: i18n.t("split-down", { ns: "shortcuts" }),
      handler: () => {
        const s = usePanesStore.getState();
        if (s.activePaneId) s.splitDown(s.activePaneId);
      },
    });
    register({
      id: "focus-pane-left",
      label: i18n.t("focus-pane-left", { ns: "shortcuts" }),
      handler: () => focusPane("left"),
    });
    register({
      id: "focus-pane-right",
      label: i18n.t("focus-pane-right", { ns: "shortcuts" }),
      handler: () => focusPane("right"),
    });
    register({
      id: "focus-pane-up",
      label: i18n.t("focus-pane-up", { ns: "shortcuts" }),
      handler: () => focusPane("up"),
    });
    register({
      id: "focus-pane-down",
      label: i18n.t("focus-pane-down", { ns: "shortcuts" }),
      handler: () => focusPane("down"),
    });
    register({
      id: "next-tab",
      label: i18n.t("next-tab", { ns: "shortcuts" }),
      handler: () => {
        const s = usePanesStore.getState();
        if (s.activePaneId) s.nextTab(s.activePaneId);
      },
    });
    register({
      id: "prev-tab",
      label: i18n.t("prev-tab", { ns: "shortcuts" }),
      handler: () => {
        const s = usePanesStore.getState();
        if (s.activePaneId) s.prevTab(s.activePaneId);
      },
    });
    register({
      id: "toggle-mini-mode",
      label: i18n.t("toggle-mini-mode", { ns: "shortcuts" }),
      handler: () => useMiniModeStore.getState().toggleMiniMode(),
    });
    register({
      id: "voice-input",
      label: i18n.t("voice-input", { ns: "shortcuts" }),
      handler: requestVoiceInput,
    });
    register({
      id: "show-explorer",
      label: "Explorer",
      handler: () => useActivityBarStore.getState().toggleView("explorer"),
    });
    register({
      id: "show-sessions",
      label: "Sessions",
      handler: () => useActivityBarStore.getState().toggleView("sessions"),
    });
    register({
      id: "show-files",
      label: "Files",
      handler: () => useActivityBarStore.getState().toggleFilesMode(),
    });
    for (let i = 1; i <= 9; i++) {
      register({
        id: `switch-tab-${i}`,
        label: i18n.t("switch-tab", { ns: "shortcuts", index: i }),
        handler: () => {
          const s = usePanesStore.getState();
          if (s.activePaneId) s.switchToTab(s.activePaneId, i - 1);
        },
      });
    }
    for (let i = 1; i <= 9; i++) {
      register({
        id: `switch-layout-${i}`,
        label: i18n.t("switch-layout", { ns: "shortcuts", index: i }),
        handler: () => usePanesStore.getState().switchLayoutByIndex(i - 1),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
