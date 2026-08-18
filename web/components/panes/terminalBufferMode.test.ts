import { describe, expect, it, vi } from "vitest";
import {
  createAlternateBufferStripper,
  createSgrBackgroundStripper,
  createTerminalDataRenderer,
  detectAlternateBufferTransitions,
  resolveTerminalBufferMode,
  stripAlternateBufferSequences,
  stripSgrBackgroundColors,
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

  // docs/73 §2.x：codex/opencode 默认翻回原生 alt-screen，仅 claude 维持剥离（等 1049 探针数据）。
  describe("resolveTerminalBufferMode", () => {
    it("keeps only claude on strip by default", () => {
      expect(resolveTerminalBufferMode("claude")).toBe("strip");
      expect(resolveTerminalBufferMode("codex")).toBe("native");
      expect(resolveTerminalBufferMode("opencode")).toBe("native");
      expect(resolveTerminalBufferMode("gemini")).toBe("native");
      expect(resolveTerminalBufferMode("none")).toBe("native");
    });

    it("honors per-CLI overrides in either direction", () => {
      expect(resolveTerminalBufferMode("claude", { claude: "native" })).toBe("native");
      expect(resolveTerminalBufferMode("codex", { codex: "strip" })).toBe("strip");
    });

    it("ignores invalid override values and falls back to defaults", () => {
      expect(resolveTerminalBufferMode("claude", { claude: "bogus" })).toBe("strip");
      expect(resolveTerminalBufferMode("codex", { codex: "" })).toBe("native");
      expect(resolveTerminalBufferMode("claude", null)).toBe("strip");
    });
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

  // 1049 探针（docs/73 §2.x 步骤 1）：必须在跨 chunk 重组后计数，逐 chunk 扫 raw 会漏。
  describe("剥离转换探针", () => {
    it("reports a transition split across chunks exactly once", () => {
      const onTransition = vi.fn();
      const stripper = createAlternateBufferStripper(onTransition);
      stripper.push("a\x1b[?10");
      expect(onTransition).not.toHaveBeenCalled();
      stripper.push("49hb");
      expect(onTransition).toHaveBeenCalledTimes(1);
      expect(onTransition).toHaveBeenCalledWith({ mode: "1049", action: "enter" });
    });

    it("reports enter and exit separately and never fires on plain output", () => {
      const onTransition = vi.fn();
      const stripper = createAlternateBufferStripper(onTransition);
      stripper.push("plain\x1b[32mtext\x1b[0m");
      expect(onTransition).not.toHaveBeenCalled();
      stripper.push("\x1b[?1049h tui \x1b[?1049l");
      expect(onTransition).toHaveBeenCalledTimes(2);
      expect(onTransition).toHaveBeenNthCalledWith(1, { mode: "1049", action: "enter" });
      expect(onTransition).toHaveBeenNthCalledWith(2, { mode: "1049", action: "exit" });
    });

    it("wires through createTerminalDataRenderer and stays silent in bypass mode", () => {
      const onStrippedTransition = vi.fn();
      const renderer = createTerminalDataRenderer({ onStrippedTransition });
      renderer.render("\x1b[?1049h", { keepCliOutputInNormalBuffer: false, sessionId: "s1" });
      expect(onStrippedTransition).not.toHaveBeenCalled();
      renderer.render("\x1b[?10", { keepCliOutputInNormalBuffer: true, sessionId: "s1" });
      renderer.render("49h", { keepCliOutputInNormalBuffer: true, sessionId: "s1" });
      expect(onStrippedTransition).toHaveBeenCalledTimes(1);
      expect(onStrippedTransition).toHaveBeenCalledWith({ mode: "1049", action: "enter" });
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

  describe("transparent terminal SGR backgrounds", () => {
    it("removes background colors while preserving foreground styles", () => {
      const stripper = createSgrBackgroundStripper();
      expect(stripper.push("\x1b[1;48;2;29;37;55mBUILD\x1b[49m")).toBe(
        "\x1b[1mBUILD",
      );
      expect(stripper.flush()).toBe("");
    });

    // 回归：40-47 曾漏在剥离表外，而 49（重置）在表内——放行「设置」却剥掉
    // 「重置」，红底横幅会一路染到会话结束（vitest FAIL 用的正是 \x1b[41m）。
    it("strips the full background SGR surface: 40-47, 48, 49, 100-107", () => {
      const stripper = createSgrBackgroundStripper();
      expect(stripper.push("\x1b[41ma\x1b[47mb\x1b[48;5;23mc\x1b[101md\x1b[49me")).toBe(
        "abcde",
      );
    });

    it("keeps set/reset stripping symmetric so a banner cannot bleed onward", () => {
      // 关键不变式：剥掉设置就必须剥掉重置，反之亦然。任一单边剥离都会让
      // 背景状态失衡——单边放行「设置」尤其致命（无界染色，重绘不掉）。
      const stripper = createSgrBackgroundStripper();
      const banner = "\x1b[41m FAIL \x1b[49m\r\nnext line";
      expect(stripper.push(banner)).toBe(" FAIL \r\nnext line");
    });

    it("leaves foreground codes in the 30-37/90-97 ranges alone", () => {
      const stripper = createSgrBackgroundStripper();
      expect(stripper.push("\x1b[31mred-fg\x1b[91mbright-fg\x1b[39m")).toBe(
        "\x1b[31mred-fg\x1b[91mbright-fg\x1b[39m",
      );
    });

    it("handles background sequences split at every byte", () => {
      const input = "a\x1b[38;5;14;48;5;23mBUILD\x1b[100mb";
      const stripper = createSgrBackgroundStripper();
      const output = [...input].map((char) => stripper.push(char)).join("") + stripper.flush();
      expect(output).toBe("a\x1b[38;5;14mBUILDb");
    });

    it("applies the filter through the renderer without changing native output", () => {
      const renderer = createTerminalDataRenderer();
      const transparent = {
        keepCliOutputInNormalBuffer: false,
        sessionId: "s1",
        stripBackgroundColors: true,
      };
      expect(renderer.render("\x1b[48;2;29;37;55mBUILD", transparent)).toBe("BUILD");
      expect(
        renderer.render("\x1b[48;5;23mopaque", { ...transparent, stripBackgroundColors: false }),
      ).toBe("\x1b[48;5;23mopaque");
    });
  });

  // photo 管道（SerializeAddon 成品 VT）的专用变换。不变式是「剥背景、不碰
  // alt-screen」——两者此前捆在 renderTerminalData 上，photo 为了躲 alt-screen
  // 剥离连带躲掉了背景剥离，壁纸模式下恢复一次就把不透明背景写回 cell。
  describe("stripSgrBackgroundColors", () => {
    it("strips SGR background params from a complete VT string", () => {
      expect(stripSgrBackgroundColors("\x1b[1;48;2;255;0;0mFAIL\x1b[49m tail")).toBe(
        "\x1b[1mFAIL tail",
      );
      expect(stripSgrBackgroundColors("\x1b[41mred\x1b[101mbright")).toBe("redbright");
    });

    it("leaves alt-screen sequences untouched", () => {
      // 关键不变式：成品 VT 二次跑 alt-screen 剥离会坏画面（裁决 B），
      // 所以这里必须原样保留 1049/1047/47。
      const photo = "\x1b[?1049h\x1b[48;5;23mbody\x1b[?1049l";
      expect(stripSgrBackgroundColors(photo)).toBe("\x1b[?1049hbody\x1b[?1049l");
    });

    it("preserves foreground colors and non-SGR sequences", () => {
      expect(stripSgrBackgroundColors("\x1b[38;5;14;48;5;23mx\x1b[2J\x1b[H")).toBe(
        "\x1b[38;5;14mx\x1b[2J\x1b[H",
      );
    });

    it("does not swallow bytes when the input ends mid-sequence", () => {
      // 宁可漏剥一个残缺序列，也不能吞字节（成品 VT 正常不该出现，但不得静默丢数据）。
      expect(stripSgrBackgroundColors("done\x1b[48;5")).toBe("done\x1b[48;5");
    });

    it("is a no-op for plain text", () => {
      expect(stripSgrBackgroundColors("plain output\r\n")).toBe("plain output\r\n");
    });
  });
});
