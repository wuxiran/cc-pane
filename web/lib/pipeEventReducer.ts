import type { CanvasPipeEvent, PipeEventPhase } from "@/types/canvas";

export const PIPE_EVENT_TERMINAL_TTL_MS = 5_000;

export function isTerminalPipeEventPhase(phase: PipeEventPhase): boolean {
  return phase === "delivered" || phase === "failed";
}

export function isActivePipeEventPhase(phase: PipeEventPhase): boolean {
  return phase === "queued" || phase === "flowing";
}

export interface PipeEventState {
  events: CanvasPipeEvent[];
}

export type PipeEventAction =
  | { type: "event"; event: CanvasPipeEvent }
  | { type: "phase"; eventId: string; phase: PipeEventPhase }
  | { type: "remove"; eventId: string }
  | { type: "clear" };

function pipeEventLifecycleKey(event: CanvasPipeEvent): string {
  // Binding identifiers stay stable through dispatch. Session identifiers can
  // appear only after the worker PTY exists, so they must not split one
  // queued -> flowing -> delivered transport into two visual lifecycles.
  const source = event.fromBinding ?? event.fromSession ?? "";
  const target = event.toBinding ?? event.toSession ?? "";
  return JSON.stringify([
    event.correlationId,
    event.attempt ?? 0,
    event.kind,
    source,
    target,
  ]);
}

function isSamePipeEventLifecycle(left: CanvasPipeEvent, right: CanvasPipeEvent): boolean {
  return pipeEventLifecycleKey(left) === pipeEventLifecycleKey(right);
}

function isSamePipeEvent(left: CanvasPipeEvent, right: CanvasPipeEvent): boolean {
  return left.eventId === right.eventId || isSamePipeEventLifecycle(left, right);
}

function isExpiredTerminalEvent(event: CanvasPipeEvent, now: number): boolean {
  if (!isTerminalPipeEventPhase(event.phase)) return false;
  const createdAt = Date.parse(event.createdAt);
  return Number.isFinite(createdAt) && now - createdAt > PIPE_EVENT_TERMINAL_TTL_MS;
}

export function prunePipeEvents(events: CanvasPipeEvent[], now = Date.now()): CanvasPipeEvent[] {
  return events.filter((event) => !isExpiredTerminalEvent(event, now));
}

export function reducePipeEvents(state: PipeEventState, action: PipeEventAction, now = Date.now()): PipeEventState {
  switch (action.type) {
    case "event": {
      const existingEvents = prunePipeEvents(state.events, now);
      const existing = existingEvents.find((event) => isSamePipeEvent(event, action.event));
      if (existing && existing.sequence > action.event.sequence) return { events: existingEvents };
      return {
        events: [
          ...existingEvents.filter((event) => !isSamePipeEvent(event, action.event)),
          action.event,
        ],
      };
    }
    case "phase": {
      const existingEvents = prunePipeEvents(state.events, now);
      return {
        events: existingEvents.map((event) => event.eventId === action.eventId ? { ...event, phase: action.phase } : event),
      };
    }
    case "remove":
      return { events: state.events.filter((event) => event.eventId !== action.eventId) };
    case "clear":
      return { events: [] };
  }
}
