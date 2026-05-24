import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  useOrchestratorStore,
  useWorkspacesStore,
} from "@/stores";
import type { TaskBindingChangedEvent } from "@/types";

/**
 * 编排同步 Hook — 事件增量更新 TaskBinding，并保留轮询兜底。
 */
export default function useOrchestratorSync() {
  const updateBySessionId = useOrchestratorStore((s) => s.updateBySessionId);
  const loadBindings = useOrchestratorStore((s) => s.loadBindings);
  const applyChangedEvent = useOrchestratorStore((s) => s.applyChangedEvent);
  const selectedWorkspaceId = useWorkspacesStore((s) => s.expandedWorkspaceId);

  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    getCurrentWebview()
      .listen<TaskBindingChangedEvent>("task-binding-changed", (event) => {
        if (cancelled) return;
        applyChangedEvent(event.payload);
      })
      .then((unlisten) => {
        if (cancelled) unlisten();
        else unlisteners.push(unlisten);
      });

    // fix(C4) review: terminal-status 只由 useTerminalStatusStore 全局订阅，这里避免二次订阅。

    getCurrentWebview()
      .listen<{ sessionId: string; exitCode?: number }>("terminal-exit", async (event) => {
        if (cancelled) return;
        const { sessionId, exitCode } = event.payload;
        const code = exitCode ?? 0;

        try {
          if (code === 0) {
            await updateBySessionId(sessionId, {
              status: "completed",
              progress: 100,
              exitCode: code,
            });
          } else {
            await updateBySessionId(sessionId, {
              status: "failed",
              exitCode: code,
            });
          }
        } catch {
          // Session may not be associated with a TaskBinding.
        }
      })
      .then((unlisten) => {
        if (cancelled) unlisten();
        else unlisteners.push(unlisten);
      });

    return () => {
      cancelled = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [applyChangedEvent, updateBySessionId]);

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
