interface TerminalWriteTarget {
  write: (data: string, callback?: () => void) => void;
}

interface TerminalWriteFlowControlOptions {
  enabled?: boolean;
  bytesThreshold?: number;
  highWatermark?: number;
  lowWatermark?: number;
  now?: () => number;
}

// Keep the xterm write queue shallow during TUI redraw bursts. Orca applies a
// credit window at the stream layer; this is the equivalent renderer-side
// window for the desktop xterm instance.
const DEFAULT_BYTES_THRESHOLD = 16 * 1024;
const DEFAULT_HIGH_WATERMARK = 4;
const DEFAULT_LOW_WATERMARK = 2;

export function createTerminalWriteFlowControl(
  target: TerminalWriteTarget,
  options: TerminalWriteFlowControlOptions = {}
) {
  const enabled = options.enabled ?? true;
  const bytesThreshold = Math.max(1, options.bytesThreshold ?? DEFAULT_BYTES_THRESHOLD);
  const highWatermark = Math.max(1, options.highWatermark ?? DEFAULT_HIGH_WATERMARK);
  const lowWatermark = Math.min(
    highWatermark - 1,
    Math.max(0, options.lowWatermark ?? DEFAULT_LOW_WATERMARK),
  );

  interface PendingWrite {
    data: string;
    queuedAt: number;
    onWritten?: () => void;
    resolve: () => void;
    reject: (error: unknown) => void;
  }

  const queue: PendingWrite[] = [];
  const now = options.now ?? (() => performance.now());
  let queuedChars = 0;
  let inFlightChars = 0;
  let inFlightWrites = 0;
  let receivedChars = 0;
  let writeCalls = 0;
  let failedWrites = 0;
  let callbackMaxMs = 0;
  let blocked = false;
  let pumping = false;
  let pendingCallbacks = 0;
  let bytesWritten = 0;

  function pump(): void {
    if (pumping || blocked) return;
    pumping = true;
    try {
      while (queue.length > 0 && !blocked) {
        const entry = queue.shift()!;
        queuedChars -= entry.data.length;
        inFlightChars += entry.data.length;
        inFlightWrites += 1;
        bytesWritten += entry.data.length;
        const shouldTrackCallback = enabled && bytesWritten >= bytesThreshold;
        if (shouldTrackCallback) {
          bytesWritten = 0;
          pendingCallbacks += 1;
          if (pendingCallbacks >= highWatermark) blocked = true;
        }

        let callbackCompleted = false;
        const complete = () => {
          if (callbackCompleted) return;
          callbackCompleted = true;
          inFlightChars -= entry.data.length;
          inFlightWrites -= 1;
          callbackMaxMs = Math.max(callbackMaxMs, now() - entry.queuedAt);
          if (shouldTrackCallback) {
            pendingCallbacks = Math.max(0, pendingCallbacks - 1);
            if (blocked && pendingCallbacks <= lowWatermark) blocked = false;
          }
          try {
            entry.onWritten?.();
            entry.resolve();
          } catch (error) {
            entry.reject(error);
          } finally {
            pump();
          }
        };

        try {
          target.write(entry.data, complete);
        } catch (error) {
          if (!callbackCompleted) {
            inFlightChars -= entry.data.length;
            inFlightWrites -= 1;
            failedWrites += 1;
          }
          if (!callbackCompleted && shouldTrackCallback) {
            pendingCallbacks = Math.max(0, pendingCallbacks - 1);
            if (blocked && pendingCallbacks <= lowWatermark) blocked = false;
          }
          callbackCompleted = true;
          entry.reject(error);
        }
      }
    } finally {
      pumping = false;
    }

    // Synchronous xterm mocks can complete while the pump is active. Run one
    // more pass after dropping the re-entrancy guard so queued writes progress.
    if (!blocked && queue.length > 0) pump();
  }

  function write(data: string, onWritten?: () => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      queuedChars += data.length;
      receivedChars += data.length;
      writeCalls += 1;
      queue.push({ data, queuedAt: now(), onWritten, resolve, reject });
      try {
        pump();
      } catch (error) {
        reject(error);
      }
    });
  }

  function reset(): void {
    bytesWritten = 0;
    pendingCallbacks = 0;
    blocked = false;
    pump();
  }

  /**
   * 拆除：拒绝所有未完成的写入并清空队列。
   *
   * TerminalView 卸载时先 reset() 再把引用置 null，队列里的 Promise 就此**永不
   * settle**——它们的 await 方（terminalOutputHandler 的 writeTerminalData）会永远
   * 挂着，连带扣住的流控信用也永远还不回去（= 上游窗口被永久缩小一截）。
   * 这里显式 reject 让 catch 分支跑起来：那里会 invalidateSeq 并归还信用。
   */
  function dispose(reason = "terminal write flow control disposed"): void {
    const pending = queue.splice(0);
    queuedChars = 0;
    bytesWritten = 0;
    pendingCallbacks = 0;
    blocked = false;
    for (const entry of pending) entry.reject(new Error(reason));
  }

  /** 队列深度。看门狗与诊断用——此前完全不可观测。 */
  function queueLength(): number {
    return queue.length;
  }

  return {
    write,
    reset,
    dispose,
    queueLength,
    getStats: () => ({ queuedChars, inFlightChars, inFlightWrites, queuedWrites: queue.length,
      receivedChars, writeCalls, failedWrites, callbackMaxMs,
      oldestWaitMs: queue.length ? Math.max(0, now() - queue[0].queuedAt) : 0 }),
  };
}
