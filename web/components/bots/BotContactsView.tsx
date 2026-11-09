// Explorer 侧栏「联系人」区：常驻 Bot 列表。点击 = 打开（或切到）该 Bot 的
// 长期对话标签；右键菜单里编辑 / 开新话题 / 删除。
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Contact, MoreHorizontal, Plus } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toastErr, toastOk } from "@/lib/feedback";
import { botService } from "@/services/botService";
import { nativeConfirm } from "@/services/nativeDialog";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { dropAgentChatState, ensureAgentChatListener } from "@/stores/agentChatEvents";
import { handleErrorSilent } from "@/utils/errorHandler";
import { emptyBot, type Bot, type BotSummary } from "@/types/bot";
import BotAvatar from "./BotAvatar";
import BotEditorDialog from "./BotEditorDialog";
import { openBotChat } from "./openBotChat";

export default function BotContactsView() {
  const { t } = useTranslation("sidebar");
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [editing, setEditing] = useState<Bot | null>(null);
  // 运行相位以前端 store 为准（实时），列表接口的 phase 只是首屏兜底。
  const phases = useAgentChatStore((state) => state.chats);

  const reload = useCallback(() => {
    botService
      .list()
      .then(setBots)
      .catch((error) => handleErrorSilent(error, "list bots"));
  }, []);

  useEffect(() => {
    // Bot 可能被 IM 唤醒而界面上没开它的标签：提前挂上全局对话事件监听，
    // 之后打开标签时消息已经在 store 里。
    ensureAgentChatListener();
    reload();
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void botService.listenChanged(reload).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [reload]);

  const newThread = async (bot: BotSummary) => {
    try {
      await botService.newThread(bot.id);
      dropAgentChatState(bot.chatId);
      toastOk(t("bots.newThreadDone"));
    } catch (error) {
      toastErr(String(error));
    }
  };

  const remove = async (bot: BotSummary) => {
    const ok = await nativeConfirm(t("bots.deleteConfirm", { name: bot.name }));
    if (!ok) return;
    try {
      await botService.remove(bot.id);
      dropAgentChatState(bot.chatId);
      reload();
    } catch (error) {
      toastErr(String(error));
    }
  };

  return (
    <div className="flex h-full flex-col" data-testid="bot-contacts">
      <div className="flex shrink-0 items-center gap-1 px-3 pb-1">
        <span className="text-[length:var(--text-caption)] font-medium text-[var(--app-text-secondary)]">
          {t("bots.title")}
        </span>
        <span className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t("bots.create")}
              className="rounded p-1 text-[var(--app-icon-inactive)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-icon-active)]"
              onClick={() => setEditing(emptyBot(""))}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("bots.create")}</TooltipContent>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {bots.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-8 text-center text-[length:var(--text-caption)] text-[var(--app-icon-inactive)]">
            <Contact className="h-6 w-6 opacity-40" />
            {t("bots.empty")}
          </div>
        ) : (
          bots.map((bot) => {
            const phase = phases[bot.chatId]?.snapshot?.phase ?? bot.phase;
            const busy = phase === "generating";
            const live = phase === "ready" || busy || phase === "starting";
            return (
              <div key={bot.id} className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--app-hover)]">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => openBotChat(bot)}
                >
                  <span className="relative">
                    <BotAvatar bot={bot} />
                    {live && (
                      <span
                        aria-hidden
                        className="absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--app-sidebar-bg,var(--app-panel-bg))]"
                        style={{ background: busy ? "var(--app-status-warning)" : "var(--app-status-success)" }}
                      />
                    )}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-xs text-[var(--app-text-primary)]">{bot.name}</span>
                    <span className="truncate text-[length:var(--text-micro)] text-[var(--app-icon-inactive)]">
                      {busy ? t("bots.busy") : bot.persona.split("\n")[0] || bot.engineId}
                    </span>
                  </span>
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={t("bots.more")}
                      className="rounded p-1 text-[var(--app-icon-inactive)] opacity-0 hover:text-[var(--app-icon-active)] group-hover:opacity-100 focus:opacity-100"
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setEditing(bot)}>{t("bots.edit")}</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void newThread(bot)}>{t("bots.newThread")}</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-[var(--app-status-danger)]" onSelect={() => void remove(bot)}>
                      {t("bots.delete")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })
        )}
      </div>
      <BotEditorDialog
        bot={editing}
        onClose={() => setEditing(null)}
        onSaved={(saved) => {
          const created = !editing?.id;
          setEditing(null);
          botService
            .list()
            .then((list) => {
              setBots(list);
              const summary = list.find((item) => item.id === saved.id);
              if (created && summary) openBotChat(summary);
            })
            .catch((error) => handleErrorSilent(error, "list bots"));
        }}
      />
    </div>
  );
}
