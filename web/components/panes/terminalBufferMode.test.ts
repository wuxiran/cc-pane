import { describe, expect, it } from "vitest";
import {
  createAlternateBufferStripper,
  createTerminalDataRenderer,
  detectAlternateBufferTransitions,
  shouldKeepCliOutputInNormalBuffer,
  stripAlternateBufferSequences,
} from "./terminalBufferMode";

describe("terminalBufferMode", () => {
  it("detects alternate buffer enter and exit sequences", () => {
    expect(detectAlternateBufferTransitions("\x1b[?1049hbody\x1b[?1049l")).toEqual([
      { mode: "1049", action: "enter" },
      { mode: "1049", action: "exit" },
    ]);
  });

  it("strips alternate buffer sequences without changing content", () => {
    expect(stripAlternateBufferSequences("a\x1b[?1049hb\x1b[?1049lc")).toBe("abc");
  });

  it("keeps agent CLI output in the normal buffer", () => {
    expect(shouldKeepCliOutputInNormalBuffer("codex")).toBe(true);
    expect(shouldKeepCliOutputInNormalBuffer("claude")).toBe(true);
    expect(shouldKeepCliOutputInNormalBuffer("gemini")).toBe(false);
    expect(shouldKeepCliOutputInNormalBuffer("none")).toBe(false);
  });

  describe("组合参数形式", () => {
    it("detects alternate buffer modes inside a parameter list", () => {
      expect(detectAlternateBufferTransitions("\x1b[?1049;25h")).toEqual([
        { mode: "1049", action: "enter" },
      ]);
      expect(detectAlternateBufferTransitions("\x1b[?25;1047l")).toEqual([
        { mode: "1047", action: "exit" },
      ]);
    });

    it("strips only the alternate buffer params and keeps the rest", () => {
      expect(stripAlternateBufferSequences("a\x1b[?1049;25hb")).toBe("a\x1b[?25hb");
      expect(stripAlternateBufferSequences("\x1b[?25;1049;7l")).toBe("\x1b[?25;7l");
    });

    it("drops the whole sequence when every param is an alternate buffer mode", () => {
      expect(stripAlternateBufferSequences("x\x1b[?1049;47hy")).toBe("xy");
    });

    it("leaves unrelated private modes untouched", () => {
      expect(stripAlternateBufferSequences("\x1b[?25h\x1b[?25l")).toBe("\x1b[?25h\x1b[?25l");
      expect(detectAlternateBufferTransitions("\x1b[?25h")).toEqual([]);
    });

    it("does not treat a substring like 11049 as mode 1049", () => {
      expect(stripAlternateBufferSequences("\x1b[?11049h")).toBe("\x1b[?11049h");
      expect(detectAlternateBufferTransitions("\x1b[?11049h")).toEqual([]);
    });
  });

  describe("跨分片截断", () => {
    it("strips a sequence split across two chunks", () => {
      const stripper = createAlternateBufferStripper();
      expect(stripper.push("a\x1b[?10")).toBe("a");
      expect(stripper.push("49hb")).toBe("b");
      expect(stripper.flush()).toBe("");
    });

    it("strips a sequence split byte by byte", () => {
      const stripper = createAlternateBufferStripper();
      const input = "a\x1b[?1049hb\x1b[?1049lc";
      const output = [...input].map((char) => stripper.push(char)).join("") + stripper.flush();
      expect(output).toBe("abc");
    });

    it("handles a split at every possible boundary", () => {
      const input = "start\x1b[?1049hmid\x1b[?1049lend";
      for (let cut = 0; cut <= input.length; cut += 1) {
        const stripper = createAlternateBufferStripper();
        const output =
          stripper.push(input.slice(0, cut)) + stripper.push(input.slice(cut)) + stripper.flush();
        expect(output, `split at ${cut}`).toBe("startmidend");
      }
    });

    it("handles a split inside a combined parameter list", () => {
      const stripper = createAlternateBufferStripper();
      expect(stripper.push("\x1b[?1049;")).toBe("");
      expect(stripper.push("25h!")).toBe("\x1b[?25h!");
    });

    it("does not withhold ordinary output", () => {
      const stripper = createAlternateBufferStripper();
      expect(stripper.push("plain text")).toBe("plain text");
      expect(stripper.push("\x1b[32mgreen\x1b[0m")).toBe("\x1b[32mgreen\x1b[0m");
      expect(stripper.flush()).toBe("");
    });

    it("flushes a dangling escape prefix instead of swallowing it", () => {
      const stripper = createAlternateBufferStripper();
      expect(stripper.push("tail\x1b[?10")).toBe("tail");
      expect(stripper.flush()).toBe("\x1b[?10");
    });

    it("releases the buffer once the tail cannot be a private mode sequence", () => {
      const stripper = createAlternateBufferStripper();
      expect(stripper.push("\x1b[?")).toBe("");
      // 后续字节不是数字/分号，说明这不是私有模式序列——必须放行而不是继续扣留。
      expect(stripper.push("done")).toBe("\x1b[?done");
    });

    it("does not withhold a tail longer than the partial buffer cap", () => {
      const stripper = createAlternateBufferStripper();
      const longTail = `\x1b[?${"1".repeat(64)}`;
      expect(stripper.push(longTail)).toBe(longTail);
      expect(stripper.flush()).toBe("");
    });
  });

  // 这一组对应 TerminalView.renderTerminalData 的实际接线行为。
  describe("createTerminalDataRenderer（生产接线层）", () => {
    const keep = (sessionId: string | null = "s1") => ({
      keepCliOutputInNormalBuffer: true,
      sessionId,
    });

    it("strips a sequence split across two chunks", () => {
      const renderer = createTerminalDataRenderer();
      expect(renderer.render("a\x1b[?10", keep())).toBe("a");
      expect(renderer.render("49hb", keep())).toBe("b");
    });

    it("passes data through untouched when the CLI does not need normal buffer", () => {
      const renderer = createTerminalDataRenderer();
      const bypass = { keepCliOutputInNormalBuffer: false, sessionId: "s1" };
      expect(renderer.render("a\x1b[?1049hb", bypass)).toBe("a\x1b[?1049hb");
      // 分片的序列在旁路下也必须原样透传，不得被扣留。
      expect(renderer.render("\x1b[?10", bypass)).toBe("\x1b[?10");
      expect(renderer.render("49h", bypass)).toBe("49h");
    });

    it("does not let bypassed data pollute the stripper afterwards", () => {
      const renderer = createTerminalDataRenderer();
      // 旁路期间喂了一个半截序列……
      expect(renderer.render("x\x1b[?10", { keepCliOutputInNormalBuffer: false, sessionId: "s1" }))
        .toBe("x\x1b[?10");
      // ……切回剥离模式后不得有残留拼进来。
      expect(renderer.render("49h!", keep())).toBe("49h!");
    });

    it("drops the withheld tail when the session changes", () => {
      const renderer = createTerminalDataRenderer();
      expect(renderer.render("old\x1b[?10", keep("s1"))).toBe("old");
      // 新会话不应看到上一会话扣留的 "\x1b[?10"。
      expect(renderer.render("49hnew", keep("s2"))).toBe("49hnew");
    });

    it("treats null -> sessionId as the same stream, not a switch", () => {
      const renderer = createTerminalDataRenderer();
      // attach 回放先于 currentSessionIdRef 赋值发生，此时 sessionId 还是 null。
      expect(renderer.render("a\x1b[?10", keep(null))).toBe("a");
      expect(renderer.render("49hb", keep("s1"))).toBe("b");
    });

    it("keeps stripping across many chunks of one session", () => {
      const renderer = createTerminalDataRenderer();
      const input = "start\x1b[?1049hmid\x1b[?1049lend";
      const output = [...input].map((char) => renderer.render(char, keep())).join("");
      // 末尾无残留，逐字节喂入也能完整剥离。
      expect(output).toBe("startmidend");
    });
  });
});
