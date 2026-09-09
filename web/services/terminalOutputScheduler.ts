export type TerminalOutputPriority = "active" | "normal" | "hidden";

export interface TerminalOutputSchedulerStats {
  queuedChars: number;
  inFlightChars: number;
  queuedSessions: number;
  droppedChars: number;
  flushCount: number;
  yieldCount: number;
}

let statsReader = (): TerminalOutputSchedulerStats => ({
  queuedChars: 0,
  inFlightChars: 0,
  queuedSessions: 0,
  droppedChars: 0,
  flushCount: 0,
  yieldCount: 0,
});

export function registerTerminalOutputSchedulerStatsReader(
  reader: () => TerminalOutputSchedulerStats,
): () => void {
  statsReader = reader;
  return () => {
    statsReader = () => ({
      queuedChars: 0,
      inFlightChars: 0,
      queuedSessions: 0,
      droppedChars: 0,
      flushCount: 0,
      yieldCount: 0,
    });
  };
}

export function getTerminalOutputSchedulerStats(): TerminalOutputSchedulerStats {
  return statsReader();
}

export interface PendingTerminalOutputFrame {
  sessionId: string;
  data: string;
  endSeq?: number;
  offset: number;
  deliver: TerminalOutputDelivery;
}

interface SessionQueue {
  frames: PendingTerminalOutputFrame[];
  queuedChars: number;
  inFlightChars: number;
  priority: TerminalOutputPriority;
  lastServed: number;
}

interface TerminalOutputSchedulerOptions {
  onDrop: (sessionId: string, frame: PendingTerminalOutputFrame, droppedChars: number) => void;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
}

// Keep these aligned with Orca's renderer delivery gate. Values are UTF-16 chars,
// matching the existing frontend queue accounting.
export const TERMINAL_RENDERER_SESSION_HIGH_WATER = 512 * 1024;
export const TERMINAL_RENDERER_GLOBAL_HIGH_WATER = 8 * 1024 * 1024;
export const TERMINAL_RENDERER_ACTIVE_SESSION_RESERVE = 512 * 1024;
export const TERMINAL_RENDERER_ACTIVE_GLOBAL_RESERVE = 256 * 1024;
export const TERMINAL_RENDERER_FLUSH_CHUNK = 16 * 1024;
export const TERMINAL_RENDERER_MAX_WRITES_PER_TICK = 2;
export const TERMINAL_RENDERER_CONTINUE_DELAY_MS = 1;

export type TerminalOutputDelivery = (
  data: string,
  endSeq: number | undefined,
  release: () => void,
) => void;

export class TerminalOutputScheduler {
  private readonly sessions = new Map<string, SessionQueue>();
  private readonly onDrop: TerminalOutputSchedulerOptions["onDrop"];
  private readonly schedule: NonNullable<TerminalOutputSchedulerOptions["schedule"]>;
  private queuedChars = 0;
  private inFlightChars = 0;
  private droppedChars = 0;
  private flushCount = 0;
  private yieldCount = 0;
  private sequence = 0;
  private scheduled = false;
  private flushing = false;

  constructor(options: TerminalOutputSchedulerOptions) {
    this.onDrop = options.onDrop;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  }

  enqueue(
    sessionId: string,
    data: string,
    endSeq: number | undefined,
    deliver: TerminalOutputDelivery,
  ): void {
    if (!data) {
      deliver(data, endSeq, () => {});
      return;
    }

    const queue = this.queueFor(sessionId);
    const frame: PendingTerminalOutputFrame = {
      sessionId,
      data,
      endSeq,
      offset: 0,
      deliver,
    };

    const projectedSession = queue.queuedChars + queue.inFlightChars + data.length;
    const projectedGlobal = this.queuedChars + this.inFlightChars + data.length;
    if (queue.priority === "hidden") {
      this.droppedChars += data.length;
      this.onDrop(sessionId, frame, data.length);
      return;
    }
    if (
      projectedSession > this.sessionLimit(queue) ||
      projectedGlobal > this.globalLimit(queue)
    ) {
      this.dropFrame(sessionId, queue, frame);
      return;
    }

    // Preserve the low-latency path for an isolated small frame. Once any
    // renderer work is outstanding, all subsequent frames go through the
    // bounded scheduler so a flood cannot monopolize the event turn.
    if (
      queue.frames.length === 0 &&
      this.queuedChars === 0 &&
      this.inFlightChars === 0 &&
      data.length <= TERMINAL_RENDERER_FLUSH_CHUNK
    ) {
      queue.inFlightChars += data.length;
      this.inFlightChars += data.length;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        queue.inFlightChars = Math.max(0, queue.inFlightChars - data.length);
        this.inFlightChars = Math.max(0, this.inFlightChars - data.length);
      };
      deliver(data, endSeq, release);
      return;
    }

    queue.frames.push(frame);
    queue.queuedChars += data.length;
    this.queuedChars += data.length;
    this.scheduleFlush(0);
  }

  markActive(sessionId: string, active = true): void {
    if (active) {
      for (const [id, queue] of this.sessions) {
        if (id !== sessionId) queue.priority = "normal";
      }
    }
    const queue = this.queueFor(sessionId);
    queue.priority = active ? "active" : "normal";
    this.scheduleFlush(0);
  }

  markPriority(sessionId: string, priority: TerminalOutputPriority): void {
    if (priority === "hidden") {
      this.cancelSession(sessionId);
      return;
    }
    const queue = this.queueFor(sessionId);
    queue.priority = priority;
    if (priority === "active") {
      for (const [id, candidate] of this.sessions) {
        if (id !== sessionId && candidate.priority === "active") candidate.priority = "normal";
      }
    }
    this.scheduleFlush(0);
  }

  cancelSession(sessionId: string): void {
    const queue = this.sessions.get(sessionId);
    if (!queue) return;
    for (const frame of queue.frames.splice(0)) {
      const remaining = frame.data.length - frame.offset;
      if (remaining > 0) {
        this.queuedChars = Math.max(0, this.queuedChars - remaining);
        queue.queuedChars = Math.max(0, queue.queuedChars - remaining);
      }
      this.onDrop(sessionId, frame, remaining);
    }
    this.sessions.delete(sessionId);
  }

  getStats(): TerminalOutputSchedulerStats {
    return {
      queuedChars: this.queuedChars,
      inFlightChars: this.inFlightChars,
      queuedSessions: [...this.sessions.values()].filter((queue) => queue.frames.length > 0).length,
      droppedChars: this.droppedChars,
      flushCount: this.flushCount,
      yieldCount: this.yieldCount,
    };
  }

  dispose(): void {
    for (const sessionId of [...this.sessions.keys()]) this.cancelSession(sessionId);
    this.sessions.clear();
  }

  private queueFor(sessionId: string): SessionQueue {
    let queue = this.sessions.get(sessionId);
    if (!queue) {
      queue = { frames: [], queuedChars: 0, inFlightChars: 0, priority: "normal", lastServed: 0 };
      this.sessions.set(sessionId, queue);
    }
    return queue;
  }

  private sessionLimit(queue: SessionQueue): number {
    return TERMINAL_RENDERER_SESSION_HIGH_WATER +
      (queue.priority === "active" ? TERMINAL_RENDERER_ACTIVE_SESSION_RESERVE : 0);
  }

  private globalLimit(queue: SessionQueue): number {
    const hasActive = [...this.sessions.values()].some((candidate) => candidate.priority === "active");
    if (queue.priority === "active") return TERMINAL_RENDERER_GLOBAL_HIGH_WATER + TERMINAL_RENDERER_ACTIVE_GLOBAL_RESERVE;
    return TERMINAL_RENDERER_GLOBAL_HIGH_WATER - (hasActive ? TERMINAL_RENDERER_ACTIVE_GLOBAL_RESERVE : 0);
  }

  private dropFrame(sessionId: string, queue: SessionQueue, frame: PendingTerminalOutputFrame): void {
    const victim = this.findDropVictim(queue);
    if (victim && victim !== queue) {
      const removed = victim.frames.splice(0);
      for (const dropped of removed) this.dropQueuedFrame(victim, dropped);
    }
    this.droppedChars += frame.data.length;
    this.onDrop(sessionId, frame, frame.data.length);
  }

  private findDropVictim(current: SessionQueue): SessionQueue | null {
    return [...this.sessions.values()]
      .filter((queue) => queue !== current && queue.frames.length > 0 && queue.priority === "normal")
      .sort((a, b) => b.queuedChars - a.queuedChars)[0] ?? null;
  }

  private dropQueuedFrame(queue: SessionQueue, frame: PendingTerminalOutputFrame): void {
    const remaining = frame.data.length - frame.offset;
    this.queuedChars = Math.max(0, this.queuedChars - remaining);
    queue.queuedChars = Math.max(0, queue.queuedChars - remaining);
    this.droppedChars += remaining;
    this.onDrop(frame.sessionId, frame, remaining);
  }

  private scheduleFlush(delayMs: number): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      this.flush();
    }, delayMs);
  }

  private flush(): void {
    if (this.flushing) return;
    this.flushing = true;
    this.flushCount += 1;
    try {
      const candidates = [...this.sessions.entries()]
        .filter(([, queue]) => queue.frames.length > 0)
        .sort(([, a], [, b]) => {
          if (a.priority !== b.priority) return a.priority === "active" ? -1 : 1;
          return a.lastServed - b.lastServed;
        });
      let writes = 0;
      for (const [, queue] of candidates) {
        if (writes >= TERMINAL_RENDERER_MAX_WRITES_PER_TICK) break;
        const frame = queue.frames[0];
        if (!frame) continue;
        const remaining = frame.data.length - frame.offset;
        const size = Math.min(remaining, TERMINAL_RENDERER_FLUSH_CHUNK);
        const isFinal = size === remaining;
        const chunk = frame.data.slice(frame.offset, frame.offset + size);
        frame.offset += size;
        queue.queuedChars = Math.max(0, queue.queuedChars - size);
        this.queuedChars = Math.max(0, this.queuedChars - size);
        queue.inFlightChars += size;
        this.inFlightChars += size;
        queue.lastServed = ++this.sequence;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          queue.inFlightChars = Math.max(0, queue.inFlightChars - size);
          this.inFlightChars = Math.max(0, this.inFlightChars - size);
          this.scheduleFlush(0);
        };
        frame.deliver(chunk, isFinal ? frame.endSeq : undefined, release);
        writes += 1;
        if (isFinal) queue.frames.shift();
      }
      if ([...this.sessions.values()].some((queue) => queue.frames.length > 0)) {
        this.yieldCount += 1;
        this.scheduleFlush(TERMINAL_RENDERER_CONTINUE_DELAY_MS);
      }
    } finally {
      this.flushing = false;
    }
  }
}
