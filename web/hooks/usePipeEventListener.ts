import { useEffect } from "react";
import { listenIfTauri } from "@/services/runtime";
import { adaptPipeEventPayload } from "@/lib/pipeEventAdapter";
import { useCanvasStore } from "@/stores/useCanvasStore";
import type { RuntimeEvent } from "@/services/runtime";

export const ORCHESTRATION_PIPE_EVENT = "orchestration-pipe-event";

export function handlePipeEventPayload(payload: unknown): boolean {
  const event = adaptPipeEventPayload(payload);
  if (!event) return false;
  useCanvasStore.getState().dispatchPipeEvent({ type: "event", event });
  return true;
}

/** Subscribes only in Tauri; Web builds keep the no-op listenIfTauri fallback. */
export function usePipeEventListener(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listenIfTauri(ORCHESTRATION_PIPE_EVENT, (runtimeEvent: RuntimeEvent<unknown>) => {
      handlePipeEventPayload(runtimeEvent.payload);
    }).then((cleanup) => {
      if (cancelled) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [enabled]);
}
