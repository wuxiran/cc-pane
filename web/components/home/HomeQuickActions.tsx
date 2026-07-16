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

  return (
    <div className="grid grid-cols-3 gap-3">
      {actions.map((action) => (
        <button
          key={action.labelKey}
          className="home-quick-action group relative overflow-hidden flex flex-col items-center gap-3 p-5 rounded-2xl border border-[var(--app-home-border)] bg-[var(--app-home-surface)] transition-all duration-[var(--dur)] cursor-pointer hover:-translate-y-0.5 hover:border-[var(--app-home-border-hover)] hover:bg-[var(--app-home-surface-hover)] hover:shadow-[var(--sh-lg)]"
          onClick={action.onClick}
        >
          <span className="absolute inset-0 bg-gradient-to-b from-[var(--app-home-surface-light)] to-transparent opacity-0 transition-opacity duration-[var(--dur)] group-hover:opacity-100" />
          <span
            className="relative w-11 h-11 rounded-xl flex items-center justify-center transition-transform duration-[var(--dur)] group-hover:scale-110"
            style={{
              background: "var(--app-home-surface-light)",
              color: action.color,
            }}
          >
            {action.icon}
          </span>
          <span
            className="relative text-xs font-medium transition-colors duration-[var(--dur-fast)] group-hover:text-[var(--app-text-primary)]"
            style={{ color: "var(--app-text-primary)" }}
          >
            {t(action.labelKey as never)}
          </span>
        </button>
      ))}
    </div>
  );
}
