// 回合渲染：用户回合右对齐气泡 + 时间；assistant 回合是"头像列 + 头部（引擎名 ·
// 时间）+ 内容块"，内容块的具体渲染在 AssistantBlocks；notice 居中一行。
// 正文不做对称气泡（长 markdown 放气泡里难看），用轻底色卡片做承载面，
// 与右侧用户气泡形成左右对话节奏。
import { Bot, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AcpPlanEntry } from "@/types/agentChat";
import type { ChatTurn } from "./chatTurns";
import AssistantBlockView from "./AssistantBlocks";
import { ItemView } from "./ChatItems";

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
  onOpenLocation: (path: string, line?: number) => void;
  onPlanToTodo: (entries: AcpPlanEntry[]) => void;
  expandAllSignal?: { seq: number; expanded: boolean };
}

export default function ChatTurnView({
  turn,
  engineLabel,
  streaming,
  chatId,
  onOpenLocation,
  onPlanToTodo,
  expandAllSignal,
}: ChatTurnViewProps) {
  const { t } = useTranslation("panes");

  if (turn.kind === "user") {
    return (
      <div className="flex flex-col items-end gap-1 pl-10" data-testid="chat-turn-user">
        <ItemView item={turn.item} onPlanToTodo={onPlanToTodo} />
        <TimeStamp at={turn.at} className="pr-1" />
      </div>
    );
  }

  if (turn.kind === "notice") {
    return <ItemView item={turn.item} onPlanToTodo={onPlanToTodo} />;
  }

  const blocks = turn.blocks;
  const lastBlock = blocks[blocks.length - 1];
  // 思考块 / 子 agent 块流式时自带状态行，不再叠一个"正在生成"。
  const showGenerating =
    streaming && lastBlock?.kind !== "thought" && lastBlock?.kind !== "subagent";

  return (
    <div className="flex gap-3" data-testid="chat-turn-assistant">
      <span
        aria-hidden="true"
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--app-active-bg)] text-[var(--app-accent)]"
      >
        <Bot className="h-4 w-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-baseline gap-2 leading-none">
          <span className="text-xs font-medium text-[var(--app-text-primary)]">{engineLabel}</span>
          <TimeStamp at={turn.at} />
        </div>
        {blocks.map((block, index) => (
          <AssistantBlockView
            key={block.kind === "tools" || block.kind === "subagent" ? block.id : block.item.id}
            block={block}
            streaming={streaming && index === blocks.length - 1}
            chatId={chatId}
            onOpenLocation={onOpenLocation}
            onPlanToTodo={onPlanToTodo}
            expandAllSignal={expandAllSignal}
          />
        ))}
        {showGenerating ? (
          <div className="flex items-center gap-1.5 text-xs text-[var(--app-text-tertiary)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            {t("agentChatGenerating")}
          </div>
        ) : null}
      </div>
    </div>
  );
}
