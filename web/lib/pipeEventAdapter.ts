import type { CanvasPipeEvent, PipeEventKind, PipeEventPhase, PipeEventWire } from "@/types/canvas";

export const PIPE_EVENT_SCHEMA_VERSION = 1;

const KINDS: readonly PipeEventKind[] = ["dispatch", "message", "report"];
const PHASES: readonly PipeEventPhase[] = ["queued", "flowing", "delivered", "failed"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isIsoDate(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Validates and adapts an untrusted Tauri event payload to the Canvas model. */
export function adaptPipeEventPayload(payload: unknown): CanvasPipeEvent | null {
  if (!isRecord(payload)) return null;
  if (payload.schemaVersion !== PIPE_EVENT_SCHEMA_VERSION) return null;
  if (!isNonEmptyString(payload.eventId) || !isNonEmptyString(payload.correlationId)) return null;
  if (!isInteger(payload.sequence) || !isNonEmptyString(payload.workspaceId)) return null;
  if (!KINDS.includes(payload.kind as PipeEventKind) || !PHASES.includes(payload.phase as PipeEventPhase)) return null;
  if (!isNonEmptyString(payload.summary) || !isIsoDate(payload.createdAt)) return null;
  if (!isOptionalString(payload.fromBinding) || !isOptionalString(payload.toBinding)) return null;
  if (!isOptionalString(payload.fromSession) || !isOptionalString(payload.toSession)) return null;
  if (payload.attempt !== undefined && !isInteger(payload.attempt)) return null;
  if (payload.reason !== undefined && typeof payload.reason !== "string") return null;

  const wire: PipeEventWire = {
    schemaVersion: payload.schemaVersion,
    eventId: payload.eventId,
    correlationId: payload.correlationId,
    attempt: payload.attempt,
    sequence: payload.sequence,
    workspaceId: payload.workspaceId,
    kind: payload.kind as PipeEventKind,
    phase: payload.phase as PipeEventPhase,
    fromBinding: payload.fromBinding,
    toBinding: payload.toBinding,
    fromSession: payload.fromSession,
    toSession: payload.toSession,
    summary: payload.summary,
    reason: payload.reason,
    createdAt: payload.createdAt,
  };
  return {
    ...wire,
    sourceId: wire.fromBinding
      ? `binding:${wire.fromBinding}`
      : wire.fromSession
        ? `session:${wire.fromSession}`
        : undefined,
    targetId: wire.toBinding
      ? `binding:${wire.toBinding}`
      : wire.toSession
        ? `session:${wire.toSession}`
        : undefined,
  };
}
