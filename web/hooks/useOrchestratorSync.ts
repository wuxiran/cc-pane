import useCompletedTaskAutoClose from "./useCompletedTaskAutoClose";
import { useEffect } from "react";
import {
  useOrchestratorStore,
  useWorkflowStore,
  useWorkspacesStore,
} from "@/stores";
import type { TaskBindingChangedEvent } from "@/types";
import { listenWebviewIfTauri } from "@/services/runtime";
import { startVisibleInterval } from "@/utils/visibleInterval";

/**
 * 编排同步 Hook — 事件增量更新 TaskBinding，并保留轮询兜底。
 */
export default function useOrchestratorSync() {
  useCompletedTaskAutoClose();
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

    // 多阶段工作流（docs/114）：后端推进后发 workflow-changed，这里整表重拉（量小）。
    listenWebviewIfTauri<{ id: string }>("workflow-changed", () => {
        if (cancelled) return;
        void useWorkflowStore.getState().load();
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
    return startVisibleInterval(() => {
      loadBindings();
    }, 10000);
  }, [loadBindings]);

  useEffect(() => {
    loadBindings();
  }, [loadBindings, selectedWorkspaceId]);
}
