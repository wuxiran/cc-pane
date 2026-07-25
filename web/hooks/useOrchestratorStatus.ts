import { useEffect, useState } from "react";
import { mcpService } from "@/services";
import type { OrchestratorStatus } from "@/types";

export function useOrchestratorStatus(): OrchestratorStatus | null {
  const [status, setStatus] = useState<OrchestratorStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    let receivedEvent = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        const stopListening = await mcpService.onOrchestratorStatusChanged((nextStatus) => {
          receivedEvent = true;
          if (!cancelled) setStatus(nextStatus);
        });
        if (cancelled) {
          stopListening();
          return;
        }
        unlisten = stopListening;

        const currentStatus = await mcpService.getOrchestratorStatus();
        if (!cancelled && !receivedEvent) setStatus(currentStatus);
      } catch (error) {
        console.error("[orchestrator] Failed to observe service status", error);
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return status;
}

export default useOrchestratorStatus;
