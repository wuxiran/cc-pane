interface TerminalWriteTarget {
  write: (data: string, callback?: () => void) => void;
}

interface TerminalWriteFlowControlOptions {
  enabled?: boolean;
  bytesThreshold?: number;
  highWatermark?: number;
  lowWatermark?: number;
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
    onWritten?: () => void;
    resolve: () => void;
    reject: (error: unknown) => void;
  }

  const queue: PendingWrite[] = [];
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
          if (!callbackCompleted && shouldTrackCallback) {
            pendingCallbacks = Math.max(0, pendingCallbacks - 1);
            if (blocked && pendingCallbacks <= lowWatermark) blocked = false;
          }
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
      queue.push({ data, onWritten, resolve, reject });
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

  return {
    write,
    reset,
  };
}
