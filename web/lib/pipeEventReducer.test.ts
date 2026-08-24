import { describe, expect, it } from "vitest";
import { adaptPipeEventPayload } from "./pipeEventAdapter";
import { PIPE_EVENT_TERMINAL_TTL_MS, prunePipeEvents, reducePipeEvents } from "./pipeEventReducer";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    eventId: "event-1",
    correlationId: "corr-1",
    attempt: 0,
    sequence: 1,
    workspaceId: "workspace-1",
    kind: "message",
    phase: "queued",
    fromBinding: "source",
    toBinding: "target",
    summary: "message queued",
    createdAt: "2026-08-23T12:00:00.000Z",
    ...overrides,
  };
}

describe("pipeEventAdapter", () => {
  it("adapts the Rust wire contract and preserves ISO time", () => {
    const event = adaptPipeEventPayload(payload());
    if (!event) throw new Error("fixture should be valid");
    expect(event).toMatchObject({
      eventId: "event-1",
      phase: "queued",
      sourceId: "binding:source",
      targetId: "binding:target",
      createdAt: "2026-08-23T12:00:00.000Z",
    });
  });

  it("accepts flowing as a transport phase", () => {
    const event = adaptPipeEventPayload(payload({ phase: "flowing" }));
    expect(event?.phase).toBe("flowing");
  });

  it.each([
    ["unknown schema", { schemaVersion: 2 }],
    ["unknown phase", { phase: "sending" }],
    ["invalid ISO time", { createdAt: "not-a-date" }],
  ])("rejects %s", (_name, overrides) => {
    expect(adaptPipeEventPayload(payload(overrides))).toBeNull();
  });
});

describe("pipeEventReducer", () => {
  it("deduplicates repeated event ids and ignores older sequences", () => {
    const event = adaptPipeEventPayload(payload());
    if (!event) throw new Error("fixture should be valid");
    const now = Date.parse("2026-08-23T12:00:01.000Z");
    let state = reducePipeEvents({ events: [] }, { type: "event", event }, now);
    state = reducePipeEvents(state, { type: "event", event: { ...event, phase: "delivered", sequence: 2 } }, now);
    state = reducePipeEvents(state, { type: "event", event: { ...event, phase: "failed", sequence: 1 } }, now);
    expect(state.events).toHaveLength(1);
    expect(state.events[0].phase).toBe("delivered");
  });

  it("keeps dispatch and report events with the same correlation and attempt", () => {
    const dispatch = adaptPipeEventPayload(payload({
      eventId: "dispatch-1",
      kind: "dispatch",
      phase: "queued",
    }));
    const report = adaptPipeEventPayload(payload({
      eventId: "report-1",
      kind: "report",
      phase: "queued",
      summary: "report queued",
    }));
    if (!dispatch || !report) throw new Error("fixtures should be valid");

    const state = reducePipeEvents(
      reducePipeEvents({ events: [] }, { type: "event", event: dispatch }),
      { type: "event", event: report },
    );

    expect(state.events).toEqual([dispatch, report]);
  });

  it("aggregates lifecycle events by kind and direction", () => {
    const queued = adaptPipeEventPayload(payload({
      eventId: "dispatch-queued",
      kind: "dispatch",
      phase: "queued",
      sequence: 1,
    }));
    const delivered = adaptPipeEventPayload(payload({
      eventId: "dispatch-delivered",
      kind: "dispatch",
      phase: "delivered",
      sequence: 2,
    }));
    const reverseDirection = adaptPipeEventPayload(payload({
      eventId: "dispatch-reverse",
      kind: "dispatch",
      phase: "queued",
      fromBinding: "target",
      toBinding: "source",
      sequence: 3,
    }));
    const olderDelivered = adaptPipeEventPayload(payload({
      eventId: "dispatch-delivered-old",
      kind: "dispatch",
      phase: "failed",
      sequence: 1,
    }));
    if (!queued || !delivered || !reverseDirection || !olderDelivered) {
      throw new Error("fixtures should be valid");
    }

    const now = Date.parse("2026-08-23T12:00:01.000Z");
    let state = reducePipeEvents({ events: [] }, { type: "event", event: queued }, now);
    state = reducePipeEvents(state, { type: "event", event: delivered }, now);
    state = reducePipeEvents(state, { type: "event", event: reverseDirection }, now);
    state = reducePipeEvents(state, { type: "event", event: olderDelivered }, now);

    expect(state.events).toEqual([delivered, reverseDirection]);
  });

  it("keeps one lifecycle when delivery fills in a worker session id", () => {
    const queued = adaptPipeEventPayload(payload({
      eventId: "dispatch-queued",
      kind: "dispatch",
      phase: "queued",
      sequence: 1,
      fromSession: "leader-session",
    }));
    const delivered = adaptPipeEventPayload(payload({
      eventId: "dispatch-delivered",
      kind: "dispatch",
      phase: "delivered",
      sequence: 2,
      fromSession: "leader-session",
      toSession: "worker-session",
    }));
    if (!queued || !delivered) throw new Error("fixtures should be valid");

    const state = reducePipeEvents(
      reducePipeEvents({ events: [] }, { type: "event", event: queued }),
      { type: "event", event: delivered },
    );

    expect(state.events).toEqual([delivered]);
  });

  it("removes events by eventId", () => {
    const event = adaptPipeEventPayload(payload());
    if (!event) throw new Error("fixture should be valid");
    const state = reducePipeEvents({ events: [event] }, { type: "remove", eventId: event.eventId });
    expect(state.events).toEqual([]);
  });

  it("prunes old terminal events while preserving queued events", () => {
    const now = Date.parse("2026-08-23T12:01:00.000Z");
    const queued = adaptPipeEventPayload(payload({ eventId: "queued", createdAt: new Date(now - 60_000).toISOString() }));
    const delivered = adaptPipeEventPayload(payload({ eventId: "delivered", phase: "delivered", createdAt: new Date(now - PIPE_EVENT_TERMINAL_TTL_MS - 1).toISOString() }));
    const failed = adaptPipeEventPayload(payload({ eventId: "failed", phase: "failed", createdAt: new Date(now - PIPE_EVENT_TERMINAL_TTL_MS - 1).toISOString() }));
    if (!queued || !delivered || !failed) throw new Error("fixture should be valid");

    expect(prunePipeEvents([queued, delivered, failed], now)).toEqual([queued]);
  });

  it("preserves flowing events until a terminal phase arrives", () => {
    const now = Date.parse("2026-08-23T12:01:00.000Z");
    const flowing = adaptPipeEventPayload(payload({
      phase: "flowing",
      createdAt: new Date(now - 60_000).toISOString(),
    }));
    if (!flowing) throw new Error("fixture should be valid");

    expect(prunePipeEvents([flowing], now)).toEqual([flowing]);
  });

  it("does not prune a recent terminal event", () => {
    const now = Date.parse("2026-08-23T12:01:00.000Z");
    const event = adaptPipeEventPayload(payload({ phase: "delivered", createdAt: new Date(now - PIPE_EVENT_TERMINAL_TTL_MS).toISOString() }));
    if (!event) throw new Error("fixture should be valid");

    expect(reducePipeEvents({ events: [event] }, { type: "event", event }, now).events).toHaveLength(1);
  });
});
