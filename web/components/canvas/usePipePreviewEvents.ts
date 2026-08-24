import { useEffect, useMemo, useRef, useState } from "react";
import type { PipeEdge, PipeEvent, PipeEventPhase } from "@/types/canvas";

const QUEUED_MS = 360;
const FLOWING_MS = 3_200;
const DELIVERED_MS = 900;
const EDGE_STAGGER_MS = 260;
const MAX_PREVIEW_EDGES = 4;
const PREVIEW_SEQUENCE_BASE = Number.MAX_SAFE_INTEGER - 1_000;

function edgeSignature(edges: PipeEdge[]): string {
  return edges
    .slice(0, MAX_PREVIEW_EDGES)
    .map((edge) => `${edge.id}:${edge.sourceId}:${edge.targetId}`)
    .join("|");
}

function previewEvent(
  edge: PipeEdge,
  phase: PipeEventPhase,
  runId: number,
  index: number,
): PipeEvent {
  return {
    schemaVersion: 1,
    eventId: `canvas-preview:${runId}:${edge.id}`,
    correlationId: `canvas-preview:${runId}:${edge.id}`,
    sequence: PREVIEW_SEQUENCE_BASE - index,
    workspaceId: "canvas-preview",
    kind: "message",
    phase,
    sourceId: edge.sourceId,
    targetId: edge.targetId,
    summary: "connection preview",
    createdAt: new Date().toISOString(),
  };
}

/**
 * Plays a short visual-only handshake when the canvas opens or its edge set
 * changes. Real orchestration events remain the source of truth for task state.
 */
export function usePipePreviewEvents(
  edges: PipeEdge[],
  enabled: boolean,
  replayKey = 0,
): PipeEvent[] {
  const [events, setEvents] = useState<PipeEvent[]>([]);
  const runId = useRef(0);
  const signature = useMemo(() => edgeSignature(edges), [edges]);
  const previewEdges = useMemo(() => edges.slice(0, MAX_PREVIEW_EDGES), [signature]);

  useEffect(() => {
    if (!enabled || !signature) {
      setEvents([]);
      return;
    }

    const currentRun = ++runId.current;
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    const schedule = (callback: () => void, delay: number) => {
      timeouts.push(setTimeout(callback, delay));
    };
    const publish = (edge: PipeEdge, phase: PipeEventPhase, index: number) => {
      if (currentRun !== runId.current) return;
      const event = previewEvent(edge, phase, currentRun, index);
      setEvents((current) => [
        ...current.filter((candidate) => candidate.eventId !== event.eventId),
        event,
      ]);
    };
    const clear = (edge: PipeEdge) => {
      if (currentRun !== runId.current) return;
      const eventId = `canvas-preview:${currentRun}:${edge.id}`;
      setEvents((current) => current.filter((event) => event.eventId !== eventId));
    };

    previewEdges.forEach((edge, index) => {
      const start = index * EDGE_STAGGER_MS;
      schedule(() => publish(edge, "queued", index), start);
      schedule(() => publish(edge, "flowing", index), start + QUEUED_MS);
      schedule(() => publish(edge, "delivered", index), start + QUEUED_MS + FLOWING_MS);
      schedule(() => clear(edge), start + QUEUED_MS + FLOWING_MS + DELIVERED_MS);
    });

    return () => {
      timeouts.forEach((timeout) => clearTimeout(timeout));
      if (runId.current === currentRun) {
        runId.current += 1;
        setEvents([]);
      }
    };
  }, [enabled, previewEdges, replayKey, signature]);

  return events;
}
