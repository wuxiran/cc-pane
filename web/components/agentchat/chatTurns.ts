// 平铺的消息条目 → 回合结构。纯函数，供 AgentChatTabContent 渲染层使用。
//
// 一个 assistant 回合 = 两条用户消息之间 agent 产出的全部条目（思考、工具卡、
// 正文、图片、计划）。回合内连续的工具卡再并成一组，UI 上折叠为"调用了 N 个工具"。
// 子 agent（Task/Agent 工具派出）产出的条目带 parentToolCallId，嵌到派出它的那张
// 工具卡下面成为 subagent 块，块内再按同样规则分组（可递归：子 agent 也能再派）。
// notice 是系统留痕，不属于任何一方，单独成行。
import type { AgentChatItem } from "@/types/agentChat";

type ItemOf<T extends AgentChatItem["type"]> = Extract<AgentChatItem, { type: T }>;

export type AssistantBlock =
  | { kind: "thought"; item: ItemOf<"thought"> }
  | { kind: "tools"; id: string; items: ItemOf<"tool_call">[] }
  | { kind: "text"; item: ItemOf<"assistant"> }
  | { kind: "image"; item: ItemOf<"image"> }
  | { kind: "plan"; item: ItemOf<"plan"> }
  | { kind: "subagent"; id: string; task: ItemOf<"tool_call">; blocks: AssistantBlock[] };

export type ChatTurn =
  | { kind: "user"; id: string; at: number; item: ItemOf<"user"> }
  | { kind: "assistant"; id: string; at: number; blocks: AssistantBlock[] }
  | { kind: "notice"; id: string; at: number; item: ItemOf<"notice"> };

type AssistantTurn = Extract<ChatTurn, { kind: "assistant" }>;

/** 被引用为父调用的 toolCallId 集合：命中的工具卡渲染成 subagent 块而不是普通工具卡。 */
function collectParentIds(items: readonly AgentChatItem[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if ("parentToolCallId" in item && item.parentToolCallId) ids.add(item.parentToolCallId);
  }
  return ids;
}

function appendBlock(
  blocks: AssistantBlock[],
  item: Exclude<AgentChatItem, ItemOf<"user"> | ItemOf<"notice">>,
  parentIds: Set<string>,
  containers: Map<string, AssistantBlock[]>,
): void {
  switch (item.type) {
    case "thought":
      blocks.push({ kind: "thought", item });
      return;
    case "tool_call": {
      if (parentIds.has(item.call.toolCallId)) {
        const block: AssistantBlock = { kind: "subagent", id: item.id, task: item, blocks: [] };
        blocks.push(block);
        containers.set(item.call.toolCallId, block.blocks);
        return;
      }
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "tools") {
        last.items.push(item);
      } else {
        blocks.push({ kind: "tools", id: item.id, items: [item] });
      }
      return;
    }
    case "assistant":
      blocks.push({ kind: "text", item });
      return;
    case "image":
      blocks.push({ kind: "image", item });
      return;
    case "plan":
      blocks.push({ kind: "plan", item });
      return;
  }
}

export function groupChatItems(items: readonly AgentChatItem[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  const parentIds = collectParentIds(items);
  let open: AssistantTurn | null = null;
  // toolCallId → 该 subagent 块的子块列表；跨回合有效（子 agent 的产出可能
  // 晚于派出它的回合到达）。
  const containers = new Map<string, AssistantBlock[]>();

  for (const item of items) {
    if (item.type === "user") {
      open = null;
      turns.push({ kind: "user", id: item.id, at: item.at, item });
      continue;
    }
    if (item.type === "notice") {
      open = null;
      turns.push({ kind: "notice", id: item.id, at: item.at, item });
      continue;
    }
    const parent = "parentToolCallId" in item ? item.parentToolCallId : undefined;
    const nested = parent ? containers.get(parent) : undefined;
    if (nested) {
      appendBlock(nested, item, parentIds, containers);
      continue;
    }
    // 父卡不在场（不是本引擎的标注、或父卡没到）→ 退回顶层平铺，不丢内容。
    if (!open) {
      open = { kind: "assistant", id: item.id, at: item.at, blocks: [] };
      turns.push(open);
    }
    appendBlock(open.blocks, item, parentIds, containers);
  }
  return turns;
}

/** 工具组的状态摘要：进行中 / 失败 计数，用于折叠头一眼看出有没有事。 */
export function summarizeTools(items: readonly ItemOf<"tool_call">[]): {
  total: number;
  running: number;
  failed: number;
} {
  let running = 0;
  let failed = 0;
  for (const { call } of items) {
    const status = call.status ?? "pending";
    if (status === "pending" || status === "in_progress") running += 1;
    else if (status === "failed") failed += 1;
  }
  return { total: items.length, running, failed };
}

/** 子 agent 块是否仍在运行：Task 卡本身未完结即算运行中。 */
export function isSubagentRunning(task: ItemOf<"tool_call">): boolean {
  const status = task.call.status ?? "pending";
  return status === "pending" || status === "in_progress";
}
