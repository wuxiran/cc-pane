import { withTerminalLaunchDeadline } from "./terminalLaunchDeadline";

let startupBarrier: Promise<void> | null = null;
let completeStartupBarrier: (() => void) | null = null;

/**
 * Activate the one-shot startup barrier before AppShell mounts. All terminal creation paths wait
 * for this promise, so reconciliation has one renderer-wide ordering point instead of per-view
 * timers.
 */
export function beginTerminalRestoreBarrier(): Promise<void> {
  if (startupBarrier) return startupBarrier;
  startupBarrier = new Promise<void>((resolve) => {
    completeStartupBarrier = resolve;
  });
  return startupBarrier;
}

export function finishTerminalRestoreBarrier(): void {
  completeStartupBarrier?.();
  completeStartupBarrier = null;
}

export function waitForTerminalRestoreBarrier(): Promise<void> {
  return startupBarrier ?? Promise.resolve();
}

export function waitForTerminalRestoreBarrierWithDeadline(): Promise<void> {
  return withTerminalLaunchDeadline(waitForTerminalRestoreBarrier(), undefined);
}

export function _resetTerminalRestoreBarrierForTest(): void {
  startupBarrier = null;
  completeStartupBarrier = null;
}
