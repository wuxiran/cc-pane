import { beforeEach, describe, expect, it } from "vitest";
import { useAgentChatStore } from "./useAgentChatStore";
import type { AcpChatSnapshot } from "@/types/agentChat";

const CHAT = "tab-acp-test";

function snapshot(patch: Partial<AcpChatSnapshot> = {}): AcpChatSnapshot {
  return {
    chatId: CHAT,
    engineId: "claude",
    phase: "ready",
    ...patch,
  };
}

beforeEach(() => {
  useAgentChatStore.getState().dropChat(CHAT);
});

describe("useAgentChatStore", () => {
  it("流式文本邻接合并、被工具卡打断后开新气泡", () => {
    const store = useAgentChatStore.getState();
    store.appendStreamText(CHAT, "assistant", "你好");
    store.appendStreamText(CHAT, "assistant", "，世界");
    store.applySessionUpdate(CHAT, {
      update: { sessionUpdate: "tool_call", toolCallId: "call-1", title: "读文件" },
    });
    store.appendStreamText(CHAT, "assistant", "继续");

    const items = useAgentChatStore.getState().chats[CHAT].items;
    expect(items.map((item) => item.type)).toEqual(["assistant", "tool_call", "assistant"]);
    expect(items[0].type === "assistant" && items[0].text).toBe("你好，世界");
    expect(items[2].type === "assistant" && items[2].text).toBe("继续");
  });

  it("tool_call_update 按 toolCallId 就地合并，content 整表替换", () => {
    const store = useAgentChatStore.getState();
    store.applySessionUpdate(CHAT, {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "跑命令",
        status: "in_progress",
        content: [{ type: "content", content: { type: "text", text: "old" } }],
      },
    });
    store.applySessionUpdate(CHAT, {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "new" } }],
      },
    });

    const items = useAgentChatStore.getState().chats[CHAT].items;
    expect(items).toHaveLength(1);
    const item = items[0];
    if (item.type !== "tool_call") throw new Error("expected tool_call item");
    expect(item.call.status).toBe("completed");
    expect(item.call.title).toBe("跑命令");
    expect(item.call.content).toHaveLength(1);
    expect(item.call.content?.[0]?.content?.text).toBe("new");
  });

  it("先到 tool_call_update 也按新卡片容错落位", () => {
    useAgentChatStore.getState().applySessionUpdate(CHAT, {
      update: { sessionUpdate: "tool_call_update", toolCallId: "orphan", status: "failed" },
    });
    const items = useAgentChatStore.getState().chats[CHAT].items;
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("tool_call");
  });

  it("plan 整表替换同一个条目而不是追加", () => {
    const store = useAgentChatStore.getState();
    store.applySessionUpdate(CHAT, {
      update: { sessionUpdate: "plan", entries: [{ content: "步骤一", status: "pending" }] },
    });
    store.applySessionUpdate(CHAT, {
      update: {
        sessionUpdate: "plan",
        entries: [
          { content: "步骤一", status: "completed" },
          { content: "步骤二", status: "in_progress" },
        ],
      },
    });

    const items = useAgentChatStore.getState().chats[CHAT].items;
    const plans = items.filter((item) => item.type === "plan");
    expect(plans).toHaveLength(1);
    expect(plans[0].type === "plan" && plans[0].entries).toHaveLength(2);
  });

  it("未知 sessionUpdate 以 notice 可见且同类只提示一次", () => {
    const store = useAgentChatStore.getState();
    store.applySessionUpdate(CHAT, { update: { sessionUpdate: "future_variant" } });
    store.applySessionUpdate(CHAT, { update: { sessionUpdate: "future_variant" } });
    const notices = useAgentChatStore
      .getState()
      .chats[CHAT].items.filter((item) => item.type === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0].type === "notice" && notices[0].text).toContain("future_variant");
  });

  it("turn_ended 清掉悬挂的审批卡，非 end_turn 追加 notice", () => {
    const store = useAgentChatStore.getState();
    store.setPermission(CHAT, { requestKey: "n1", params: { options: [] } });
    store.turnEnded(CHAT, "cancelled");
    const chat = useAgentChatStore.getState().chats[CHAT];
    expect(chat.pendingPermission).toBeNull();
    expect(chat.items.some((item) => item.type === "notice" && item.text.includes("cancelled"))).toBe(
      true,
    );
  });

  it("快照错误只在变化时进消息流一次", () => {
    const store = useAgentChatStore.getState();
    store.setSnapshot(CHAT, snapshot({ phase: "failed", error: "boom" }));
    store.setSnapshot(CHAT, snapshot({ phase: "failed", error: "boom" }));
    const notices = useAgentChatStore
      .getState()
      .chats[CHAT].items.filter((item) => item.type === "notice");
    expect(notices).toHaveLength(1);
  });
});
