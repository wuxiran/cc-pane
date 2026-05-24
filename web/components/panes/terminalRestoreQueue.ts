export type RestoreLaunchState = "idle" | "queued" | "launching" | "failed";

const DEFAULT_MAX_RESTORE_LAUNCHES = 2;
const RESTORE_LAUNCH_CANCELLED = "cc-panes.restore-launch-cancelled";

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

function createCancelledError(): Error {
  const error = new Error("Restore launch was cancelled");
  (error as Error & { code?: string }).code = RESTORE_LAUNCH_CANCELLED;
  return error;
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
        item.reject(createCancelledError());
        continue;
      }

      active += 1;
      item.onState?.("launching");

      item.run()
        .then(item.resolve, item.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  };

  return {
    run<T>(task: () => Promise<T>, options: RestoreLaunchQueueOptions = {}): Promise<T> {
      if (options.isCancelled?.()) {
        return Promise.reject(createCancelledError());
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
