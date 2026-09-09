import { describe, expect, it } from "vitest";
import { writeTerminalReplay } from "./terminalReplayChunks";
import { stripSgrBackgroundColors } from "./terminalBufferMode";

describe("terminal replay scheduling", () => {
  it("preserves Unicode and CSI color transforms at chunk boundaries", async () => {
    const source = `${"x".repeat(254)}🙂\x1b[48;2;41;41;41m中文\x1b[49m\r\n`.repeat(40);
    const chunks: string[] = [];
    await writeTerminalReplay(source, async chunk => { chunks.push(chunk); }, { chunkChars: 256 });
    expect(chunks.join("")).toBe(source);
    expect(chunks.map(stripSgrBackgroundColors).join("")).toBe(stripSgrBackgroundColors(source));
    expect(chunks.slice(0, -1).every(chunk => !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
    expect(Math.max(...chunks.map(chunk => chunk.length))).toBeLessThanOrEqual(256);
  });

  it("yields within a work budget and does not enqueue the next chunk until its callback completes", async () => {
    let now = 0;
    let writes = 0;
    let yields = 0;
    let resolveFirst!: () => void;
    const first = new Promise<void>(resolve => { resolveFirst = resolve; });
    const pending = writeTerminalReplay("x".repeat(768), async () => {
      writes++; now += 9;
      if (writes === 1) await first;
    }, { chunkChars: 256, now: () => now, yieldToMain: async () => { yields++; } });
    await Promise.resolve();
    expect(writes).toBe(1);
    resolveFirst(); await pending;
    expect(writes).toBe(3);
    expect(yields).toBe(2);
  });

  it("stops before writing into a replacement or unmounted terminal", async () => {
    let mounted = true;
    let writes = 0;
    await expect(writeTerminalReplay("x".repeat(512), async () => {
      writes++; mounted = false;
    }, { chunkChars: 256, canWrite: () => mounted })).rejects.toThrow("cancelled");
    expect(writes).toBe(1);
  });

  it("propagates write failures without continuing the replay", async () => {
    let writes = 0;
    await expect(writeTerminalReplay("x".repeat(512), async () => {
      writes++; throw new Error("renderer closed");
    }, { chunkChars: 256 })).rejects.toThrow("renderer closed");
    expect(writes).toBe(1);
  });
  it("does not report completion when disposal happens during the final write", async () => {
    let mounted = true;
    await expect(writeTerminalReplay("final", async () => { mounted = false; },
      { canWrite: () => mounted })).rejects.toThrow("cancelled");
  });
});
