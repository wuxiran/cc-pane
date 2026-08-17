import type { Terminal } from "@xterm/xterm";
import { terminalService } from "@/services";
import { noteTerminalGeometry } from "@/utils/terminalCast";
import type { TerminalLayoutScheduler } from "./terminalLayoutScheduler";

interface RefValue<T> {
  current: T;
}

/** Sync a newly bound session after its host has had a chance to become renderable. */
export function syncTerminalGeometry(
  sessionId: string,
  term: Terminal,
  layoutSchedulerRef: RefValue<TerminalLayoutScheduler | null>,
  drivesBackendPty: boolean,
  readOnly: boolean,
  reason: string,
): void {
  layoutSchedulerRef.current?.flush(`${reason}.fit`, {
    force: true,
    allowInactive: true,
  });

  if (!drivesBackendPty || readOnly || term.cols <= 1 || term.rows <= 0) return;

  noteTerminalGeometry(sessionId, term.cols, term.rows);
  void terminalService.resize({ sessionId, cols: term.cols, rows: term.rows }).catch(
    (error) => console.warn("[TerminalView] Failed to sync terminal size:", error),
  );
}
