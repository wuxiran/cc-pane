// askInput 卡：标准卡骨架 + 输入回传区。
// 三个终态：已发送（✓ 已回传，随后 8s 自动消失，由 NotificationCenter 调度）、
// 会话失效降级（输入框不渲染）、提交失败（卡内错误行，可重试）。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  isNotificationSessionAlive,
  useNotificationStore,
  type NotificationRecord,
} from "@/stores/useNotificationStore";
import { getErrorMessage } from "@/utils";
import NotificationCard from "./NotificationCard";
import { focusNotificationSession } from "./notificationActions";

export interface NotificationInputCardProps {
  record: NotificationRecord;
  onDismiss: (id: string) => void;
}

export default function NotificationInputCard({ record, onDismiss }: NotificationInputCardProps) {
  const { t } = useTranslation("notifications");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 订阅 statusMap 变化会导致每条状态事件都重渲染；askInput 卡生命周期短，
  // 渲染时读一次 + 提交时 respond 内二次校验已够
  const sessionAlive = isNotificationSessionAlive(record.sessionId);
  const responded = record.respondedAt !== undefined;

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setError(null);
    try {
      await useNotificationStore.getState().respond(record.id, trimmed);
    } catch (reason) {
      setError(getErrorMessage(reason));
    } finally {
      setSending(false);
    }
  };

  const footer = responded ? (
    <p className="ml-[22px] mt-2 flex items-center gap-1.5 text-[12px] font-medium text-[var(--app-status-success)]">
      <Check aria-hidden="true" size={13} />
      {t("center.responded")}
    </p>
  ) : !sessionAlive ? (
    <p className="ml-[22px] mt-2 rounded-md border border-dashed border-[var(--app-border)] bg-[var(--app-input-bg)] px-2 py-1 text-[12px] text-[var(--app-text-tertiary)]">
      {t("center.sessionGone")}
    </p>
  ) : (
    <div className="ml-[22px] mt-2">
      <div className="flex gap-1.5">
        <input
          type="text"
          value={text}
          disabled={sending}
          placeholder={record.inputPlaceholder || t("center.inputPlaceholder")}
          className="min-w-0 flex-1 rounded-md border border-[var(--app-border)] bg-[var(--app-input-bg)] px-2 py-1 text-[12.5px] text-[var(--app-text-primary)] placeholder:text-[var(--app-text-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <Button
          size="sm"
          className="h-[26px] shrink-0 px-2.5 text-[11.5px]"
          disabled={sending || !text.trim()}
          onClick={() => void submit()}
        >
          {sending ? (
            <LoaderCircle aria-hidden="true" size={13} className="motion-safe:animate-spin" />
          ) : null}
          {sending ? t("center.sending") : t("center.send")}
        </Button>
      </div>
      {error && (
        <p className="mt-1 text-[11.5px] text-[var(--app-status-danger)]">{error}</p>
      )}
      <div className="mt-1.5 flex justify-end gap-1.5">
        {record.sessionId && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11.5px]"
            onClick={() => {
              focusNotificationSession(record.sessionId as string);
              onDismiss(record.id);
            }}
          >
            {t("center.focusSession")}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[11.5px]"
          onClick={() => onDismiss(record.id)}
        >
          {t("center.ignore")}
        </Button>
      </div>
    </div>
  );

  return <NotificationCard record={record} onDismiss={onDismiss} footer={footer} hideActions />;
}
