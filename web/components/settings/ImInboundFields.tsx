// IM 渠道的「入站」字段（目前仅 Telegram）：接收消息开关 + 默认 Bot + 允许的发送者。
// 打开前必须确认：被允许发消息的人，就能让 Bot 在本机读写文件、执行命令。
// 后端只认数字 Chat ID；发送者默认只有私聊里的本人，群里必须列出用户 id。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { botService } from "@/services/botService";
import { nativeConfirm } from "@/services/nativeDialog";
import type { ImChannelConfig } from "@/types";
import type { BotSummary } from "@/types/bot";
import { handleErrorSilent } from "@/utils/errorHandler";

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

  return (
    <div className="flex flex-col gap-1.5" data-testid="im-inbound-fields">
      <label
        className="flex items-center gap-1.5 text-[length:var(--text-small)] cursor-default"
        style={{ color: "var(--app-text-secondary)" }}
      >
        <input
          type="checkbox"
          checked={inbound}
          onChange={(event) => void toggle(event.target.checked)}
          className="h-3.5 w-3.5 cursor-default"
          style={{ accentColor: "var(--app-accent)" }}
        />
        {t("imInboundEnabled")}
      </label>
      <span className="text-[length:var(--text-caption)]" style={{ color: "var(--app-text-tertiary)" }}>
        {t("imInboundHint")}
      </span>
      {inbound && !numericChat && (
        <span
          role="alert"
          className="text-[length:var(--text-caption)]"
          style={{ color: "var(--app-status-warning)" }}
        >
          {t("imInboundNeedsNumericChatId")}
        </span>
      )}
      {inbound && (
        <FormField
          label={t("imInboundAllowedUsers")}
          hint={t("imInboundAllowedUsersHint")}
          className="flex flex-col gap-1"
          hintClassName="text-[length:var(--text-caption)] text-[var(--app-text-tertiary)]"
        >
          {({ id, hintId }) => (
            <Input
              id={id}
              aria-describedby={hintId}
              value={idsDraft}
              placeholder="123456789"
              className="h-8"
              onChange={(event) => setIdsDraft(event.target.value)}
              onBlur={() => {
                const next = parseUserIds(idsDraft);
                setIdsDraft(next.join(", "));
                if (next.join(",") !== (channel.inboundAllowedUserIds ?? []).join(",")) {
                  onChange({ inboundAllowedUserIds: next });
                }
              }}
            />
          )}
        </FormField>
      )}
      {inbound && (
        <FormField label={t("imInboundDefaultBot")} className="flex flex-col gap-1">
          {({ id }) => (
            <select
              id={id}
              className="h-8 rounded-md border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-2 text-[length:var(--text-small)]"
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
        </FormField>
      )}
    </div>
  );
}
