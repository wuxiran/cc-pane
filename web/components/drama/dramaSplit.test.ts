import { describe, expect, it } from "vitest";
import { SPLIT_SYSTEM_PROMPT, parseShotsReply } from "./dramaSplit";

describe("parseShotsReply", () => {
  it("从带前后废话的回复里抽出 JSON 数组，字段缺失/类型错则降级为空串", () => {
    const reply = `Sure, here you go:\n[{"title":"开场","dialogue":"你好","prompt":"a city at dawn"},{"title":42,"prompt":null},"junk",null]\nDone.`;
    expect(parseShotsReply(reply)).toEqual([
      { title: "开场", dialogue: "你好", prompt: "a city at dawn" },
      { title: "", dialogue: "", prompt: "" },
    ]);
  });

  it("没有数组或不是数组时抛错", () => {
    expect(() => parseShotsReply("no json here")).toThrow(/No JSON array/);
    expect(() => parseShotsReply('[1, 2')).toThrow();
  });

  it("系统提示词要求纯 JSON 数组输出", () => {
    expect(SPLIT_SYSTEM_PROMPT).toMatch(/ONLY a JSON array/);
  });
});
