import type { TerminalLaunchError } from "@/types";
import { apiDelete, invokeOrApi } from "./apiClient";

/** Backend launch deadline is 45s; this client grace period covers IPC/REST response delivery. */
export const TERMINAL_LAUNCH_TIMEOUT_MS = 55_000;
export const TERMINAL_RESTORE_QUEUE_TIMEOUT_MS = 60_000;

export function isTerminalReclaimKillReason(reason: string | undefined): boolean {
  return reason === "orphan-reclaim" || reason === "daemon-reaper" || reason === "launch-timeout";
}

export async function cancelTerminalLaunch(launchId: string): Promise<void> {
  if (!launchId.trim()) return;
  return invokeOrApi<void>("cancel_terminal_launch", { launchId }, () =>
    apiDelete(`/api/launches/${encodeURIComponent(launchId)}`),
  );
}

export function createTerminalLaunchTimeoutError(
  launchId: string | undefined,
  timeoutMs: number,
): TerminalLaunchError {
  return {
    code: "LAUNCH_TIMEOUT",
    message: `Terminal launch exceeded ${timeoutMs}ms`,
    params: {
      ...(launchId ? { launchId } : {}),
      runtime: "unknown",
      stage: "client.create_session",
      timeoutMs: String(timeoutMs),
    },
  };
}

/**
 * Bound the UI wait without pretending that a Promise race cancels backend work. The caller's
 * cancel function is invoked once and the backend remains responsible for late-session cleanup.
 */
export function withTerminalLaunchDeadline<T>(
  task: Promise<T>,
  launchId: string | undefined,
  cancel: (() => Promise<void>) | undefined = launchId
    ? () => cancelTerminalLaunch(launchId)
    : undefined,
  timeoutMs = TERMINAL_LAUNCH_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (cancel) {
        void cancel().catch((error) => {
          console.warn("[TerminalService] failed to cancel timed-out launch", { launchId, error });
        });
      }
      reject(createTerminalLaunchTimeoutError(launchId, timeoutMs));
    }, timeoutMs);

    task.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
