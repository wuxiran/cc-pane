import { describe, expect, it } from "vitest";
import { dropLeadingEscapeTail, writeTerminalReplay } from "./terminalReplayChunks";
import { stripSgrBackgroundColors } from "./terminalBufferMode";

describe("terminal replay scheduling", () => {
  it("preserves Unicode and CSI color transforms at chunk boundaries", async () => {
    const source = `${"x".repeat(254)}🙂\x1b[48;2;41;41;41m中文\x1b[49m\r\n`.repeat(40);
    const chunks: string[] = [];
    await writeTerminalReplay(source, async chunk => { chunks.push(chunk); }, { chunkChars: 256 });
    expect(chunks.join("")).toBe(source);
    expect(chunks.map((chunk) => stripSgrBackgroundColors(chunk)).join("")).toBe(stripSgrBackgroundColors(source));
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

describe("dropLeadingEscapeTail（回放窗口断头尾清理）", () => {
  it("drops headless CSI tails at a window start", () => {
    // conpty truecolor 组合 SGR 丢 ESC 头——codex 输入行乱码的活体形态。
    expect(dropLeadingEscapeTail("[38;2;68;70;75;48;2;50;55;58mrest")).toBe("rest");
    expect(dropLeadingEscapeTail(";58mrest")).toBe("rest");
    expect(dropLeadingEscapeTail("8;2;50;55;58mrest")).toBe("rest");
    expect(dropLeadingEscapeTail("?1049hrest")).toBe("rest");
  });

  it("drops headless OSC tails up to BEL", () => {
    expect(dropLeadingEscapeTail("8;;https://x\x07rest")).toBe("rest");
    expect(dropLeadingEscapeTail("]8;;https://x\x07rest")).toBe("rest");
    expect(dropLeadingEscapeTail("0;window title\x07rest")).toBe("rest");
  });

  it("keeps aligned starts and ordinary prose", () => {
    expect(dropLeadingEscapeTail("\x1b[38;2;1;2;3mrest")).toBe("\x1b[38;2;1;2;3mrest");
    expect(dropLeadingEscapeTail("[INFO] building rest")).toBe("[INFO] building rest");
    expect(dropLeadingEscapeTail("2026-09-14 log line")).toBe("2026-09-14 log line");
    expect(dropLeadingEscapeTail("hello world")).toBe("hello world");
    expect(dropLeadingEscapeTail("")).toBe("");
  });

  it("does not mistake a CSI tail followed by a real OSC for an OSC tail", () => {
    // CSI 残尾后面跟着真 OSC：只切 CSI 尾，OSC 及其后正文原样保留。
    expect(dropLeadingEscapeTail(";58m ok \x1b]0;t\x07")).toBe(" ok \x1b]0;t\x07");
  });

  it("writeTerminalReplay drops the leading tail only when asked", async () => {
    const source = ";58mrest-of-delta";
    const withOption: string[] = [];
    await writeTerminalReplay(source, async chunk => { withOption.push(chunk); },
      { dropLeadingEscapeTail: true });
    expect(withOption.join("")).toBe("rest-of-delta");

    const withoutOption: string[] = [];
    await writeTerminalReplay(source, async chunk => { withoutOption.push(chunk); });
    expect(withoutOption.join("")).toBe(source);
  });
});
