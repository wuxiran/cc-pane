import { describe, expect, it } from "vitest";
import {
  TERMINAL_RENDERER_FLUSH_CHUNK,
  TERMINAL_RENDERER_GLOBAL_HIGH_WATER,
  TERMINAL_RENDERER_SESSION_HIGH_WATER,
  TerminalOutputScheduler,
} from "./terminalOutputScheduler";

function harness() {
  const timers: Array<() => void> = [];
  const delivered: Array<{ sessionId: string; data: string }> = [];
  const dropped: Array<{ sessionId: string; chars: number }> = [];
  const scheduler = new TerminalOutputScheduler({
    schedule: (callback) => {
      timers.push(callback);
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    },
    onDrop: (sessionId, _frame, droppedChars) => dropped.push({ sessionId, chars: droppedChars }),
  });
  const tick = () => timers.shift()?.();
  const enqueue = (sessionId: string, data: string) => scheduler.enqueue(
    sessionId,
    data,
    data.length,
    (chunk, _endSeq, release) => {
      delivered.push({ sessionId, data: chunk });
      release();
    },
  );
  return { scheduler, timers, delivered, dropped, tick, enqueue };
}

describe("TerminalOutputScheduler", () => {
  it("limits a flush to two writes and yields for the next turn", () => {
    const h = harness();
    h.enqueue("s1", "a".repeat(TERMINAL_RENDERER_FLUSH_CHUNK + 1));
    h.enqueue("s2", "b".repeat(TERMINAL_RENDERER_FLUSH_CHUNK + 1));
    h.enqueue("s3", "c".repeat(TERMINAL_RENDERER_FLUSH_CHUNK + 1));

    h.tick();
    expect(h.delivered).toHaveLength(2);
    expect(h.scheduler.getStats().yieldCount).toBe(1);
    h.tick();
    expect(h.delivered.some((entry) => entry.sessionId === "s3")).toBe(true);
  });

  it("keeps active output ahead of an already queued background session", () => {
    const h = harness();
    h.enqueue("background", "b".repeat(TERMINAL_RENDERER_FLUSH_CHUNK + 1));
    h.scheduler.markActive("active");
    h.enqueue("active", "a".repeat(TERMINAL_RENDERER_FLUSH_CHUNK + 1));

    h.tick();
    expect(h.delivered[0]).toEqual({ sessionId: "active", data: "a".repeat(TERMINAL_RENDERER_FLUSH_CHUNK) });
  });

  it("drops an over-budget session and exposes the dropped byte count", () => {
    const h = harness();
    h.enqueue("flood", "x".repeat(TERMINAL_RENDERER_SESSION_HIGH_WATER + 1));

    expect(h.dropped).toEqual([{ sessionId: "flood", chars: TERMINAL_RENDERER_SESSION_HIGH_WATER + 1 }]);
    expect(h.scheduler.getStats().queuedChars).toBe(0);
  });

  it("preserves the global budget across sessions", () => {
    const h = harness();
    const chunk = "x".repeat(TERMINAL_RENDERER_FLUSH_CHUNK);
    h.scheduler.enqueue("anchor", chunk, undefined, () => {
      // Keep one small frame in-flight so following sessions exercise the
      // aggregate budget instead of the synchronous small-frame fast path.
    });
    const count = Math.ceil(TERMINAL_RENDERER_GLOBAL_HIGH_WATER / chunk.length);
    for (let i = 0; i < count; i += 1) h.enqueue(`s${i}`, chunk);
    h.enqueue("overflow", chunk);

    expect(h.dropped.length).toBeGreaterThan(0);
    expect(h.scheduler.getStats().droppedChars).toBeGreaterThan(0);
  });
});
