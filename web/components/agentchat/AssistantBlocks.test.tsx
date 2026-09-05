import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentChatItem } from "@/types/agentChat";
import { groupChatItems } from "./chatTurns";
import AssistantBlockView from "./AssistantBlocks";

let seq = 0;
function item(partial: Record<string, unknown>): AgentChatItem {
  seq += 1;
  return { ...partial, id: `i${seq}`, at: 1000 + seq } as unknown as AgentChatItem;
}

function firstBlock(items: AgentChatItem[]) {
  const [turn] = groupChatItems(items);
  if (turn.kind !== "assistant") throw new Error("expected assistant turn");
  return turn.blocks[0];
}

describe("SubagentBlock", () => {
  it("运行中自动展开：显示子 agent 标签、任务描述、内部的思考与工具", () => {
    const block = firstBlock([
      item({ type: "tool_call", call: { toolCallId: "task-1", kind: "think", title: "调查依赖树", status: "in_progress" } }),
      item({ type: "thought", text: "先列出 package.json", parentToolCallId: "task-1", doneAt: 3000 }),
      item({ type: "tool_call", call: { toolCallId: "r1", title: "读 package.json", status: "completed" }, parentToolCallId: "task-1" }),
    ]);
    render(
      <AssistantBlockView
        block={block}
        streaming={false}
        chatId="c"
        onOpenLocation={vi.fn()}
        onPlanToTodo={vi.fn()}
      />,
    );

    expect(screen.getByText("子 agent")).toBeVisible();
    expect(screen.getByText("调查依赖树")).toBeVisible();
    expect(screen.getByText(/思考了/)).toBeVisible();
    expect(screen.getByText("读 package.json")).toBeVisible();
  });

  it("完结后折叠，点开可见子 agent 正文与最终汇报", () => {
    const block = firstBlock([
      item({
        type: "tool_call",
        call: {
          toolCallId: "task-1",
          title: "写总结",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "最终汇报内容" } }],
        },
      }),
      item({ type: "assistant", text: "子 agent 中途说的话", parentToolCallId: "task-1" }),
    ]);
    render(
      <AssistantBlockView
        block={block}
        streaming={false}
        chatId="c"
        onOpenLocation={vi.fn()}
        onPlanToTodo={vi.fn()}
      />,
    );

    expect(screen.queryByText("子 agent 中途说的话")).toBeNull();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("子 agent 中途说的话")).toBeVisible();
    expect(screen.getByText("汇报")).toBeVisible();
    expect(screen.getByText("最终汇报内容")).toBeVisible();
  });
});
