import { describe, expect, it } from "vitest";
import { buildCursorPositionReport } from "./terminalCpr";

describe("buildCursorPositionReport", () => {
  it("builds a standard CPR response for CSI 6 n", () => {
    expect(buildCursorPositionReport([6], undefined, 0, 0)).toBe("\u001b[1;1R");
    expect(buildCursorPositionReport([6], undefined, 9, 4)).toBe("\u001b[5;10R");
  });

  it("builds a DEC private CPR response for CSI ? 6 n", () => {
    expect(buildCursorPositionReport([6], "?", 3, 1)).toBe("\u001b[?2;4R");
  });

  it("ignores unsupported status reports", () => {
    expect(buildCursorPositionReport([5], undefined, 0, 0)).toBeNull();
    expect(buildCursorPositionReport([], undefined, 0, 0)).toBeNull();
    expect(buildCursorPositionReport([6], ">", 0, 0)).toBeNull();
  });
});
