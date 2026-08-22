import type { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { terminalService } from "@/services";
import { noteTerminalGeometry } from "@/utils/terminalCast";
import type { TerminalLayoutScheduler } from "./terminalLayoutScheduler";
import { syncTerminalGeometry } from "./terminalSessionGeometry";

vi.mock("@/services", () => ({
  terminalService: { resize: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("@/utils/terminalCast", () => ({
  noteTerminalGeometry: vi.fn(),
}));

describe("syncTerminalGeometry", () => {
  it("fits before sending the newly bound PTY its dimensions", () => {
    const term = { cols: 80, rows: 24 } as Terminal;
    const flush = vi.fn(() => {
      (term as unknown as { cols: number; rows: number }).cols = 132;
      (term as unknown as { cols: number; rows: number }).rows = 42;
      return term;
    });
    const scheduler = {
      schedule: vi.fn(),
      flush,
      cancel: vi.fn(),
      dispose: vi.fn(),
      hasPendingLayout: vi.fn(() => false),
    } satisfies TerminalLayoutScheduler;

    syncTerminalGeometry(
      "background-session",
      term,
      { current: scheduler },
      true,
      false,
      "session.deferred-restore.attach",
    );

    expect(flush).toHaveBeenCalledWith("session.deferred-restore.attach.fit", {
      force: true,
      allowInactive: true,
    });
    expect(noteTerminalGeometry).toHaveBeenCalledWith("background-session", 132, 42);
    expect(terminalService.resize).toHaveBeenCalledWith({
      sessionId: "background-session",
      cols: 132,
      rows: 42,
    });
  });
});
