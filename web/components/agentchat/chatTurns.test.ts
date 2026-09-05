import { describe, expect, it } from "vitest";
import type { AgentChatItem } from "@/types/agentChat";
import { groupChatItems, summarizeTools } from "./chatTurns";

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

let seq = 0;
function item<P extends DistributiveOmit<AgentChatItem, "id" | "at">>(
  partial: P,
): Extract<AgentChatItem, { type: P["type"] }> {
  seq += 1;
  return { ...partial, id: `i${seq}`, at: 1000 + seq } as unknown as Extract<
    AgentChatItem,
    { type: P["type"] }
  >;
}

describe("groupChatItems", () => {
  it("用户消息与 notice 各自成回合，agent 产出归并进一个回合", () => {
    const items: AgentChatItem[] = [
      item({ type: "user", text: "你好" }),
      item({ type: "thought", text: "想一想" }),
      item({ type: "tool_call", call: { toolCallId: "t1", status: "completed" } }),
      item({ type: "tool_call", call: { toolCallId: "t2", status: "in_progress" } }),
      item({ type: "assistant", text: "结果" }),
      item({ type: "notice", text: "[cancelled]" }),
      item({ type: "user", text: "继续" }),
      item({ type: "assistant", text: "好的" }),
    ];

    const turns = groupChatItems(items);

    expect(turns.map((turn) => turn.kind)).toEqual([
      "user",
      "assistant",
      "notice",
      "user",
      "assistant",
    ]);
    const first = turns[1];
    expect(first.kind).toBe("assistant");
    if (first.kind !== "assistant") return;
    expect(first.at).toBe(items[1].at);
    expect(first.blocks.map((block) => block.kind)).toEqual(["thought", "tools", "text"]);
    const tools = first.blocks[1];
    if (tools.kind !== "tools") throw new Error("expected tools block");
    expect(tools.items.map((tool) => tool.call.toolCallId)).toEqual(["t1", "t2"]);
  });

  it("被正文打断的工具卡分成两组", () => {
    const items: AgentChatItem[] = [
      item({ type: "tool_call", call: { toolCallId: "a" } }),
      item({ type: "assistant", text: "中间说明" }),
      item({ type: "tool_call", call: { toolCallId: "b" } }),
    ];

    const [turn] = groupChatItems(items);
    if (turn.kind !== "assistant") throw new Error("expected assistant turn");
    expect(turn.blocks.map((block) => block.kind)).toEqual(["tools", "text", "tools"]);
  });

  it("没有条目时返回空", () => {
    expect(groupChatItems([])).toEqual([]);
  });

  it("带 parentToolCallId 的条目嵌到派出它的 Task 卡下，Task 卡不再进工具组", () => {
    const items: AgentChatItem[] = [
      item({ type: "tool_call", call: { toolCallId: "read-1", status: "completed" } }),
      item({ type: "tool_call", call: { toolCallId: "task-1", kind: "think", title: "查依赖", status: "in_progress" } }),
      item({ type: "thought", text: "子 agent 在想", parentToolCallId: "task-1" }),
      item({ type: "tool_call", call: { toolCallId: "grep-1", status: "completed" }, parentToolCallId: "task-1" }),
      item({ type: "tool_call", call: { toolCallId: "grep-2", status: "completed" }, parentToolCallId: "task-1" }),
      item({ type: "assistant", text: "子 agent 的话", parentToolCallId: "task-1" }),
      item({ type: "assistant", text: "主 agent 的话" }),
    ];

    const [turn] = groupChatItems(items);
    if (turn.kind !== "assistant") throw new Error("expected assistant turn");
    expect(turn.blocks.map((block) => block.kind)).toEqual(["tools", "subagent", "text"]);

    const subagent = turn.blocks[1];
    if (subagent.kind !== "subagent") throw new Error("expected subagent block");
    expect(subagent.task.call.toolCallId).toBe("task-1");
    expect(subagent.blocks.map((block) => block.kind)).toEqual(["thought", "tools", "text"]);
    const tools = subagent.blocks[1];
    if (tools.kind !== "tools") throw new Error("expected tools block");
    expect(tools.items.map((tool) => tool.call.toolCallId)).toEqual(["grep-1", "grep-2"]);

    const top = turn.blocks[0];
    if (top.kind !== "tools") throw new Error("expected tools block");
    expect(top.items.map((tool) => tool.call.toolCallId)).toEqual(["read-1"]);
  });

  it("子 agent 再派子 agent 时递归嵌套", () => {
    const items: AgentChatItem[] = [
      item({ type: "tool_call", call: { toolCallId: "task-a" } }),
      item({ type: "tool_call", call: { toolCallId: "task-b" }, parentToolCallId: "task-a" }),
      item({ type: "assistant", text: "孙", parentToolCallId: "task-b" }),
    ];

    const [turn] = groupChatItems(items);
    if (turn.kind !== "assistant") throw new Error("expected assistant turn");
    const a = turn.blocks[0];
    if (a.kind !== "subagent") throw new Error("expected subagent a");
    const b = a.blocks[0];
    if (b.kind !== "subagent") throw new Error("expected subagent b");
    expect(b.blocks[0].kind).toBe("text");
  });

  it("父卡缺席时子条目退回顶层平铺，不丢内容", () => {
    const items: AgentChatItem[] = [
      item({ type: "assistant", text: "孤儿", parentToolCallId: "ghost" }),
    ];
    const [turn] = groupChatItems(items);
    if (turn.kind !== "assistant") throw new Error("expected assistant turn");
    expect(turn.blocks.map((block) => block.kind)).toEqual(["text"]);
  });

  it("子 agent 产出晚于派出回合到达时仍归到原 Task 卡", () => {
    const items: AgentChatItem[] = [
      item({ type: "tool_call", call: { toolCallId: "task-1", status: "in_progress" } }),
      item({ type: "assistant", text: "先回一句" }),
      item({ type: "user", text: "继续" }),
      item({ type: "assistant", text: "后台子 agent 汇报", parentToolCallId: "task-1" }),
    ];
    const turns = groupChatItems(items);
    expect(turns.map((turn) => turn.kind)).toEqual(["assistant", "user"]);
    const first = turns[0];
    if (first.kind !== "assistant") throw new Error("expected assistant turn");
    const subagent = first.blocks[0];
    if (subagent.kind !== "subagent") throw new Error("expected subagent block");
    expect(subagent.blocks.map((block) => block.kind)).toEqual(["text"]);
  });
});

describe("summarizeTools", () => {
  it("统计进行中与失败数量，缺省状态按进行中计", () => {
    const summary = summarizeTools([
      item({ type: "tool_call", call: { toolCallId: "1" } }),
      item({ type: "tool_call", call: { toolCallId: "2", status: "in_progress" } }),
      item({ type: "tool_call", call: { toolCallId: "3", status: "completed" } }),
      item({ type: "tool_call", call: { toolCallId: "4", status: "failed" } }),
    ]);
    expect(summary).toEqual({ total: 4, running: 2, failed: 1 });
  });
});
