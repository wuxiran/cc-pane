import { useEffect } from "react";
import { useOrchestratorStore, usePanesStore, useSettingsStore } from "@/stores";
import { terminalService } from "@/services/terminalService";
import { taskBindingService } from "@/services/taskBindingService";
import { handleErrorSilent } from "@/utils";
import { completedTaskTabId, hasRetainedExitedOutput } from "./completedTaskAutoClose";

/** UI cleanup only. Never sends kill, exit, or input to a PTY. */
export default function useCompletedTaskAutoClose(): void {
  const enabled = useSettingsStore((s) => s.settings?.terminal.autoCloseCompletedTasks === true);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let busy = false;
    const check = async () => {
      if (busy || cancelled) return;
      busy = true;
      try {
        for (const binding of useOrchestratorStore.getState().bindings) {
          try {
            const tabs = () => usePanesStore.getState().allPanelsAcrossLayouts().flatMap((p) => p.tabs);
            if (!completedTaskTabId(binding, tabs(), true, Date.now())) continue;
            const output = await terminalService.getRecentOutput(binding.sessionId!, 1);
            if (!hasRetainedExitedOutput(output, binding.sessionId!)) continue;
            const current = await taskBindingService.get(binding.id);
            if (cancelled || !current || current.sessionId !== binding.sessionId) continue;
            const stillEnabled = useSettingsStore.getState().settings?.terminal.autoCloseCompletedTasks === true;
            const tabId = completedTaskTabId(current, tabs(), stillEnabled, Date.now());
            if (tabId) usePanesStore.getState().removeTabsInternal([tabId], "task-completed");
          } catch (error) {
            // One unavailable output archive must not starve subsequent tasks.
            handleErrorSilent(error, "completed task auto close");
          }
        }
      } finally {
        busy = false;
      }
    };
    const timer = window.setInterval(() => void check(), 5_000);
    void check();
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [enabled]);
}
