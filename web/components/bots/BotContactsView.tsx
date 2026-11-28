// Explorer 侧栏「联系人」区：本机 Bot + 其他电脑共享的 Bot（Bot 组网，docs/112 §5）。
// 本机 Bot 点击 = 打开长期对话标签；菜单里编辑 / 远程权限 / 开新话题 / 删除。
// 其他电脑的 Bot 点击 = 发消息对话框（回复与待审批由后端跟踪推回）。
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Contact, MoreHorizontal, Network, Plus, ShieldAlert } from "lucide-react";
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
import { botMeshService } from "@/services/botMeshService";
import { nativeConfirm } from "@/services/nativeDialog";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { dropAgentChatState, ensureAgentChatListener } from "@/stores/agentChatEvents";
import { handleErrorSilent } from "@/utils/errorHandler";
import { emptyBot, type Bot, type BotSummary } from "@/types/bot";
import { mergeOutbox, type ContactGroup, type OutboxEntry, type SharedBot } from "@/types/botMesh";
import BotAvatar from "./BotAvatar";
import BotEditorDialog from "./BotEditorDialog";
import { openBotChat } from "./openBotChat";
import MeshPeersDialog from "./MeshPeersDialog";
import RemoteBotDialog, { type RemoteBotTarget } from "./RemoteBotDialog";
import RemoteDeviceGroup from "./RemoteDeviceGroup";
import RemotePolicyDialog from "./RemotePolicyDialog";

export default function BotContactsView() {
  const { t } = useTranslation("sidebar");
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [editing, setEditing] = useState<Bot | null>(null);
  const [policyFor, setPolicyFor] = useState<BotSummary | null>(null);
  const [remoteGroups, setRemoteGroups] = useState<ContactGroup[]>([]);
  const [outbox, setOutbox] = useState<OutboxEntry[]>([]);
  const [peersOpen, setPeersOpen] = useState(false);
  const [target, setTarget] = useState<RemoteBotTarget | null>(null);
  // 运行相位以前端 store 为准（实时），列表接口的 phase 只是首屏兜底。
  const phases = useAgentChatStore((state) => state.chats);

  const reload = useCallback(() => {
    botService
      .list()
      .then(setBots)
      .catch((error) => handleErrorSilent(error, "list bots"));
  }, []);

  const reloadMesh = useCallback((refresh = false) => {
    botMeshService
      .contacts(refresh)
      .then((view) => setRemoteGroups(view.groups.filter((group) => !group.local)))
      .catch((error) => handleErrorSilent(error, "mesh contacts"));
  }, []);

  useEffect(() => {
    reloadMesh();
    botMeshService.outbox().then(setOutbox).catch((error) => handleErrorSilent(error, "mesh outbox"));
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void botMeshService.listenOutbox((entry) => setOutbox((list) => mergeOutbox(list, entry))).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [reloadMesh]);

  const openRemote = (group: ContactGroup, bot: SharedBot) =>
    setTarget({ deviceId: group.deviceId, deviceName: group.name, bot });
  const waiting = outbox.filter((entry) => entry.status === "waiting_permission");

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
              aria-label={t("bots.mesh.peersTitle")}
              className="rounded p-1 text-[var(--app-icon-inactive)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-icon-active)]"
              onClick={() => setPeersOpen(true)}
            >
              <Network className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("bots.mesh.peersTitle")}</TooltipContent>
        </Tooltip>
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
        {waiting.map((entry) => (
          <button
            key={entry.id}
            type="button"
            data-testid="mesh-waiting"
            className="mb-1 flex w-full items-center gap-1.5 rounded-md border px-2 py-1 text-left text-[length:var(--text-micro)]"
            style={{ borderColor: "var(--app-status-warning)" }}
            onClick={() => {
              const group = remoteGroups.find((g) => g.deviceId === entry.deviceId);
              const bot = group?.bots.find((b) => b.id === entry.botId);
              if (group && bot) openRemote(group, bot);
            }}
          >
            <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-[var(--app-status-warning)]" />
            <span className="truncate">{t("bots.mesh.waitingBanner", { bot: entry.botName, device: entry.deviceName })}</span>
          </button>
        ))}
        {remoteGroups.length > 0 && (
          <div className="px-2 pt-1 text-[length:var(--text-micro)] font-medium text-[var(--app-text-secondary)]">{t("bots.mesh.localGroup")}</div>
        )}
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
                    <span className="flex items-center gap-1 truncate text-xs text-[var(--app-text-primary)]">
                      {bot.name}
                      {bot.remoteShared !== false && bot.remotePolicy === "full" && (
                        <span
                          data-testid="bot-full-badge"
                          title={t("bots.mesh.fullBadge")}
                          className="rounded px-1 text-[length:var(--text-micro)] text-white"
                          style={{ background: "var(--app-status-danger)" }}
                        >
                          {t("bots.mesh.fullShort")}
                        </span>
                      )}
                    </span>
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
                    <DropdownMenuItem onSelect={() => setPolicyFor(bot)}>
                      {t("bots.mesh.remotePolicyMenu")}
                      {bot.remotePolicy === "full" && <ShieldAlert className="ml-auto h-3.5 w-3.5 text-[var(--app-status-danger)]" />}
                    </DropdownMenuItem>
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
        {remoteGroups.length > 0 && (
          <div className="px-2 pt-2 text-[length:var(--text-micro)] font-medium text-[var(--app-text-secondary)]">{t("bots.mesh.otherComputers")}</div>
        )}
        {remoteGroups.map((group) => (
          <RemoteDeviceGroup key={group.deviceId} group={group} onOpen={openRemote} />
        ))}
      </div>
      <RemotePolicyDialog
        bot={policyFor}
        onClose={() => setPolicyFor(null)}
        onSaved={() => {
          setPolicyFor(null);
          reload();
        }}
      />
      <MeshPeersDialog open={peersOpen} onClose={() => setPeersOpen(false)} onChanged={() => reloadMesh(true)} />
      <RemoteBotDialog
        target={target}
        outbox={outbox}
        onClose={() => setTarget(null)}
        onSent={(entry) => setOutbox((list) => mergeOutbox(list, entry))}
      />
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
