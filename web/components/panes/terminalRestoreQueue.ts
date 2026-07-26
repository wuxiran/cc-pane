export type RestoreLaunchState = "idle" | "queued" | "launching" | "failed";

const DEFAULT_MAX_RESTORE_LAUNCHES = 3;
const RESTORE_LAUNCH_CANCELLED = "cc-panes.restore-launch-cancelled";
// A single restore launch that never settles (hung WSL cold start, unresponsive
// daemon, blocking hook sync) must not hold a concurrency slot forever, or every
// queued tab behind it would stay stuck and "only half" the sessions restore.
const RESTORE_LAUNCH_TIMEOUT_MS = 45_000;

interface RestoreLaunchQueueOptions {
  isCancelled?: () => boolean;
  onState?: (state: RestoreLaunchState) => void;
}

interface RestoreLaunchQueueItem<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  isCancelled?: () => boolean;
  onState?: (state: RestoreLaunchState) => void;
}

export interface RestoreLaunchQueue {
  run<T>(task: () => Promise<T>, options?: RestoreLaunchQueueOptions): Promise<T>;
  getSnapshot(): { active: number; pending: number };
}

export function createRestoreLaunchCancelledError(): Error {
  const error = new Error("Restore launch was cancelled");
  (error as Error & { code?: string }).code = RESTORE_LAUNCH_CANCELLED;
  return error;
}

/// Reject with a timeout error if the underlying launch does not settle in time,
/// so the queue can free the slot and drain the next item.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Restore launch timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function isRestoreLaunchCancelled(error: unknown): boolean {
  return error instanceof Error
    && (error as Error & { code?: string }).code === RESTORE_LAUNCH_CANCELLED;
}

export function createRestoreLaunchQueue(
  maxConcurrent = DEFAULT_MAX_RESTORE_LAUNCHES,
): RestoreLaunchQueue {
  const maxActive = Math.max(1, Math.floor(maxConcurrent));
  let active = 0;
  const pending: RestoreLaunchQueueItem<unknown>[] = [];

  const drain = () => {
    while (active < maxActive && pending.length > 0) {
      const item = pending.shift();
      if (!item) return;

      if (item.isCancelled?.()) {
        item.onState?.("idle");
        item.reject(createRestoreLaunchCancelledError());
        continue;
      }

      active += 1;
      item.onState?.("launching");

      withTimeout(item.run(), RESTORE_LAUNCH_TIMEOUT_MS)
        .then(item.resolve, (error) => {
          item.onState?.("failed");
          item.reject(error);
        })
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  };

  return {
    run<T>(task: () => Promise<T>, options: RestoreLaunchQueueOptions = {}): Promise<T> {
      if (options.isCancelled?.()) {
        return Promise.reject(createRestoreLaunchCancelledError());
      }

      return new Promise<T>((resolve, reject) => {
        if (active >= maxActive || pending.length > 0) {
          options.onState?.("queued");
        }

        pending.push({
          run: task,
          resolve: resolve as (value: unknown) => void,
          reject,
          isCancelled: options.isCancelled,
          onState: options.onState,
        });
        drain();
      });
    },

    getSnapshot() {
      return { active, pending: pending.length };
    },
  };
}

export const terminalRestoreLaunchQueue = createRestoreLaunchQueue();
