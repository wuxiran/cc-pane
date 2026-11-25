import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { toastErr, toastOk } from "@/lib/feedback";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { settingsService } from "@/services";
import type { ImChannelConfig, ImChannelType, ImEventKind, ImSettings } from "@/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import ImInboundFields from "./ImInboundFields";
import { SettingsHint, SettingsRow, SettingsSection, SettingsSwitchRow } from "./layout";

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
      toastOk(t("imTestSuccess"));
    } catch (e) {
      toastErr(t("imTestFailed", { error: e }));
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
    <>
      <SettingsSection title={t("imBridge")} description={t("imBridgeDescription")}>
        <SettingsSwitchRow
          id="im-bridge-enabled"
          title={t("enableImBridge")}
          checked={value.enabled}
          onCheckedChange={(checked) => update("enabled", checked)}
        />
        <SettingsSwitchRow
          id="im-push-when-focused"
          title={t("imPushWhenFocused")}
          description={t("imPushWhenFocusedDesc")}
          checked={value.pushWhenFocused}
          onCheckedChange={(checked) => update("pushWhenFocused", checked)}
        />
        <SettingsRow
          title={t("imChannels")}
          description={t("imPlainStorageHint")}
          control={(
            <Button
              size="sm"
              variant="secondary"
              onClick={() => update("channels", [...value.channels, newChannel()])}
            >
              {t("imAddChannel")}
            </Button>
          )}
        >
          {value.channels.length === 0 ? <SettingsHint>{t("imNoChannels")}</SettingsHint> : null}
        </SettingsRow>
      </SettingsSection>

      {value.channels.map((channel) => (
        <ChannelCard
          key={channel.id}
          channel={channel}
          typeLabel={typeLabel}
          eventLabel={eventLabel}
          onChange={(patch) => updateChannel(channel.id, patch)}
          onToggleEvent={(kind) => toggleEvent(channel, kind)}
          onRemove={() => removeChannel(channel.id)}
          onTest={() => void testChannel(channel)}
        />
      ))}
    </>
  );
}

interface ChannelCardProps {
  channel: ImChannelConfig;
  typeLabel: Record<ImChannelType, string>;
  eventLabel: Record<ImEventKind, string>;
  onChange: (patch: Partial<ImChannelConfig>) => void;
  onToggleEvent: (kind: ImEventKind) => void;
  onRemove: () => void;
  onTest: () => void;
}

/** 一个渠道 = 一张扁平卡片：标题是渠道名，右上角是测试/删除，卡内一行一个字段。 */
function ChannelCard({ channel, typeLabel, eventLabel, onChange, onToggleEvent, onRemove, onTest }: ChannelCardProps) {
  const { t } = useTranslation("settings");
  const fieldId = (field: string) => `im-channel-${channel.id}-${field}`;
  const eventsLabelId = fieldId("events-label");
  const inputClass = "h-8 text-[length:var(--text-row)]";

  return (
    <SettingsSection
      title={channel.name.trim() || typeLabel[channel.channelType]}
      actions={(
        <>
          <Button size="sm" variant="outline" onClick={onTest}>
            {t("imTestChannel")}
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="ghost" aria-label={t("imRemoveChannel")} onClick={onRemove}>
                <Trash2 className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("imRemoveChannel")}</TooltipContent>
          </Tooltip>
        </>
      )}
    >
      <SettingsSwitchRow
        id={fieldId("enabled")}
        title={t("imChannelEnabled")}
        checked={channel.enabled}
        onCheckedChange={(checked) => onChange({ enabled: checked })}
      />
      <SettingsRow
        title={t("imChannelType")}
        htmlFor={fieldId("type")}
        control={(
          <Select
            value={channel.channelType}
            onValueChange={(next) => onChange({ channelType: next as ImChannelType })}
          >
            <SelectTrigger
              id={fieldId("type")}
              aria-label={t("imChannelType")}
              className="w-44 shrink-0 bg-[var(--app-content)] text-[length:var(--text-row)]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CHANNEL_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {typeLabel[type]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      />
      <SettingsRow
        title={t("imChannelName")}
        htmlFor={fieldId("name")}
        control={(
          <Input
            id={fieldId("name")}
            value={channel.name}
            placeholder={typeLabel[channel.channelType]}
            className={`${inputClass} w-44`}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        )}
      />
      <SettingsRow title={t("imChannelUrl")} htmlFor={fieldId("url")}>
        <Input
          id={fieldId("url")}
          value={channel.url}
          placeholder="https://…"
          className={`${inputClass} font-mono`}
          onChange={(e) => onChange({ url: e.target.value })}
        />
      </SettingsRow>

      {SHOWS_SECRET.has(channel.channelType) && (
        <SettingsRow
          title={t("imChannelSecret")}
          description={<span id={fieldId("secret-hint")}>{t("imChannelSecretHint")}</span>}
          htmlFor={fieldId("secret")}
        >
          <Input
            id={fieldId("secret")}
            aria-describedby={fieldId("secret-hint")}
            type="password"
            value={channel.secret ?? ""}
            className={inputClass}
            onChange={(e) => onChange({ secret: e.target.value || null })}
          />
        </SettingsRow>
      )}

      {SHOWS_TOKEN.has(channel.channelType) && (
        <SettingsRow title={t("imChannelToken")} htmlFor={fieldId("token")}>
          <Input
            id={fieldId("token")}
            type="password"
            value={channel.token ?? ""}
            className={inputClass}
            onChange={(e) => onChange({ token: e.target.value || null })}
          />
        </SettingsRow>
      )}

      {SHOWS_CHAT_ID.has(channel.channelType) && (
        <SettingsRow title={t("imChannelChatId")} htmlFor={fieldId("chat-id")}>
          <Input
            id={fieldId("chat-id")}
            value={channel.chatId ?? ""}
            className={`${inputClass} font-mono`}
            onChange={(e) => onChange({ chatId: e.target.value || null })}
          />
        </SettingsRow>
      )}

      {channel.channelType === "telegram" && <ImInboundFields channel={channel} onChange={onChange} />}

      {/* 推送事件是多选集合（不是单个布尔设置），保留复选框组 */}
      <SettingsRow
        title={<span id={eventsLabelId}>{t("imChannelEvents")}</span>}
        description={t("imChannelEventsHint")}
      >
        <div role="group" aria-labelledby={eventsLabelId} className="flex flex-wrap gap-x-4 gap-y-1.5">
          {EVENT_KINDS.map((kind) => (
            <label
              key={kind}
              className="flex items-center gap-1.5 text-[length:var(--text-small)] text-[var(--app-text-secondary)]"
            >
              <input
                type="checkbox"
                checked={channel.events.includes(kind)}
                onChange={() => onToggleEvent(kind)}
                className="size-3.5 cursor-default"
                style={{ accentColor: "var(--app-accent)" }}
              />
              {eventLabel[kind]}
            </label>
          ))}
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
