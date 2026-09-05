// 标准通知卡：左 3px severity 色条 + 图标行 + 定位元信息 + 正文截断/展开。
// askInput 的输入区由 NotificationInputCard 包装追加，本组件只负责公共骨架。
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  CheckCircle2,
  CircleHelp,
  Info,
  X,
} from "lucide-react";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { Button } from "@/components/ui/button";
import { classifyNotification, type NotificationSeverity } from "@/lib/notificationTaxonomy";
import type { NotificationRecord } from "@/stores/useNotificationStore";
import {
  displayTitle,
  focusNotificationSession,
  formatRelativeTime,
  jumpToNotificationTask,
  locateNotificationSession,
} from "./notificationActions";

/** 正文超过此长度才出现「展开全文」；2 行 clamp 大约容纳 60 个中文字符 */
const EXPANDABLE_BODY_LENGTH = 56;

const SEVERITY_STYLE: Record<
  NotificationSeverity,
  { stripe: string; icon: ReactNode }
> = {
  error: {
    stripe: "var(--app-status-danger)",
    icon: <AlertCircle size={15} style={{ color: "var(--app-status-danger)" }} />,
  },
  warning: {
    stripe: "var(--app-status-warning)",
    icon: <CircleHelp size={15} style={{ color: "var(--app-status-warning)" }} />,
  },
  success: {
    stripe: "var(--app-status-success)",
    icon: <CheckCircle2 size={15} style={{ color: "var(--app-status-success)" }} />,
  },
  info: {
    stripe: "var(--app-accent)",
    icon: <Info size={15} style={{ color: "var(--app-accent)" }} />,
  },
};

export interface NotificationCardProps {
  record: NotificationRecord;
  onDismiss: (id: string) => void;
  /** askInput 包装组件把输入区从这里塞进来 */
  footer?: ReactNode;
  /** 覆盖默认动作行（askInput 的「聚焦会话/忽略」由包装组件自带） */
  hideActions?: boolean;
}

export default function NotificationCard({
  record,
  onDismiss,
  footer,
  hideActions,
}: NotificationCardProps) {
  const { t } = useTranslation("notifications");
  const [expanded, setExpanded] = useState(false);
  const severity = classifyNotification(record).severity;
  const style = SEVERITY_STYLE[severity];
  const location = useMemo(
    () => locateNotificationSession(record.sessionId),
    [record.sessionId],
  );
  const body = record.body?.trim();
  const expandable = Boolean(body && body.length > EXPANDABLE_BODY_LENGTH);
  const canFocusSession = Boolean(record.sessionId && location);
  const canViewTask = Boolean(record.taskBindingId);

  return (
    <div
      data-testid={`notification-card-${record.id}`}
      className="relative w-full overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] shadow-lg motion-safe:animate-in motion-safe:slide-in-from-bottom-2 motion-safe:fade-in motion-safe:duration-[var(--dur-slow)] motion-safe:ease-[var(--ease-out)]"
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: style.stripe }}
      />
      <div className="py-2.5 pl-3.5 pr-3">
        <div className="flex items-center gap-1.5">
          <span aria-hidden="true" className="flex size-[15px] shrink-0 items-center justify-center">
            {style.icon}
          </span>
          <span className="truncate text-[13px] font-semibold text-[var(--app-text-primary)]">
            {displayTitle(record.kind, record.title, t)}
          </span>
          {record.source && (
            <span className="shrink-0 rounded-full border border-[var(--app-border)] px-1.5 text-[10px] font-semibold text-[var(--app-text-secondary)]">
              {record.source}
            </span>
          )}
          <span className="flex-1" />
          <IconTooltipButton label={t("center.close")} side="left" onClick={() => onDismiss(record.id)}>
            <X aria-hidden="true" size={14} />
          </IconTooltipButton>
        </div>

        <p className="ml-[22px] mt-0.5 text-[11px] text-[var(--app-text-tertiary)]">
          {location && (
            <span className="text-[var(--app-text-secondary)]">
              {location.layoutName} · {t("center.paneLocation", { index: location.paneIndex })}
              {" · "}
            </span>
          )}
          {formatRelativeTime(record.timestamp, t)}
        </p>

        {body && (
          <>
            <p
              className={
                expanded
                  ? "ml-[22px] mt-1.5 max-h-[150px] overflow-y-auto whitespace-pre-wrap pr-1 text-[12.5px] leading-5 text-[var(--app-text-secondary)]"
                  : "ml-[22px] mt-1.5 line-clamp-2 whitespace-pre-wrap text-[12.5px] leading-5 text-[var(--app-text-secondary)]"
              }
            >
              {body}
            </p>
            {expandable && (
              <button
                type="button"
                className="ml-[22px] mt-1 text-[11.5px] text-[var(--app-accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? t("center.collapse") : t("center.expand")}
              </button>
            )}
          </>
        )}

        {footer}

        {!hideActions && (canFocusSession || canViewTask) && (
          <div className="ml-[22px] mt-2 flex justify-end gap-1.5">
            {canViewTask && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11.5px]"
                onClick={() => jumpToNotificationTask(record.taskBindingId as string)}
              >
                {t("center.viewTask")}
              </Button>
            )}
            {canFocusSession && (
              <Button
                size="sm"
                variant="secondary"
                className="h-6 px-2 text-[11.5px]"
                onClick={() => {
                  focusNotificationSession(record.sessionId as string);
                  onDismiss(record.id);
                }}
              >
                {t("center.focusSession")}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
