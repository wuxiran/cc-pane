import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Terminal, FolderTree, Settings } from "lucide-react";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { useDialogStore } from "@/stores";

interface HomeQuickActionsProps {
  onNewTerminal: () => void;
}

interface QuickAction {
  icon: ReactNode;
  labelKey: string;
  color: string;
  onClick: () => void;
}

export default function HomeQuickActions({ onNewTerminal }: HomeQuickActionsProps) {
  const { t } = useTranslation("home");
  const setAppViewMode = useActivityBarStore((s) => s.setAppViewMode);
  const toggleView = useActivityBarStore((s) => s.toggleView);
  const openSettings = useDialogStore((s) => s.openSettings);

  const actions: QuickAction[] = [
    {
      icon: <Terminal className="w-5 h-5" />,
      labelKey: "newTerminal",
      color: "var(--chart-1)",
      onClick: onNewTerminal,
    },
    {
      icon: <FolderTree className="w-5 h-5" />,
      labelKey: "workspaceManager",
      color: "var(--chart-4)",
      onClick: () => {
        setAppViewMode("panes");
        toggleView("explorer");
      },
    },
    {
      icon: <Settings className="w-5 h-5" />,
      labelKey: "settings",
      color: "var(--app-text-tertiary)",
      onClick: openSettings,
    },
  ];

  // 紧凑横排按钮组：图标+文字一行，避免宽屏下三个大空卡
  return (
    <div className="flex flex-wrap items-center gap-2">
      {actions.map((action) => (
        <button
          key={action.labelKey}
          className="home-quick-action group inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--app-home-border)] bg-[var(--app-home-surface)] px-3.5 transition-all duration-[var(--dur-fast)] cursor-pointer hover:border-[var(--app-home-border-hover)] hover:bg-[var(--app-home-surface-hover)]"
          onClick={action.onClick}
        >
          <span
            className="inline-flex items-center justify-center [&>svg]:w-4 [&>svg]:h-4"
            style={{ color: action.color }}
          >
            {action.icon}
          </span>
          <span
            className="text-xs font-medium"
            style={{ color: "var(--app-text-primary)" }}
          >
            {t(action.labelKey as never)}
          </span>
        </button>
      ))}
    </div>
  );
}
