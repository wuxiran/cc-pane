// 连续工具调用的分组卡：单个直接渲染 ToolCallCard；两个以上折叠成
// "调用了 N 个工具 · 进行中 x · 失败 y"，展开才看明细。管家模式一轮里常常
// 连续七八个 list_* 查询，不折叠会把正文冲出视口。
// 有调用还在进行时自动展开，全部完成后自动折叠；用户手动切换过就尊重用户。
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentChatItem } from "@/types/agentChat";
import ToolCallCard from "./ToolCallCard";
import { summarizeTools } from "./chatTurns";

type ToolCallItem = Extract<AgentChatItem, { type: "tool_call" }>;

interface ToolCallGroupProps {
  items: ToolCallItem[];
  chatId?: string;
  onOpenLocation: (path: string, line?: number) => void;
  expandAllSignal?: { seq: number; expanded: boolean };
}

export default function ToolCallGroup({ items, chatId, onOpenLocation, expandAllSignal }: ToolCallGroupProps) {
  const { t } = useTranslation("panes");
  const [userChoice, setUserChoice] = useState<boolean | null>(null);

  // 头部"全部展开/折叠"同样作用到分组本身。
  useEffect(() => {
    if (expandAllSignal && expandAllSignal.seq > 0) setUserChoice(expandAllSignal.expanded);
  }, [expandAllSignal]);

  if (items.length === 1) {
    return (
      <ToolCallCard
        call={items[0].call}
        chatId={chatId}
        onOpenLocation={onOpenLocation}
        expandAllSignal={expandAllSignal}
      />
    );
  }

  const summary = summarizeTools(items);
  const expanded = userChoice ?? summary.running > 0;

  return (
    <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-overlay)] text-xs shadow-sm">
      <button
        type="button"
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[var(--app-text-secondary)] transition-colors hover:bg-[var(--app-hover)]"
        onClick={() => setUserChoice(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--app-icon-inactive)]" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--app-icon-inactive)]" aria-hidden="true" />
        )}
        {summary.running > 0 ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--app-icon-inactive)]" aria-hidden="true" />
        ) : (
          <Wrench className="h-3.5 w-3.5 shrink-0 text-[var(--app-icon-inactive)]" aria-hidden="true" />
        )}
        <span className="truncate">{t("agentChatToolGroup", { count: summary.total })}</span>
        <span className="flex-1" />
        {summary.running > 0 ? (
          <span className="tabular-nums text-[var(--app-status-warning)]">
            {t("agentChatToolGroupRunning", { count: summary.running })}
          </span>
        ) : null}
        {summary.failed > 0 ? (
          <span className="tabular-nums text-[var(--app-status-danger)]">
            {t("agentChatToolGroupFailed", { count: summary.failed })}
          </span>
        ) : null}
      </button>
      {expanded ? (
        <div className="flex flex-col gap-1.5 border-t border-[var(--app-border)] px-2 py-2">
          {items.map((item) => (
            <ToolCallCard
              key={item.id}
              call={item.call}
              chatId={chatId}
              onOpenLocation={onOpenLocation}
              expandAllSignal={expandAllSignal}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
