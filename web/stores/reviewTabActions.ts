import i18n from "@/i18n";
import { collectPanels, findPane } from "@/lib/paneTree";
import { createTabOfType } from "@/lib/tabLifecycle/tabFactory";
import { useActivityBarStore } from "./useActivityBarStore";
import { resolveLayoutWriteTarget } from "./paneLayoutHelpers";
import type { PanesDraft, PanesState } from "./panesStoreTypes";

export interface OpenReviewTabOptions {
  paneId?: string;
  layoutId?: string;
  checkpointChatId?: string;
  cliSessionId?: string;
}

export interface ReviewTabActions {
  openReviewTab: (projectPath: string, options?: OpenReviewTabOptions) => string | null;
}

/** Review tabs observe a repository/session; they never own or stop its process. */
export function createReviewTabActions(
  set: (recipe: (state: PanesDraft) => void) => void,
  get: () => PanesState,
): ReviewTabActions {
  return {
    openReviewTab: (projectPath, options) => {
      if (!projectPath.trim()) return null;
      let tabId: string | null = null;
      set((state) => {
        const target = resolveLayoutWriteTarget(state, options?.layoutId);
        if (!target) return;
        const panels = collectPanels(target.tree);
        const existingPane = panels.find((panel) => panel.tabs.some((tab) =>
          tab.contentType === "review" && tab.projectPath === projectPath
          && tab.reviewChatId === options?.checkpointChatId
          && tab.reviewCliSessionId === options?.cliSessionId));
        const existing = existingPane?.tabs.find((tab) => tab.contentType === "review"
          && tab.projectPath === projectPath && tab.reviewChatId === options?.checkpointChatId
          && tab.reviewCliSessionId === options?.cliSessionId);
        if (existingPane && existing) {
          existingPane.activeTabId = existing.id;
          target.setActivePaneId(existingPane.id);
          tabId = existing.id;
          return;
        }
        const requested = findPane(target.tree, options?.paneId ?? (target.isCurrent ? state.activePaneId : ""));
        const pane = requested?.type === "panel" ? requested : panels[0];
        if (!pane) return;
        const tab = createTabOfType("review", {
          projectPath, title: i18n.t("reviewChanges", { ns: "panes" }),
          reviewChatId: options?.checkpointChatId, reviewCliSessionId: options?.cliSessionId,
        });
        pane.tabs.push(tab);
        pane.activeTabId = tab.id;
        target.setActivePaneId(pane.id);
        tabId = tab.id;
      });
      if (tabId && (!options?.layoutId || options.layoutId === get().currentLayoutId)) {
        useActivityBarStore.getState().setAppViewMode("panes");
      }
      return tabId;
    },
  };
}
