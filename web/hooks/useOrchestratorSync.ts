import { useEffect, useRef } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useOrchestratorStore, useTerminalStatusStore } from "@/stores";

/**
 * 编排同步 Hook — 桥接终端状态与 TaskBinding
 *
 * 状态映射：
 * - Active → running, progress: 50
 * - WaitingInput → waiting, progress: 30
 * - Exited(0) → completed, progress: 100
 * - Exited(!0) → failed
 */
export default function useOrchestratorSync() {
  const updateBySessionId = useOrchestratorStore((s) => s.updateBySessionId);
  const loadBindings = useOrchestratorStore((s) => s.loadBindings);
  const statusMap = useTerminalStatusStore((s) => s.statusMap);
  const prevStatusRef = useRef<Map<string, string>>(new Map());

  // 监听 terminal-exit 事件
  useEffect(() => {
    let cancelled = false;

    const setup = async () => {
      const unlisten = await getCurrentWebview().listen<{
        sessionId: string;
        exitCode?: number;
      }>("terminal-exit", async (event) => {
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
          // 静默失败 — session 可能没有关联 TaskBinding
        }
      });

      return unlisten;
    };

    let unlistenFn: (() => void) | null = null;
    setup().then((fn) => {
      if (!cancelled) {
        unlistenFn = fn;
      } else {
        fn();
      }
    });

    return () => {
      cancelled = true;
      unlistenFn?.();
    };
  }, [updateBySessionId]);

  // 监听终端状态变化，自动更新运行中任务
  useEffect(() => {
    const prev = prevStatusRef.current;

    for (const [sessionId, info] of statusMap) {
      const prevStatus = prev.get(sessionId);
      if (prevStatus === info.status) continue;

      prev.set(sessionId, info.status);

      // 状态映射
      if (info.status === "active") {
        updateBySessionId(sessionId, { status: "running", progress: 50 }).catch(() => {});
      } else if (info.status === "waitingInput") {
        updateBySessionId(sessionId, { status: "waiting", progress: 30 }).catch(() => {});
      }
    }
  }, [statusMap, updateBySessionId]);

  // 面板打开时定期刷新列表
  useEffect(() => {
    const interval = setInterval(() => {
      loadBindings();
    }, 10000); // 每 10 秒刷新

    return () => clearInterval(interval);
  }, [loadBindings]);
}
