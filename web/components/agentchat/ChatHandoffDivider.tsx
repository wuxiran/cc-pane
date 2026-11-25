// 上下文交接分隔线（参考 T3 Code）：居中细线 +「⇄ 上下文交接  旧引擎/模型 → 新引擎/模型」，
// 旧的一侧用强调色。数据来自 notice.handoff；text 是无障碍/导出用的可读回退。
import { ArrowLeftRight, ArrowRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentChatHandoff } from "@/types/agentChat";
import ChatEngineIcon from "./ChatEngineIcon";

export default function ChatHandoffDivider({ handoff, text }: { handoff: AgentChatHandoff; text: string }) {
  const { t } = useTranslation("panes");
  return (
    <div
      role="separator"
      aria-label={text}
      data-testid="chat-handoff-divider"
      className="flex items-center gap-3 text-[length:var(--text-caption)] text-[var(--app-text-tertiary)]"
    >
      <span className="h-px flex-1 bg-[var(--app-border)]" aria-hidden="true" />
      <span className="flex min-w-0 max-w-[85%] flex-wrap items-center justify-center gap-x-2 gap-y-0.5">
        <span className="flex shrink-0 items-center gap-1">
          <ArrowLeftRight className="h-3 w-3" aria-hidden="true" />
          {t("agentChatHandoffTitle")}
        </span>
        <span className="flex min-w-0 items-center gap-1 text-[var(--app-accent)]" data-testid="chat-handoff-from">
          <ChatEngineIcon engineId={handoff.fromEngineId} />
          <span className="truncate">{handoff.from}</span>
        </span>
        <ArrowRight className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="flex min-w-0 items-center gap-1 text-[var(--app-text-secondary)]" data-testid="chat-handoff-to">
          <ChatEngineIcon engineId={handoff.toEngineId} />
          <span className="truncate">{handoff.to}</span>
        </span>
      </span>
      <span className="h-px flex-1 bg-[var(--app-border)]" aria-hidden="true" />
    </div>
  );
}
