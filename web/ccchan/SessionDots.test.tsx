import { describe, expect, it } from "vitest";
import type { TerminalStatusInfo } from "@/types";
import { visibleSessionDots } from "./SessionDots";

function status(sessionId: string, value: TerminalStatusInfo["status"]): TerminalStatusInfo {
  return {
    sessionId,
    status: value,
    lastOutputAt: 1000,
    updatedAt: 1000,
  };
}

describe("visibleSessionDots", () => {
  it("only keeps actionable non-idle session states", () => {
    const dots = visibleSessionDots([
      status("z-idle", "idle"),
      status("b-waiting", "waitingInput"),
      status("a-working", "toolRunning"),
      status("x-exited", "exited"),
    ]);

    expect(dots.map((dot) => dot.sessionId)).toEqual(["a-working", "b-waiting"]);
  });
});
