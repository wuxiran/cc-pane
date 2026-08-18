import { useEffect } from "react";
import {
  useOrchestratorStore,
  useWorkspacesStore,
} from "@/stores";
import type { TaskBindingChangedEvent } from "@/types";
import { listenWebviewIfTauri } from "@/services/runtime";

/**
 * 编排同步 Hook — 事件增量更新 TaskBinding，并保留轮询兜底。
 */
export default function useOrchestratorSync() {
  const loadBindings = useOrchestratorStore((s) => s.loadBindings);
  const applyChangedEvent = useOrchestratorStore((s) => s.applyChangedEvent);
  const selectedWorkspaceId = useWorkspacesStore((s) => s.expandedWorkspaceId);

  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    listenWebviewIfTauri<TaskBindingChangedEvent>("task-binding-changed", (event) => {
        if (cancelled) return;
        applyChangedEvent(event.payload);
      })
      .then((unlisten) => {
        if (cancelled) unlisten();
        else unlisteners.push(unlisten);
      });

    return () => {
      cancelled = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [applyChangedEvent]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      loadBindings();
    }, 10000);

    return () => window.clearInterval(interval);
  }, [loadBindings]);

  useEffect(() => {
    loadBindings();
  }, [loadBindings, selectedWorkspaceId]);
}
