// `@Bot` 委托卡片：停靠在输入框上方，不阻塞当前对话继续输入。
// 进行中显示阶段 + 取消；完成显示回复（Markdown，过长折叠）+ 打开 Bot 对话；失败显示原因。
// Bot 回合里的审批只能在 Bot 对话里处理，卡片只提示并给跳转。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Loader2, ShieldQuestion, X } from "lucide-react";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import BotAvatar from "@/components/bots/BotAvatar";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { selectAskIds, useBotAskStore, type BotAsk } from "@/stores/useBotAskStore";
import type { AcpChatPhase } from "@/types/agentChat";
import { botChatId } from "@/types/bot";
import ChatMarkdown from "./ChatMarkdown";
import { cancelBotAsk, openAskBotChat } from "./botAskActions";

export type BotAskStage = "preparing" | "starting" | "queued" | "waiting" | "replying" | "cancelling";

const STAGE_LABEL = {
  preparing: "botAskStagePreparing",
  starting: "botAskStageStarting",
  queued: "botAskStageQueued",
  waiting: "botAskStageWaiting",
  replying: "botAskStageReplying",
  cancelling: "botAskStageCancelling",
} as const;

const LONG_REPLY_CHARS = 800;
const LONG_REPLY_LINES = 12;

/** 进行中卡片的阶段：先看取消 / 是否已定 Bot，再看本条是否已被接下，最后看 Bot 会话相位。 */
export function botAskStage(ask: Pick<BotAsk, "botId" | "admitted" | "cancelRequested">, botPhase: AcpChatPhase | undefined): BotAskStage {
  if (ask.cancelRequested) return "cancelling";
  if (!ask.botId) return "preparing";
  if (ask.admitted) return "replying";
  if (botPhase === "generating") return "queued";
  if (botPhase === "ready") return "waiting";
  return "starting";
}

export function isLongReply(text: string): boolean {
  return text.length > LONG_REPLY_CHARS || text.split("\n").length > LONG_REPLY_LINES;
}

function ReplyBody({ text, cwd }: { text: string; cwd: string }) {
  const { t } = useTranslation("panes");
  const [expanded, setExpanded] = useState(false);
  const long = isLongReply(text);
  return (
    <div className="mt-1.5">
      <div className={long && !expanded ? "max-h-48 overflow-hidden" : undefined} data-testid="bot-ask-reply">
        <ChatMarkdown text={text} cwd={cwd} />
      </div>
      {long ? (
        <button
          type="button"
          className="mt-1 text-xs text-[var(--app-accent)] hover:underline"
          onClick={() => setExpanded((previous) => !previous)}
        >
          {t(expanded ? "botAskCollapse" : "botAskExpand")}
        </button>
      ) : null}
    </div>
  );
}

function BotAskCard({ askId, cwd }: { askId: string; cwd: string }) {
  const { t } = useTranslation("panes");
  const ask = useBotAskStore((state) => state.asks[askId]);
  const bot = useBotAskStore((state) => (ask?.botId ? state.bots?.find((item) => item.id === ask.botId) : undefined));
  const chatKey = ask?.botId ? botChatId(ask.botId) : "";
  const botPhase = useAgentChatStore((state) => (chatKey ? state.chats[chatKey]?.snapshot?.phase : undefined));
  const awaitingApproval = useAgentChatStore((state) => (chatKey ? (state.chats[chatKey]?.pendingPermissions.length ?? 0) > 0 : false));
  if (!ask) return null;
  const name = bot?.name ?? ask.target.name;
  const running = ask.status === "running";
  const approval = running && awaitingApproval && !ask.cancelRequested;
  const openChat = () => void openAskBotChat(askId);
  return (
    <div
      data-testid="bot-ask-card"
      data-status={ask.status}
      className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-3 py-2 shadow-sm"
    >
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <BotAvatar bot={bot ?? { name, avatar: ask.target.avatar, color: ask.target.color }} size={18} />
        <span className="shrink-0 font-medium text-[var(--app-text-primary)]">{t("botAskHandedTo", { name })}</span>
        <span className="min-w-0 flex-1 truncate text-[var(--app-text-tertiary)]">{ask.text}</span>
        {running && !ask.cancelRequested ? (
          <button type="button" className="shrink-0 rounded-md px-1.5 py-0.5 text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)]" onClick={() => cancelBotAsk(askId)}>
            {t("botAskCancel")}
          </button>
        ) : null}
        {!running ? (
          <IconTooltipButton label={t("botAskDismiss")} className="size-6 shrink-0" onClick={() => useBotAskStore.getState().dismiss(askId)}>
            <X className="size-3.5" />
          </IconTooltipButton>
        ) : null}
      </div>
      {running && !approval ? (
        <div className="mt-1 flex items-center gap-1.5 text-xs text-[var(--app-text-secondary)]" data-testid="bot-ask-stage">
          <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
          {t(STAGE_LABEL[botAskStage(ask, botPhase)])}
        </div>
      ) : null}
      {approval ? (
        <div className="mt-1 flex items-center gap-1.5 text-xs text-[var(--app-status-warning)]" data-testid="bot-ask-approval">
          <ShieldQuestion className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{t("botAskApproval")}</span>
          <button type="button" className="shrink-0 rounded-md border border-[var(--app-status-warning-border)] px-2 py-0.5 hover:bg-[var(--app-status-warning-bg)]" onClick={openChat}>
            {t("botAskGoApprove")}
          </button>
        </div>
      ) : null}
      {ask.status === "failed" ? (
        <div role="alert" className="mt-1 text-xs text-[var(--app-status-danger)]">
          {t("botAskFailed", { name, error: ask.error ?? "" })}
        </div>
      ) : null}
      {ask.status === "cancelled" ? (
        <div className="mt-1 text-xs text-[var(--app-text-tertiary)]">{t("botAskCancelled")}</div>
      ) : null}
      {ask.status === "done" && !ask.reply ? (
        <div className="mt-1 text-xs text-[var(--app-text-tertiary)]">{t("botAskEmptyReply")}</div>
      ) : null}
      {!running && ask.reply ? <ReplyBody text={ask.reply} cwd={cwd} /> : null}
      {!running && ask.botId ? (
        <button type="button" className="mt-1 inline-flex items-center gap-1 text-xs text-[var(--app-accent)] hover:underline" onClick={openChat}>
          <ExternalLink className="size-3" aria-hidden />
          {t("botAskOpenChat")}
        </button>
      ) : null}
    </div>
  );
}

export default function BotAskCards({ chatId, cwd }: { chatId: string; cwd: string }) {
  const ids = useBotAskStore(selectAskIds(chatId));
  if (ids.length === 0) return null;
  return (
    <div className="flex max-h-[40vh] flex-col gap-1.5 overflow-y-auto" data-testid="bot-ask-cards">
      {ids.map((id) => <BotAskCard key={id} askId={id} cwd={cwd} />)}
    </div>
  );
}
