// Agent replies use a reading column; metadata stays quiet below the content.
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AcpPlanEntry } from "@/types/agentChat";
import type { ChatTurn } from "./chatTurns";
import AssistantBlockView from "./AssistantBlocks";
import { CopyButton, ItemView } from "./ChatItems";

export function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function TimeStamp({ at, className }: { at: number; className?: string }) {
  return (
    <time
      dateTime={new Date(at).toISOString()}
      title={new Date(at).toLocaleString()}
      className={`tabular-nums text-[11px] text-[var(--app-text-tertiary)] ${className ?? ""}`}
    >
      {formatClock(at)}
    </time>
  );
}

export interface ChatTurnViewProps {
  turn: ChatTurn;
  engineLabel: string;
  /** 会话正在生成且这是最后一个回合。 */
  streaming: boolean;
  chatId: string;
  /** 会话工作目录：正文里相对图片路径的解析基准。 */
  cwd?: string;
  onOpenLocation: (path: string, line?: number) => void;
  onPlanToTodo: (entries: AcpPlanEntry[]) => void;
  expandAllSignal?: { seq: number; expanded: boolean };
}

export default function ChatTurnView({
  turn,
  engineLabel,
  streaming,
  chatId,
  cwd,
  onOpenLocation,
  onPlanToTodo,
  expandAllSignal,
}: ChatTurnViewProps) {
  const { t } = useTranslation("panes");

  if (turn.kind === "user") {
    return (
      <div className="agent-chat-turn-user flex min-w-0 flex-col items-end gap-1" data-testid="chat-turn-user">
        <ItemView item={turn.item} onPlanToTodo={onPlanToTodo} />
        <TimeStamp at={turn.at} className="pr-1" />
      </div>
    );
  }

  if (turn.kind === "notice") {
    return <ItemView item={turn.item} onPlanToTodo={onPlanToTodo} />;
  }

  const blocks = turn.blocks;
  const replyText = blocks.flatMap((block) => block.kind === "text" ? [block.item.text] : []).join("\n\n");
  const lastBlock = blocks[blocks.length - 1];
  // 思考块 / 子 agent 块流式时自带状态行，不再叠一个"正在生成"。
  const showGenerating =
    streaming && lastBlock?.kind !== "thought" && lastBlock?.kind !== "subagent";

  return (
    <div className="agent-chat-turn-assistant group min-w-0" data-testid="chat-turn-assistant">
      <span className="sr-only">{engineLabel}</span>
      <div className="flex min-w-0 flex-col gap-4">
        {blocks.map((block, index) => (
          <AssistantBlockView
            key={block.kind === "tools" || block.kind === "subagent" ? block.id : block.item.id}
            block={block}
            streaming={streaming && index === blocks.length - 1}
            chatId={chatId}
            cwd={cwd}
            onOpenLocation={onOpenLocation}
            onPlanToTodo={onPlanToTodo}
            expandAllSignal={expandAllSignal}
            showCopyAction={false}
          />
        ))}
        {showGenerating ? (
          <div className="flex items-center gap-1.5 text-xs text-[var(--app-text-tertiary)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            {t("agentChatGenerating")}
          </div>
        ) : null}
      </div>
      <div className="agent-chat-turn-meta mt-3 flex min-h-7 items-center gap-3">
        {replyText ? <CopyButton text={replyText} label={t("agentChatCopy")} /> : null}
        <TimeStamp at={turn.at} />
      </div>
    </div>
  );
}
