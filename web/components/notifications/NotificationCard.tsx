import { NotificationSoundControl, NotificationSnoozeControl } from "./NotificationPreferenceControls";
// 标准通知卡：淡底 severity 图标块 + 标题行 + 定位元信息 + 正文截断/展开。
// askInput 的输入区由 NotificationInputCard 包装追加，本组件只负责公共骨架。
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  CheckCircle2,
  CircleHelp,
  Info,
  X,
  type LucideIcon,
} from "lucide-react";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { Button } from "@/components/ui/button";
import { classifyNotification, type NotificationSeverity } from "@/lib/notificationTaxonomy";
import type { NotificationRecord } from "@/stores/useNotificationStore";
import {
  displayTitle,
  focusNotificationSession,
  formatRelativeTime,
  handleAdoptQuickTerminal,
  jumpToNotificationTask,
  locateNotificationSession,
} from "./notificationActions";
import { useQuickTerminalSessionStore } from "@/stores/useQuickTerminalSessionStore";

/** 正文超过此长度才出现「展开全文」；2 行 clamp 大约容纳 60 个中文字符 */
const EXPANDABLE_BODY_LENGTH = 56;

// 等级只靠标题前的淡底图标块表达：原来的左侧 3px 色条和圆角卡片边缘打架，显得粗糙。
const SEVERITY_STYLE: Record<NotificationSeverity, { tone: string; Icon: LucideIcon }> = {
  error: { tone: "var(--app-status-danger)", Icon: AlertCircle },
  warning: { tone: "var(--app-status-warning)", Icon: CircleHelp },
  success: { tone: "var(--app-status-success)", Icon: CheckCircle2 },
  info: { tone: "var(--app-accent)", Icon: Info },
};

export interface NotificationCardProps {
  record: NotificationRecord;
  onDismiss: (id: string) => void;
  /** askInput 包装组件把输入区从这里塞进来（位于正文与动作行之间） */
  footer?: ReactNode;
  /** 覆盖动作行右侧按钮（askInput 的「忽略/聚焦会话」由包装组件提供）；null = 不渲染 */
  actions?: ReactNode | null;
}

export default function NotificationCard({
  record,
  onDismiss,
  footer,
  actions,
}: NotificationCardProps) {
  const { t } = useTranslation("notifications");
  const [expanded, setExpanded] = useState(false);
  const severity = classifyNotification(record).severity;
  const style = SEVERITY_STYLE[severity];
  // 订阅快捷终端登记（F1.4）：定位回退读它，不订阅的话卡片挂载时算一次就定住了，
  // 快捷窗口后开的会话永远长不出「聚焦会话」。选中 id 而非整条记录，
  // 避免登记项换引用就重算（定位结果只依赖是否匹配这条通知的会话）。
  const quickTerminalSessionId = useQuickTerminalSessionStore((s) => s.session?.sessionId);
  const location = useMemo(
    () => locateNotificationSession(record.sessionId),
    // quickTerminalSessionId 变化时重算：回退分支的结论取决于它。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [record.sessionId, quickTerminalSessionId],
  );
  const body = record.body?.trim();
  const expandable = Boolean(body && body.length > EXPANDABLE_BODY_LENGTH);
  const canFocusSession = Boolean(record.sessionId && location);
  const canViewTask = Boolean(record.taskBindingId);
  // 只有住在快捷窗口的会话才给「在主窗口打开」：布局里的会话本来就在那儿。
  const canAdoptFromQuickTerminal = location?.kind === "quickTerminal";

  const defaultActions = canFocusSession || canViewTask || canAdoptFromQuickTerminal ? (
    <>
      {canViewTask && (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[length:var(--text-small)]"
          onClick={() => jumpToNotificationTask(record.taskBindingId as string)}
        >
          {t("center.viewTask")}
        </Button>
      )}
      {canAdoptFromQuickTerminal && (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[length:var(--text-small)]"
          onClick={() => {
            // 接管成功才 dismiss：失败时卡片要留着，用户还得再试或改走「聚焦会话」。
            void handleAdoptQuickTerminal(record.sessionId, t).then((adopted) => {
              if (adopted) onDismiss(record.id);
            });
          }}
        >
          {t("center.adoptToMainWindow")}
        </Button>
      )}
      {canFocusSession && (
        <Button
          size="sm"
          variant="secondary"
          className="h-6 px-2 text-[length:var(--text-small)]"
          onClick={() => {
            // 聚焦现在异步（F7.3 弹出窗口），但 dismiss 与聚焦结果无关，照旧立即执行。
            void focusNotificationSession(record.sessionId as string);
            onDismiss(record.id);
          }}
        >
          {t("center.focusSession")}
        </Button>
      )}
    </>
  ) : null;
  const rightActions = actions === undefined ? defaultActions : actions;
  const hasSnooze = Boolean(record.sessionId);

  return (
    <div
      data-testid={`notification-card-${record.id}`}
      className="relative w-full overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] shadow-lg motion-safe:animate-in motion-safe:slide-in-from-bottom-2 motion-safe:fade-in motion-safe:duration-[var(--dur-slow)] motion-safe:ease-[var(--ease-out)]"
    >
      <div className="px-3 py-3">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="flex size-5 shrink-0 items-center justify-center rounded-md"
            style={{
              color: style.tone,
              background: `color-mix(in srgb, ${style.tone} 16%, transparent)`,
            }}
          >
            <style.Icon size={13} strokeWidth={2.2} />
          </span>
          <span className="min-w-0 flex-1 truncate text-[length:var(--text-row)] font-semibold text-[var(--app-text-primary)]">
            {displayTitle(record.kind, record.title, t)}
          </span>
          <div className="-mr-1 flex shrink-0 items-center text-[var(--app-text-tertiary)]">
            <NotificationSoundControl sessionId={record.sessionId} />
            <IconTooltipButton label={t("center.close")} side="left" onClick={() => onDismiss(record.id)}>
              <X aria-hidden="true" size={14} />
            </IconTooltipButton>
          </div>
        </div>

        {/* 元信息一行收齐：位置 · 来源 · 时间。来源不再单独做胶囊，避免和标题抢视线。 */}
        <p className="ml-7 mt-0.5 truncate text-[length:var(--text-caption)] text-[var(--app-text-tertiary)]">
          {location && (
            <span className="text-[var(--app-text-secondary)]">
              {location.kind === "layout"
                ? `${location.layoutName} · ${t("center.paneLocation", { index: location.paneIndex })}`
                : t("center.quickTerminalLocation")}
            </span>
          )}
          {location && " · "}
          {record.source && <>{record.source}{" · "}</>}
          {formatRelativeTime(record.timestamp, t)}
        </p>

        {body && (
          <>
            <p
              className={
                expanded
                  ? "ml-7 mt-1.5 max-h-[150px] overflow-y-auto whitespace-pre-wrap pr-1 text-[length:var(--text-row)] leading-5 text-[var(--app-text-secondary)]"
                  : "ml-7 mt-1.5 line-clamp-2 whitespace-pre-wrap text-[length:var(--text-row)] leading-5 text-[var(--app-text-secondary)]"
              }
            >
              {body}
            </p>
            {expandable && (
              <button
                type="button"
                aria-expanded={expanded}
                className="ml-7 mt-1 text-[length:var(--text-small)] text-[var(--app-accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? t("center.collapse") : t("center.expand")}
              </button>
            )}
          </>
        )}

        {footer}

        {/* 唯一动作行：左「暂不提醒」，右侧主操作；不再拆成多行。 */}
        {(hasSnooze || rightActions) && (
          <div className="ml-7 mt-2.5 flex items-center gap-1.5">
            <NotificationSnoozeControl sessionId={record.sessionId} />
            <span className="flex-1" />
            {rightActions}
          </div>
        )}
      </div>
    </div>
  );
}
