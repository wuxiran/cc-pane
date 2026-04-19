interface TerminalWriteTarget {
  write: (data: string, callback?: () => void) => void;
}

interface TerminalWriteFlowControlOptions {
  enabled?: boolean;
  bytesThreshold?: number;
  highWatermark?: number;
  lowWatermark?: number;
}

const DEFAULT_BYTES_THRESHOLD = 1024 * 128;
const DEFAULT_HIGH_WATERMARK = 10;
const DEFAULT_LOW_WATERMARK = 5;

export function createTerminalWriteFlowControl(
  target: TerminalWriteTarget,
  options: TerminalWriteFlowControlOptions = {}
) {
  const enabled = options.enabled ?? true;
  const bytesThreshold = options.bytesThreshold ?? DEFAULT_BYTES_THRESHOLD;
  const highWatermark = options.highWatermark ?? DEFAULT_HIGH_WATERMARK;
  const lowWatermark = options.lowWatermark ?? DEFAULT_LOW_WATERMARK;

  let blocked = false;
  let blockedPromise: Promise<void> | null = null;
  let unblockBlocked: (() => void) | null = null;
  let pendingCallbacks = 0;
  let bytesWritten = 0;

  function setBlocked(nextBlocked: boolean): void {
    if (blocked === nextBlocked) return;
    blocked = nextBlocked;
    if (nextBlocked) {
      blockedPromise = new Promise<void>((resolve) => {
        unblockBlocked = resolve;
      });
      return;
    }

    blockedPromise = null;
    const resolve = unblockBlocked;
    unblockBlocked = null;
    resolve?.();
  }

  function waitUntilUnblocked(): Promise<void> {
    return blockedPromise ?? Promise.resolve();
  }

  function writeWithCallback(data: string, onWritten?: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        target.write(data, () => {
          onWritten?.();
          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async function write(data: string, onWritten?: () => void): Promise<void> {
    if (blocked) {
      await waitUntilUnblocked();
    }

    bytesWritten += data.length;
    const shouldTrackCallback = enabled && bytesWritten > bytesThreshold;

    if (!shouldTrackCallback) {
      await writeWithCallback(data, onWritten);
      return;
    }

    bytesWritten = 0;
    pendingCallbacks++;
    if (!blocked && pendingCallbacks > highWatermark) {
      setBlocked(true);
    }

    await writeWithCallback(data, () => {
      pendingCallbacks = Math.max(0, pendingCallbacks - 1);
      if (blocked && pendingCallbacks < lowWatermark) {
        setBlocked(false);
      }
      onWritten?.();
    });
  }

  function reset(): void {
    bytesWritten = 0;
    pendingCallbacks = 0;
    setBlocked(false);
  }

  return {
    write,
    reset,
  };
}
