import { describe, expect, it } from "vitest";
import { writeTerminalDeltaReplay } from "./terminalReplayDelta";

function fakeTerminal(cols = 80, rows = 24) {
  const ops: string[] = [];
  const term = {
    cols,
    rows,
    resize(nextCols: number, nextRows: number) {
      term.cols = nextCols;
      term.rows = nextRows;
      ops.push(`resize ${nextCols}x${nextRows}`);
    },
  };
  const writeData = async (data: string) => {
    ops.push(`write ${data}@${term.cols}`);
  };
  return { term, ops, writeData };
}

describe("writeTerminalDeltaReplay", () => {
  it("replays each delta segment at the PTY size it was produced with", async () => {
    const { term, ops, writeData } = fakeTerminal();

    await writeTerminalDeltaReplay(term, {
      delta: "ab中😀cd",
      deltaGeometry: { cols: 40, rows: 20 },
      deltaResizes: [
        { offset: 5, cols: 120, rows: 30 },
        { offset: 7, cols: 100, rows: 30 },
      ],
    }, writeData);

    expect(ops).toEqual([
      "resize 40x20",
      "write ab中😀@40",
      "resize 120x30",
      "write cd@120",
      "resize 100x30",
    ]);
  });

  it("drops a torn escape tail only from the segment at the delta start", async () => {
    const { term, ops, writeData } = fakeTerminal(40, 20);

    await writeTerminalDeltaReplay(term, {
      delta: ";58mhello[1mX",
      deltaGeometry: { cols: 40, rows: 20 },
      deltaResizes: [{ offset: 9, cols: 60, rows: 20 }],
    }, writeData);

    expect(ops).toEqual(["write hello@40", "resize 60x20", "write [1mX@60"]);
  });

  it("falls back to writing at the current size when the backend sends no geometry", async () => {
    const { term, ops, writeData } = fakeTerminal(80, 24);

    await writeTerminalDeltaReplay(term, { delta: "legacy" }, writeData);

    expect(ops).toEqual(["write legacy@80"]);
  });

  it("clamps out-of-range resize offsets to the delta bounds", async () => {
    const { term, ops, writeData } = fakeTerminal(80, 24);

    await writeTerminalDeltaReplay(term, {
      delta: "xy",
      deltaResizes: [{ offset: 99, cols: 50, rows: 24 }],
    }, writeData);

    expect(ops).toEqual(["write xy@80", "resize 50x24"]);
  });
});
