interface TerminalWriteTarget {
  write: (data: string, callback?: () => void) => void;
}

interface TerminalWriteFlowControlOptions {
  enabled?: boolean;
  bytesThreshold?: number;
  highWatermark?: number;
  lowWatermark?: number;
  now?: () => number;
  onStall?: (error: Error) => void;
  onProgress?: () => void;
}

const MAX_TARGET_WRITE_CHARS = 16 * 1024;
const WRITE_STALL_MS = 3_000;

/** One FIFO owns both queued tails and writes already handed to xterm. */
export function createTerminalWriteFlowControl(
  target: TerminalWriteTarget,
  options: TerminalWriteFlowControlOptions = {},
) {
  const enabled = options.enabled ?? true;
  const bytesThreshold = Math.max(1, options.bytesThreshold ?? MAX_TARGET_WRITE_CHARS);
  const highWatermark = Math.max(1, options.highWatermark ?? 4);
  const lowWatermark = Math.min(highWatermark - 1, Math.max(0, options.lowWatermark ?? 2));
  const now = options.now ?? (() => performance.now());
  interface PendingWrite {
    data: string;
    offset: number;
    queuedAt: number;
    waiting: boolean;
    onWritten?: () => void;
    resolve: () => void;
    reject: (error: unknown) => void;
  }
  const queue: PendingWrite[] = [];
  const pending = new Set<PendingWrite>();
  let queuedChars = 0;
  let inFlightChars = 0;
  let inFlightWrites = 0;
  let receivedChars = 0;
  let writeCalls = 0;
  let failedWrites = 0;
  let callbackMaxMs = 0;
  let intervalCallbackMaxMs = 0;
  let blocked = false;
  let pumping = false;
  let pendingCallbacks = 0;
  let bytesWritten = 0;
  let failure: Error | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let pumpTimer: ReturnType<typeof setTimeout> | null = null;

  function clearWatchdog(): void {
    if (watchdog !== null) clearTimeout(watchdog);
    watchdog = null;
  }

  function stop(error: Error): void {
    if (failure) return;
    failure = error;
    clearWatchdog();
    if (pumpTimer !== null) clearTimeout(pumpTimer);
    pumpTimer = null;
    failedWrites += pending.size;
    for (const entry of pending) entry.reject(error);
    pending.clear();
    queue.length = 0;
    queuedChars = inFlightChars = inFlightWrites = pendingCallbacks = bytesWritten = 0;
    blocked = false;
  }

  function watchProgress(): void {
    if (watchdog !== null || inFlightWrites === 0 || failure) return;
    watchdog = setTimeout(() => {
      watchdog = null;
      const error = new Error("Terminal output parsing made no progress");
      stop(error);
      // The view owner decides how to recover; never resume this failed writer.
      options.onStall?.(error);
    }, WRITE_STALL_MS);
  }

  function schedulePump(): void {
    if (pumpTimer !== null || failure) return;
    // Yield large replay tails without depending on background rAF delivery.
    pumpTimer = setTimeout(() => { pumpTimer = null; pump(); }, 16);
  }

  function pump(): void {
    if (pumping || blocked || failure || pumpTimer !== null) return;
    pumping = true;
    try {
      while (queue.length && !blocked && !failure && pumpTimer === null) {
        const entry = queue[0];
        if (entry.waiting) break;
        let end = Math.min(entry.data.length, entry.offset + MAX_TARGET_WRITE_CHARS);
        // Keep a UTF-16 surrogate pair in one xterm write.
        const last = entry.data.charCodeAt(end - 1);
        if (end < entry.data.length && last >= 0xd800 && last <= 0xdbff) end--;
        const chunk = entry.data.slice(entry.offset, end);
        entry.offset = end;
        entry.waiting = true;
        if (end === entry.data.length) queue.shift();
        queuedChars -= chunk.length;
        inFlightChars += chunk.length;
        inFlightWrites++;
        bytesWritten += chunk.length;
        const tracked = enabled && bytesWritten >= bytesThreshold;
        if (tracked) {
          bytesWritten = 0;
          pendingCallbacks++;
          blocked = pendingCallbacks >= highWatermark;
        }
        watchProgress();
        let completed = false;
        const complete = () => {
          if (completed || failure || !pending.has(entry)) return;
          completed = true;
          entry.waiting = false;
          inFlightChars -= chunk.length;
          inFlightWrites--;
          const elapsed = now() - entry.queuedAt;
          callbackMaxMs = Math.max(callbackMaxMs, elapsed);
          intervalCallbackMaxMs = Math.max(intervalCallbackMaxMs, elapsed);
          if (tracked) pendingCallbacks--;
          if (blocked && pendingCallbacks <= lowWatermark) blocked = false;
          clearWatchdog();
          watchProgress();
          options.onProgress?.();
          if (entry.offset < entry.data.length) schedulePump();
          else {
            pending.delete(entry);
            try { entry.onWritten?.(); entry.resolve(); }
            catch (error) { entry.reject(error); }
          }
          pump();
        };
        try { target.write(chunk, complete); }
        catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
      }
    } finally { pumping = false; }
  }

  function write(data: string, onWritten?: () => void): Promise<void> {
    if (failure) return Promise.reject(failure);
    if (!data) {
      try { onWritten?.(); return Promise.resolve(); }
      catch (error) { return Promise.reject(error); }
    }
    return new Promise<void>((resolve, reject) => {
      const entry = { data, offset: 0, queuedAt: now(), waiting: false, onWritten, resolve, reject };
      pending.add(entry);
      queue.push(entry);
      queuedChars += data.length;
      receivedChars += data.length;
      writeCalls++;
      pump();
    });
  }

  function dispose(reason = "terminal write flow control disposed"): void {
    stop(new DOMException(reason, "AbortError"));
  }

  return {
    write,
    dispose,
    queueLength: () => queue.length,
    takeIntervalCallbackMaxMs: () => {
      const result = intervalCallbackMaxMs;
      intervalCallbackMaxMs = 0;
      return result;
    },
    getStats: () => ({
      queuedChars, inFlightChars, inFlightWrites, queuedWrites: queue.length,
      receivedChars, writeCalls, failedWrites, callbackMaxMs, blocked, pendingCallbacks,
      oldestWaitMs: pending.size ? Math.max(0, now() - pending.values().next().value!.queuedAt) : 0,
    }),
  };
}
