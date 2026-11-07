import { describe, expect, it } from "vitest";
import { filterChatHistory } from "./DockChatHistory";

const entry = (acpSessionId: string, cwd: string, title: string, updatedAt: number) =>
  ({ acpSessionId, engineId: "codex", cwd, title, createdAt: 0, updatedAt });

describe("filterChatHistory", () => {
  const entries = [
    entry("a", "/other", "旧的别处", 1),
    entry("b", "/repo", "当前项目较旧", 2),
    entry("c", "/other", "别处最新", 9),
    entry("d", "/repo/", "当前项目最新", 5),
    entry("", "/repo", "没有会话号", 10),
  ];

  it("当前项目排前面，组内按更新时间倒序，丢掉没有会话号的", () => {
    expect(filterChatHistory(entries, "", "/repo").map((item) => item.acpSessionId)).toEqual(["d", "b", "c", "a"]);
  });

  it("关键字匹配标题或项目名", () => {
    expect(filterChatHistory(entries, "最新", null).map((item) => item.acpSessionId)).toEqual(["c", "d"]);
    expect(filterChatHistory(entries, "other", null).map((item) => item.acpSessionId)).toEqual(["c", "a"]);
  });
});
