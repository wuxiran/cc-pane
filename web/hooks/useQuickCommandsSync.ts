import { useEffect } from "react";
import { usePanesStore, useQuickCommandsStore } from "@/stores";
import { findPane } from "@/stores/paneTreeHelpers";

export function useQuickCommandsSync(): void {
  const activeProjectPath = usePanesStore((state) => {
    const pane = findPane(state.rootPane, state.activePaneId);
    if (pane?.type !== "panel") return undefined;
    return pane.tabs.find((tab) => tab.id === pane.activeTabId)?.projectPath || undefined;
  });
  const load = useQuickCommandsStore((state) => state.load);

  useEffect(() => {
    void load(activeProjectPath).catch((error) => {
      console.error("[QuickCommands] Failed to load commands:", error);
    });
  }, [activeProjectPath, load]);
}
