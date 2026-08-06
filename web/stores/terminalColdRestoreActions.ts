import { findTerminalPane } from "@/lib/paneSessions";
import type { Tab } from "@/types";
import type {
  DraftTabAcrossLayoutsLocation,
  PanesDraft,
  PanesState,
} from "./panesStoreTypes";
import { inferCliTool, resolveRestoreMode } from "@/lib/terminalRestoreMode";

type ColdRestoreActions = Pick<
  PanesState,
  "beginTerminalColdRestore" | "finishTerminalColdRestore"
>;

interface ColdRestoreActionDependencies {
  set: (recipe: (state: PanesDraft) => void) => void;
  findTab: (state: PanesDraft, tabId: string) => DraftTabAcrossLayoutsLocation | null;
  syncTab: (tab: Tab) => void;
  notifyLayoutChanged: (reason: string) => void;
}

export function createTerminalColdRestoreActions(
  dependencies: ColdRestoreActionDependencies,
): ColdRestoreActions {
  const { set, findTab, syncTab, notifyLayoutChanged } = dependencies;
  return {
    beginTerminalColdRestore: (tabId, terminalPaneId) => {
      let previousSessionId: string | null = null;
      set((state) => {
        const tab = findTab(state, tabId)?.tab;
        if (!tab || tab.contentType !== "terminal" || !tab.terminalRootPane) return;
        const leaf = findTerminalPane(tab.terminalRootPane, terminalPaneId);
        if (
          leaf?.type !== "leaf"
          || leaf.sessionId
          || leaf.restoreBlockedReason !== "claims-unsupported"
          || !leaf.savedSessionId
        ) return;
        previousSessionId = leaf.savedSessionId;
        // Keep the block until kill succeeds, but detach the old id before its
        // session-killed event can close this terminal leaf.
        leaf.savedSessionId = undefined;
        leaf.restoring = true;
        syncTab(tab);
      });
      if (previousSessionId) notifyLayoutChanged("restore.cold.begin");
      return previousSessionId;
    },

    finishTerminalColdRestore: (tabId, terminalPaneId, previousSessionId, succeeded) => {
      set((state) => {
        const tab = findTab(state, tabId)?.tab;
        if (!tab || tab.contentType !== "terminal" || !tab.terminalRootPane) return;
        const leaf = findTerminalPane(tab.terminalRootPane, terminalPaneId);
        if (leaf?.type !== "leaf" || leaf.sessionId) return;
        if (succeeded) {
          if (leaf.savedSessionId) return;
          leaf.restoreBlockedReason = undefined;
          leaf.launchError = undefined;
          leaf.restoring = true;
          leaf.launchAttempt = (leaf.launchAttempt ?? 0) + 1;
          leaf.restoreMode = resolveRestoreMode({
            cliTool: inferCliTool(leaf.cliTool ?? tab.cliTool, leaf.launchClaude, tab.launchClaude),
            resumeId: leaf.resumeId ?? tab.resumeId,
          });
        } else {
          leaf.savedSessionId = previousSessionId;
          leaf.restoring = true;
          leaf.restoreBlockedReason = "claims-unsupported";
        }
        syncTab(tab);
      });
      notifyLayoutChanged(succeeded ? "restore.cold.finish" : "restore.cold.rollback");
    },
  };
}
