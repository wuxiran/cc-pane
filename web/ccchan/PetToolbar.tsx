// 悬停控件条：会话列表 / 问 Bot / 切换 Bot / 收起。
import { useTranslation } from "react-i18next";
import { ListTodo, Minimize2, Pencil, UsersRound, type LucideIcon } from "lucide-react";
import { TOOLBAR_AREA } from "./petLayout";

interface PetToolbarProps {
  top: number;
  botName: string;
  urgentCount: number;
  onSessions: () => void;
  onAsk: () => void;
  onSwitchBot: () => void;
  onCollapse: () => void;
}

export function PetToolbar({ top, botName, urgentCount, onSessions, onAsk, onSwitchBot, onCollapse }: PetToolbarProps) {
  const { t } = useTranslation("ccchan");
  const buttons: { key: string; label: string; icon: LucideIcon; action: () => void; badge?: number }[] = [
    { key: "sessions", label: t("toolbar.sessions"), icon: ListTodo, action: onSessions, badge: urgentCount },
    { key: "ask", label: t("toolbar.ask", { name: botName }), icon: Pencil, action: onAsk },
    { key: "switch", label: t("toolbar.switchBot"), icon: UsersRound, action: onSwitchBot },
    { key: "collapse", label: t("toolbar.collapse"), icon: Minimize2, action: onCollapse },
  ];
  return (
    <div
      data-testid="pet-toolbar"
      className="absolute left-0 right-0 z-10 flex items-center justify-center"
      style={{ top, height: TOOLBAR_AREA }}
    >
      <div
        className="flex items-center gap-0.5 rounded-full border px-1 py-0.5 shadow-md"
        style={{ background: "var(--popover)", borderColor: "var(--border)", color: "var(--popover-foreground)" }}
      >
        {buttons.map(({ key, label, icon: Icon, action, badge }) => (
          <button
            key={key}
            type="button"
            aria-label={label}
            title={label}
            className="relative flex h-6 w-6 items-center justify-center rounded-full transition-colors hover:bg-[var(--accent)]"
            onClick={(event) => {
              event.stopPropagation();
              action();
            }}
          >
            <Icon size={14} />
            {badge ? (
              <span
                className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 text-[length:var(--text-micro)] font-semibold leading-none"
                style={{ background: "var(--app-status-warning)", color: "var(--primary-foreground)" }}
              >
                {badge > 9 ? "9+" : badge}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}
