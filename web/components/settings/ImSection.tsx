import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { settingsService } from "@/services";
import type { ImChannelConfig, ImChannelType, ImEventKind, ImSettings } from "@/types";

interface ImSectionProps {
  value: ImSettings;
  onChange: (value: ImSettings) => void;
}

const CHANNEL_TYPES: ImChannelType[] = ["dingtalk", "wecom", "lark", "slack", "telegram", "webhook"];

const EVENT_KINDS: ImEventKind[] = ["turn_end", "waiting_input", "error", "session_exited"];

/** secret 字段只对支持加签的平台展示；token/chatId 只对需要的平台展示 */
const SHOWS_SECRET: ReadonlySet<ImChannelType> = new Set(["dingtalk", "lark"]);
const SHOWS_TOKEN: ReadonlySet<ImChannelType> = new Set(["webhook", "telegram"]);
const SHOWS_CHAT_ID: ReadonlySet<ImChannelType> = new Set(["telegram"]);

function newChannel(): ImChannelConfig {
  return {
    id: crypto.randomUUID(),
    channelType: "dingtalk",
    name: "",
    url: "",
    token: null,
    secret: null,
    chatId: null,
    events: [...EVENT_KINDS],
    enabled: true,
  };
}

export default function ImSection({ value, onChange }: ImSectionProps) {
  const { t } = useTranslation("settings");

  function update<K extends keyof ImSettings>(key: K, v: ImSettings[K]) {
    onChange({ ...value, [key]: v });
  }

  function updateChannel(id: string, patch: Partial<ImChannelConfig>) {
    update(
      "channels",
      value.channels.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    );
  }

  function removeChannel(id: string) {
    update("channels", value.channels.filter((c) => c.id !== id));
  }

  function toggleEvent(channel: ImChannelConfig, kind: ImEventKind) {
    const events = channel.events.includes(kind)
      ? channel.events.filter((e) => e !== kind)
      : [...channel.events, kind];
    updateChannel(channel.id, { events });
  }

  async function testChannel(channel: ImChannelConfig) {
    try {
      await settingsService.testImChannel(channel.id);
      toast.success(t("imTestSuccess"));
    } catch (e) {
      toast.error(t("imTestFailed", { error: e }));
    }
  }

  const typeLabel: Record<ImChannelType, string> = {
    dingtalk: t("imTypeDingtalk"),
    wecom: t("imTypeWecom"),
    lark: t("imTypeLark"),
    slack: t("imTypeSlack"),
    telegram: t("imTypeTelegram"),
    webhook: t("imTypeWebhook"),
  };

  const eventLabel: Record<ImEventKind, string> = {
    turn_end: t("imEventTurnEnd"),
    waiting_input: t("imEventWaitingInput"),
    error: t("imEventError"),
    session_exited: t("imEventSessionExited"),
  };

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-[15px] font-semibold mb-1" style={{ color: "var(--app-text-primary)" }}>
        {t("imBridgeTitle")}
      </h3>

      <div className="flex items-center justify-between">
        <Label>{t("enableImBridge")}</Label>
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => update("enabled", e.target.checked)}
          className="w-4 h-4 cursor-pointer"
          style={{ accentColor: "var(--app-accent)" }}
        />
      </div>

      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <Label>{t("imPushWhenFocused")}</Label>
          <span className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
            {t("imPushWhenFocusedDesc")}
          </span>
        </div>
        <input
          type="checkbox"
          checked={value.pushWhenFocused}
          onChange={(e) => update("pushWhenFocused", e.target.checked)}
          className="w-4 h-4 cursor-pointer shrink-0"
          style={{ accentColor: "var(--app-accent)" }}
        />
      </div>

      <div className="flex flex-col gap-2" data-settings-section="im-channels">
        <div className="flex items-center justify-between">
          <Label>{t("imChannels")}</Label>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => update("channels", [...value.channels, newChannel()])}
          >
            {t("imAddChannel")}
          </Button>
        </div>

        {value.channels.length === 0 && (
          <p className="text-[12px]" style={{ color: "var(--app-text-tertiary)" }}>
            {t("imNoChannels")}
          </p>
        )}

        {value.channels.map((channel) => (
          <div
            key={channel.id}
            className="flex flex-col gap-2 rounded-md p-3"
            style={{ border: "1px solid var(--app-border)", background: "var(--app-content)" }}
          >
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={channel.enabled}
                title={t("imChannelEnabled")}
                onChange={(e) => updateChannel(channel.id, { enabled: e.target.checked })}
                className="w-4 h-4 cursor-pointer shrink-0"
                style={{ accentColor: "var(--app-accent)" }}
              />
              <select
                value={channel.channelType}
                onChange={(e) =>
                  updateChannel(channel.id, { channelType: e.target.value as ImChannelType })
                }
                className="h-8 px-2 rounded-md text-[13px] outline-none"
                style={{
                  border: "1px solid var(--app-border)",
                  background: "var(--app-content)",
                  color: "var(--app-text-primary)",
                }}
              >
                {CHANNEL_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {typeLabel[type]}
                  </option>
                ))}
              </select>
              <Input
                value={channel.name}
                placeholder={t("imChannelName")}
                className="h-8 flex-1"
                onChange={(e) => updateChannel(channel.id, { name: e.target.value })}
              />
              <Button
                size="sm"
                variant="ghost"
                title={t("imRemoveChannel")}
                onClick={() => removeChannel(channel.id)}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>

            <div className="flex flex-col gap-1">
              <Label>{t("imChannelUrl")}</Label>
              <Input
                value={channel.url}
                placeholder="https://…"
                className="h-8"
                onChange={(e) => updateChannel(channel.id, { url: e.target.value })}
              />
            </div>

            {SHOWS_SECRET.has(channel.channelType) && (
              <div className="flex flex-col gap-1">
                <Label>{t("imChannelSecret")}</Label>
                <Input
                  type="password"
                  value={channel.secret ?? ""}
                  className="h-8"
                  onChange={(e) => updateChannel(channel.id, { secret: e.target.value || null })}
                />
                <span className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
                  {t("imChannelSecretHint")}
                </span>
              </div>
            )}

            {SHOWS_TOKEN.has(channel.channelType) && (
              <div className="flex flex-col gap-1">
                <Label>{t("imChannelToken")}</Label>
                <Input
                  type="password"
                  value={channel.token ?? ""}
                  className="h-8"
                  onChange={(e) => updateChannel(channel.id, { token: e.target.value || null })}
                />
              </div>
            )}

            {SHOWS_CHAT_ID.has(channel.channelType) && (
              <div className="flex flex-col gap-1">
                <Label>{t("imChannelChatId")}</Label>
                <Input
                  value={channel.chatId ?? ""}
                  className="h-8"
                  onChange={(e) => updateChannel(channel.id, { chatId: e.target.value || null })}
                />
              </div>
            )}

            <div className="flex flex-col gap-1">
              <Label>{t("imChannelEvents")}</Label>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {EVENT_KINDS.map((kind) => (
                  <label
                    key={kind}
                    className="flex items-center gap-1.5 text-[12px] cursor-pointer"
                    style={{ color: "var(--app-text-secondary)" }}
                  >
                    <input
                      type="checkbox"
                      checked={channel.events.includes(kind)}
                      onChange={() => toggleEvent(channel, kind)}
                      className="w-3.5 h-3.5 cursor-pointer"
                      style={{ accentColor: "var(--app-accent)" }}
                    />
                    {eventLabel[kind]}
                  </label>
                ))}
              </div>
              <span className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
                {t("imChannelEventsHint")}
              </span>
            </div>

            <div>
              <Button size="sm" variant="secondary" onClick={() => testChannel(channel)}>
                {t("imTestChannel")}
              </Button>
            </div>
          </div>
        ))}
      </div>

      <p className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
        {t("imPlainStorageHint")}
      </p>
    </div>
  );
}
