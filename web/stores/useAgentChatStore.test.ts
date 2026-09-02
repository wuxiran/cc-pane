import { beforeEach, describe, expect, it } from "vitest";
import { describeAutoApproved, useAgentChatStore } from "./useAgentChatStore";
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
  it("terminal_output 按 terminalId 整体替换，不进消息流", () => {
    const store = useAgentChatStore.getState();
    store.setSnapshot(CHAT, snapshot());
    store.setTerminalOutput(CHAT, { terminalId: "term-1", output: "hel", truncated: false });
    store.setTerminalOutput(CHAT, {
      terminalId: "term-1",
      output: "hello\n",
      truncated: false,
      exitStatus: { exitCode: 0 },
    });
    const chat = useAgentChatStore.getState().chats[CHAT];
    expect(chat.terminals["term-1"].output).toBe("hello\n");
    expect(chat.terminals["term-1"].exitStatus?.exitCode).toBe(0);
    expect(chat.items).toHaveLength(0);
  });

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

  it("session_info_update / config_option_update 不进消息流（真机实测的常规更新）", () => {
    const store = useAgentChatStore.getState();
    store.applySessionUpdate(CHAT, {
      update: { sessionUpdate: "session_info_update", title: "Repo walkthrough", updatedAt: 1 },
    });
    store.applySessionUpdate(CHAT, {
      update: { sessionUpdate: "config_option_update", configOptions: [] },
    });
    expect(useAgentChatStore.getState().chats[CHAT].items).toEqual([]);
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

  it("available_commands_update 整表替换命令目录", () => {
    const store = useAgentChatStore.getState();
    store.applySessionUpdate(CHAT, {
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "compact", description: "压缩上下文" }],
      },
    });
    store.applySessionUpdate(CHAT, {
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "review" }],
      },
    });
    const commands = useAgentChatStore.getState().chats[CHAT].availableCommands;
    expect(commands).toHaveLength(1);
    expect(commands[0].name).toBe("review");
  });

  it("usage_update 整体替换用量，非法 size 忽略且不产生 notice", () => {
    const store = useAgentChatStore.getState();
    store.applySessionUpdate(CHAT, {
      update: { sessionUpdate: "usage_update", used: 53000, size: 200000 },
    });
    expect(useAgentChatStore.getState().chats[CHAT].usage).toEqual({
      used: 53000,
      size: 200000,
      cost: null,
    });
    store.applySessionUpdate(CHAT, {
      update: {
        sessionUpdate: "usage_update",
        used: 60000,
        size: 200000,
        cost: { amount: 0.42, currency: "USD" },
      },
    });
    expect(useAgentChatStore.getState().chats[CHAT].usage?.cost).toEqual({
      amount: 0.42,
      currency: "USD",
    });
    store.applySessionUpdate(CHAT, {
      update: { sessionUpdate: "usage_update", used: 1, size: 0 },
    });
    const chat = useAgentChatStore.getState().chats[CHAT];
    expect(chat.usage?.used).toBe(60000);
    expect(chat.items.some((item) => item.type === "notice")).toBe(false);
  });

  it("回放期（非 generating）收下 user_message_chunk，活回合丢弃", () => {
    const store = useAgentChatStore.getState();
    // 回放：starting 相位（或无快照）→ 入列
    store.applySessionUpdate(CHAT, {
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "历史消息" } },
    });
    expect(
      useAgentChatStore.getState().chats[CHAT].items.filter((item) => item.type === "user"),
    ).toHaveLength(1);
    // 活回合：generating 相位 → 回显丢弃
    store.setSnapshot(CHAT, snapshot({ phase: "generating" }));
    store.applySessionUpdate(CHAT, {
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "回显" } },
    });
    const users = useAgentChatStore
      .getState()
      .chats[CHAT].items.filter((item) => item.type === "user");
    expect(users).toHaveLength(1);
    expect(users[0].type === "user" && users[0].text).toBe("历史消息");
  });

  it("自动放行通知转成留痕文本，优先用后端解析出的 kind", () => {
    // Claude 实测 payload：请求自带 kind。
    expect(
      describeAutoApproved({
        method: "ccpanes/auto-approved",
        resolvedKind: "edit",
        params: { toolCall: { title: "Write probe.txt", kind: "edit" } },
      }),
    ).toBe("已自动放行 · Write probe.txt（edit）");
    // Kimi 形态：请求无 kind，后端按标题推断出 execute。
    expect(
      describeAutoApproved({
        method: "ccpanes/auto-approved",
        resolvedKind: "execute",
        params: { toolCall: { title: "Shell: echo hi" } },
      }),
    ).toBe("已自动放行 · Shell: echo hi（execute）");
    expect(describeAutoApproved({ method: "ccpanes/auto-approved", params: {} })).toBe(
      "已自动放行（other）",
    );
    expect(describeAutoApproved({ method: "ccpanes/load-failed" })).toBeNull();
    expect(describeAutoApproved(null)).toBeNull();
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
