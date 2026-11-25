// IM 渠道的「入站」字段（目前仅 Telegram）：接收消息开关 + 默认 Bot + 允许的发送者。
// 打开前必须确认：被允许发消息的人，就能让 Bot 在本机读写文件、执行命令。
// 后端只认数字 Chat ID；发送者默认只有私聊里的本人，群里必须列出用户 id。
// 渲染为渠道卡片内的若干 SettingsRow（与上下行同一张卡，发丝线分隔），不自带容器。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { botService } from "@/services/botService";
import { nativeConfirm } from "@/services/nativeDialog";
import type { ImChannelConfig } from "@/types";
import type { BotSummary } from "@/types/bot";
import { handleErrorSilent } from "@/utils/errorHandler";
import { SettingsRow } from "./layout";

const NUMERIC_ID = /^-?\d+$/;

/** 「11, 22 33」→ ["11","22","33"]；非数字项丢掉（后端同样忽略）。 */
export function parseUserIds(raw: string): string[] {
  return raw
    .split(/[\s,，]+/)
    .map((part) => part.trim())
    .filter((part) => NUMERIC_ID.test(part));
}

interface ImInboundFieldsProps {
  channel: ImChannelConfig;
  onChange: (patch: Partial<ImChannelConfig>) => void;
}

export default function ImInboundFields({ channel, onChange }: ImInboundFieldsProps) {
  const { t } = useTranslation("settings");
  const [bots, setBots] = useState<BotSummary[]>([]);
  const inbound = Boolean(channel.inboundEnabled);
  const savedIds = (channel.inboundAllowedUserIds ?? []).join(", ");
  const [idsDraft, setIdsDraft] = useState(savedIds);
  const numericChat = NUMERIC_ID.test((channel.chatId ?? "").trim());

  useEffect(() => setIdsDraft(savedIds), [savedIds]);

  useEffect(() => {
    if (!inbound) return;
    botService
      .list()
      .then(setBots)
      .catch((error) => handleErrorSilent(error, "list bots for im inbound"));
  }, [inbound]);

  const toggle = async (next: boolean) => {
    if (next && !(await nativeConfirm(t("imInboundConfirm")))) return;
    onChange({ inboundEnabled: next });
  };

  const switchId = `im-inbound-enabled-${channel.id}`;
  const usersId = `im-inbound-users-${channel.id}`;
  const usersHintId = `${usersId}-hint`;
  const botId = `im-inbound-bot-${channel.id}`;

  return (
    <>
      <SettingsRow
        data-testid="im-inbound-fields"
        title={t("imInboundEnabled")}
        description={t("imInboundHint")}
        htmlFor={switchId}
        control={<Switch id={switchId} checked={inbound} onCheckedChange={(next) => void toggle(next)} />}
      >
        {inbound && !numericChat ? (
          <p role="alert" className="m-0 text-[length:var(--text-small)] text-[var(--app-status-warning)]">
            {t("imInboundNeedsNumericChatId")}
          </p>
        ) : null}
      </SettingsRow>
      {inbound && (
        <SettingsRow
          title={t("imInboundAllowedUsers")}
          description={<span id={usersHintId}>{t("imInboundAllowedUsersHint")}</span>}
          htmlFor={usersId}
        >
          <Input
            id={usersId}
            aria-describedby={usersHintId}
            value={idsDraft}
            placeholder="123456789"
            className="h-8 font-mono text-[length:var(--text-small)]"
            onChange={(event) => setIdsDraft(event.target.value)}
            onBlur={() => {
              const next = parseUserIds(idsDraft);
              setIdsDraft(next.join(", "));
              if (next.join(",") !== (channel.inboundAllowedUserIds ?? []).join(",")) {
                onChange({ inboundAllowedUserIds: next });
              }
            }}
          />
        </SettingsRow>
      )}
      {inbound && (
        <SettingsRow
          title={t("imInboundDefaultBot")}
          htmlFor={botId}
          control={(
            <select
              id={botId}
              className="h-8 w-44 rounded-md border border-[var(--app-border)] bg-[var(--app-content)] px-2 text-[length:var(--text-small)] text-[var(--app-text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
              value={channel.defaultBotId ?? ""}
              onChange={(event) => onChange({ defaultBotId: event.target.value || null })}
            >
              <option value="">{t("imInboundDefaultBotFirst")}</option>
              {bots.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {`${bot.avatar} ${bot.name}`.trim()}
                </option>
              ))}
            </select>
          )}
        />
      )}
    </>
  );
}
