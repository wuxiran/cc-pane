// assistant 回合内的内容块渲染：思考 / 工具组 / 正文 / 图片 / 计划 / 子 agent。
// SubagentBlock 与 AssistantBlockView 互相递归（子 agent 块内部还是这些块），
// 所以放在同一个文件里。
import { useState } from "react";
import { Bot, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AcpPlanEntry } from "@/types/agentChat";
import type { AssistantBlock } from "./chatTurns";
import { isSubagentRunning } from "./chatTurns";
import { CopyButton, ItemView, MessageCopyContextMenu } from "./ChatItems";
import ChatMarkdown from "./ChatMarkdown";
import ThoughtBlock from "./ThoughtBlock";
import { ContentBlockView, StatusBadge } from "./ToolCallCard";
import ToolCallGroup from "./ToolCallGroup";

export interface AssistantBlockViewProps {
  block: AssistantBlock;
  /** 会话正在生成且该块是当前最末一块（含嵌套路径上的最末）。 */
  streaming: boolean;
  chatId: string;
  onOpenLocation: (path: string, line?: number) => void;
  onPlanToTodo: (entries: AcpPlanEntry[]) => void;
  expandAllSignal?: { seq: number; expanded: boolean };
}

type SubagentBlockData = Extract<AssistantBlock, { kind: "subagent" }>;

/** 子 agent 块：头部是任务描述 + 状态，展开后是它自己的思考/工具/正文，
 * 底部是 Task 卡收到的最终汇报。运行中自动展开，完结后自动折叠；用户手动切换过就尊重用户。 */
export function SubagentBlock({
  block,
  streaming,
  chatId,
  onOpenLocation,
  onPlanToTodo,
  expandAllSignal,
}: Omit<AssistantBlockViewProps, "block"> & { block: SubagentBlockData }) {
  const { t } = useTranslation("panes");
  const [userChoice, setUserChoice] = useState<boolean | null>(null);
  const running = isSubagentRunning(block.task);
  const expanded = userChoice ?? running;
  const { call } = block.task;
  const report = call.content ?? [];

  return (
    <div
      data-testid="chat-subagent"
      className="rounded-lg border border-[var(--app-border)] bg-[var(--app-overlay)] text-xs shadow-sm"
    >
      <button
        type="button"
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--app-hover)]"
        onClick={() => setUserChoice(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--app-icon-inactive)]" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--app-icon-inactive)]" aria-hidden="true" />
        )}
        {running ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--app-accent)]" aria-hidden="true" />
        ) : (
          <Bot className="h-3.5 w-3.5 shrink-0 text-[var(--app-accent)]" aria-hidden="true" />
        )}
        <span className="shrink-0 rounded bg-[var(--app-active-bg)] px-1.5 py-px text-[10px] font-medium text-[var(--app-accent)]">
          {t("agentChatSubagent")}
        </span>
        <span className="flex-1 truncate text-[var(--app-text-primary)]">
          {call.title || call.toolCallId}
        </span>
        <StatusBadge status={call.status} />
      </button>
      {expanded ? (
        <div className="flex flex-col gap-2 border-t border-[var(--app-border)] py-2 pl-3 pr-2">
          <div className="flex flex-col gap-2 border-l-2 border-[color-mix(in_srgb,var(--app-accent)_35%,transparent)] pl-3">
            {block.blocks.map((child, index) => (
              <AssistantBlockView
                key={child.kind === "tools" || child.kind === "subagent" ? child.id : child.item.id}
                block={child}
                streaming={streaming && index === block.blocks.length - 1}
                chatId={chatId}
                onOpenLocation={onOpenLocation}
                onPlanToTodo={onPlanToTodo}
                expandAllSignal={expandAllSignal}
              />
            ))}
            {running && block.blocks.length === 0 ? (
              <div className="flex items-center gap-1.5 text-[var(--app-text-tertiary)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                {t("agentChatSubagentStarting")}
              </div>
            ) : null}
          </div>
          {report.length > 0 ? (
            <div className="flex flex-col gap-1">
              <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--app-icon-inactive)]">
                {t("agentChatSubagentReport")}
              </div>
              {report.map((content, index) => (
                <ContentBlockView key={index} block={content} chatId={chatId} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function AssistantBlockView({
  block,
  streaming,
  chatId,
  onOpenLocation,
  onPlanToTodo,
  expandAllSignal,
}: AssistantBlockViewProps) {
  const { t } = useTranslation("panes");
  switch (block.kind) {
    case "thought":
      return <ThoughtBlock item={block.item} streaming={streaming} />;
    case "tools":
      return (
        <ToolCallGroup
          items={block.items}
          chatId={chatId}
          onOpenLocation={onOpenLocation}
          expandAllSignal={expandAllSignal}
        />
      );
    case "subagent":
      return (
        <SubagentBlock
          block={block}
          streaming={streaming}
          chatId={chatId}
          onOpenLocation={onOpenLocation}
          onPlanToTodo={onPlanToTodo}
          expandAllSignal={expandAllSignal}
        />
      );
    case "text":
      return (
        <MessageCopyContextMenu text={block.item.text}>
          <div className="group relative rounded-xl border border-[var(--app-border)] bg-[color-mix(in_srgb,var(--app-overlay)_50%,transparent)] px-4 py-3">
            <div className="absolute right-2 top-2 z-[1]">
              <CopyButton text={block.item.text} label={t("agentChatCopy")} />
            </div>
            <ChatMarkdown text={block.item.text} onOpenFile={onOpenLocation} />
          </div>
        </MessageCopyContextMenu>
      );
    case "image":
    case "plan":
      return <ItemView item={block.item} onPlanToTodo={onPlanToTodo} />;
    default:
      return null;
  }
}
