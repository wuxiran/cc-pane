import { beforeEach, describe, expect, it } from "vitest";
import { selectAskIds, selectMentions, useBotAskStore } from "./useBotAskStore";

const target = { name: "Codex", avatar: "", color: "" };

function start(id: string, fromChatId = "tab-a") {
  useBotAskStore.getState().start({ id, fromChatId, text: "hi", target, botId: null });
}

beforeEach(() => {
  useBotAskStore.setState({ asks: {}, byChat: {}, mentions: {}, bots: null, engines: null });
});

describe("useBotAskStore 委托卡片", () => {
  it("按来源对话记录顺序，完成后状态与回复保留", () => {
    start("a1");
    start("a2");
    start("b1", "tab-b");
    const state = useBotAskStore.getState();
    expect(selectAskIds("tab-a")(state)).toEqual(["a1", "a2"]);
    expect(selectAskIds("tab-b")(state)).toEqual(["b1"]);
    expect(state.asks.a1).toMatchObject({ status: "running", admitted: false, cancelRequested: false });

    state.bindBot("a1", "bot-1", { name: "Codex", avatar: "🤖", color: "#000" });
    state.markAdmitted("a1");
    state.finish("a1", "done", false);
    expect(useBotAskStore.getState().asks.a1).toMatchObject({
      botId: "bot-1", admitted: true, status: "done", reply: "done", target: { avatar: "🤖" },
    });
  });

  it("结束后的卡片不再被改写（迟到的失败 / 取消不覆盖结果）", () => {
    start("a1");
    const state = useBotAskStore.getState();
    state.finish("a1", "ok", false);
    state.fail("a1", "late error");
    state.requestCancel("a1");
    state.markAdmitted("a1");
    expect(useBotAskStore.getState().asks.a1).toMatchObject({ status: "done", reply: "ok", cancelRequested: false, admitted: false });
  });

  it("取消与失败", () => {
    start("a1");
    start("a2");
    const state = useBotAskStore.getState();
    state.requestCancel("a1");
    state.finish("a1", "", true);
    state.fail("a2", "boom");
    const asks = useBotAskStore.getState().asks;
    expect(asks.a1).toMatchObject({ status: "cancelled", cancelRequested: true });
    expect(asks.a2).toMatchObject({ status: "failed", error: "boom" });
  });

  it("关闭卡片后清掉空的对话索引；未知 id 不报错", () => {
    start("a1");
    const state = useBotAskStore.getState();
    state.dismiss("a1");
    state.dismiss("missing");
    state.markAdmitted("missing");
    expect(useBotAskStore.getState().asks).toEqual({});
    expect(useBotAskStore.getState().byChat).toEqual({});
  });

  it("selector 缺省返回同一个空数组（稳定引用）", () => {
    const state = useBotAskStore.getState();
    expect(selectAskIds("none")(state)).toBe(selectAskIds("other")(state));
    expect(selectMentions("none")(state)).toBe(selectMentions("other")(state));
  });
});

describe("useBotAskStore 提及", () => {
  it("同 token 去重，发送后清空", () => {
    const state = useBotAskStore.getState();
    const mention = { kind: "engine" as const, token: "Codex", engineId: "codex", name: "Codex" };
    state.addMention("tab-a", mention);
    state.addMention("tab-a", mention);
    expect(useBotAskStore.getState().mentions["tab-a"]).toHaveLength(1);
    state.clearMentions("tab-a");
    expect(selectMentions("tab-a")(useBotAskStore.getState())).toEqual([]);
  });
});
