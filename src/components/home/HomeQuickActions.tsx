import { useTranslation } from "react-i18next";
import { Terminal, FolderTree, Bot, Settings } from "lucide-react";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { useDialogStore } from "@/stores";

interface HomeQuickActionsProps {
  onNewTerminal: () => void;
}

interface QuickAction {
  icon: React.ReactNode;
  labelKey: string;
  onClick: () => void;
}

export default function HomeQuickActions({ onNewTerminal }: HomeQuickActionsProps) {
  const { t } = useTranslation("home");
  const setAppViewMode = useActivityBarStore((s) => s.setAppViewMode);
  const toggleView = useActivityBarStore((s) => s.toggleView);
  const toggleSelfChatMode = useActivityBarStore((s) => s.toggleSelfChatMode);
  const openSettings = useDialogStore((s) => s.openSettings);

  const actions: QuickAction[] = [
    {
      icon: <Terminal className="w-5 h-5" />,
      labelKey: "newTerminal",
      onClick: onNewTerminal,
    },
    {
      icon: <FolderTree className="w-5 h-5" />,
      labelKey: "workspaceManager",
      onClick: () => {
        setAppViewMode("panes");
        toggleView("explorer");
      },
    },
    {
      icon: <Bot className="w-5 h-5" />,
      labelKey: "aiAssistant",
      onClick: toggleSelfChatMode,
    },
    {
      icon: <Settings className="w-5 h-5" />,
      labelKey: "settings",
      onClick: openSettings,
    },
  ];

  return (
    <div className="grid grid-cols-4 gap-3">
      {actions.map((action) => (
        <button
          key={action.labelKey}
          className="home-quick-action flex flex-col items-center gap-2.5 p-5 rounded-xl transition-all duration-200 cursor-pointer hover:-translate-y-[1px] hover:shadow-md"
          style={{
            background: "var(--app-glass-bg)",
            border: "1px solid var(--app-border)",
          }}
          onClick={action.onClick}
        >
          <span
            className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{
              background: "color-mix(in srgb, var(--app-accent) 12%, transparent)",
              color: "var(--app-accent)",
            }}
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
