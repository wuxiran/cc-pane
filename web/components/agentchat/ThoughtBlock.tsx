// 思考块：默认折叠成一行状态（"正在思考…" / "思考了 N 秒"），点开看全文。
// 流式中自动展开，收口后自动折叠；用户手动切换过就尊重用户。
import { useState } from "react";
import { Brain, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentChatItem } from "@/types/agentChat";

type ThoughtItem = Extract<AgentChatItem, { type: "thought" }>;

interface ThoughtBlockProps {
  item: ThoughtItem;
  /** 该思考块是否仍在流式产出（会话 generating 且它是最后一个条目）。 */
  streaming: boolean;
}

export function thoughtSeconds(item: ThoughtItem): number | null {
  if (item.doneAt === undefined) return null;
  return Math.max(1, Math.round((item.doneAt - item.at) / 1000));
}

export default function ThoughtBlock({ item, streaming }: ThoughtBlockProps) {
  const { t } = useTranslation("panes");
  // null = 用户没碰过，跟随流式状态（流式中展开、收口后折叠）。
  const [userChoice, setUserChoice] = useState<boolean | null>(null);
  const expanded = userChoice ?? streaming;
  const seconds = thoughtSeconds(item);

  return (
    <div className="rounded-lg border border-dashed border-[var(--app-border)] text-xs">
      <button
        type="button"
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-[var(--app-text-tertiary)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-secondary)]"
        onClick={() => setUserChoice(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        )}
        {streaming ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
        ) : (
          <Brain className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        )}
        <span className="truncate">
          {streaming
            ? t("agentChatThinking")
            : seconds !== null
              ? t("agentChatThoughtFor", { seconds })
              : t("agentChatThoughtProcess")}
        </span>
      </button>
      {expanded ? (
        <div className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words border-t border-dashed border-[var(--app-border)] px-3 py-2 italic leading-relaxed text-[var(--app-text-tertiary)]">
          {item.text}
        </div>
      ) : null}
    </div>
  );
}
