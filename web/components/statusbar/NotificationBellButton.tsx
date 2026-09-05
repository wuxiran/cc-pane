// 通知中心铃铛：未读 badge + 开关右下角历史面板（StatusBar 右端）
import { Bell } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { selectUnreadCount, useNotificationStore } from "@/stores/useNotificationStore";

export default function NotificationBellButton() {
  const { t } = useTranslation("notifications");
  const unreadCount = useNotificationStore(selectUnreadCount);
  const historyOpen = useNotificationStore((s) => s.historyOpen);
  const setHistoryOpen = useNotificationStore((s) => s.setHistoryOpen);

  // 可访问名必须承载未读数：按钮内容只有图标+角标，不把计数并进 label，
  // 读屏只会念出孤零零的数字。角标本身 aria-hidden，避免重复播报。
  const label =
    unreadCount > 0
      ? t("center.bellLabelUnread", { count: unreadCount })
      : t("center.bellTooltip");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-expanded={historyOpen}
          aria-controls="notification-history-panel"
          className="relative flex items-center px-1.5 py-0.5 rounded transition-colors hover:bg-[var(--app-hover)]"
          style={historyOpen ? { color: "var(--app-accent)" } : undefined}
          onClick={() => setHistoryOpen(!historyOpen)}
        >
          <Bell aria-hidden="true" className="w-3 h-3" />
          {unreadCount > 0 && (
            <span
              aria-hidden="true"
              className="absolute -top-0.5 right-0 flex h-[13px] min-w-[13px] items-center justify-center rounded-full px-0.5 text-[9px] font-bold tabular-nums text-white"
              style={{ background: "var(--app-status-danger)" }}
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p>{t("center.bellTooltip")}</p>
      </TooltipContent>
    </Tooltip>
  );
}
