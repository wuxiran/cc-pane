import { describe, expect, it } from "vitest";
import { finalizeTranscript, removeFillerWords } from "./voiceTranscript";

describe("removeFillerWords", () => {
  it.each([
    ["嗯，我想改一下布局。", "我想改一下布局。"],
    ["呃我想看看日志", "我想看看日志"],
    ["我想，嗯，先跑测试", "我想，先跑测试"],
    ["嗯，呃，好的", "好的"],
    ["Um, let's run the tests", "let's run the tests"],
    ["so uh I think it works", "so I think it works"],
    ["额度不够了", "额度不够了"],
    ["这是额外的配置", "这是额外的配置"],
    ["umbrella is fine", "umbrella is fine"],
    ["嗯", ""],
  ])("%s → %s", (input, expected) => {
    expect(removeFillerWords(input)).toBe(expected);
  });
});

describe("finalizeTranscript", () => {
  it("只在开启时去语气词", () => {
    expect(finalizeTranscript(" 嗯，你好 ", { removeFillerWords: true })).toBe("你好");
    expect(finalizeTranscript(" 嗯，你好 ", { removeFillerWords: false })).toBe("嗯，你好");
    expect(finalizeTranscript(" 你好 ", undefined)).toBe("你好");
  });
});
