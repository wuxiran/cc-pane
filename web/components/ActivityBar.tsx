import {
  Command, FolderTree, Search, History, Bot, ListTodo, Settings, Files, Server, Activity,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useActivityBarStore, type ActivityView } from "@/stores/useActivityBarStore";
import { useDialogStore, useProcessMonitorStore } from "@/stores";

interface ActivityBarIconProps {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: number;
}

function ActivityBarIcon({ icon, label, active, onClick, badge }: ActivityBarIconProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={`relative w-full h-[40px] flex items-center justify-center transition-colors duration-150 ${
            active
              ? "text-[var(--app-icon-active)]"
              : "text-[var(--app-icon-inactive)] hover:text-[var(--app-icon-hover)]"
          }`}
          style={{
            background: active ? "var(--app-hover)" : undefined,
          }}
          onClick={onClick}
        >
          {/* 左侧高亮条 */}
          {active && (
            <div
              className="absolute left-0 top-[25%] bottom-[25%] w-[3px] rounded-r"
              style={{ background: "var(--app-accent)" }}
            />
          )}
          {icon}
          {/* Badge */}
          {badge != null && badge > 0 && (
            <span
              className={`absolute top-[4px] right-[4px] min-w-[14px] h-[14px] px-[3px] flex items-center justify-center rounded-full text-[9px] font-bold leading-none text-white ${
                badge > 50 ? "bg-red-500" : "bg-[var(--app-accent)]"
              }`}
            >
              {badge > 999 ? "999+" : badge}
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        <p>{label}</p>
      </TooltipContent>
    </Tooltip>
  );
}

export default function ActivityBar() {
  const { t } = useTranslation("sidebar");
  const activeView = useActivityBarStore((s) => s.activeView);
  const sidebarVisible = useActivityBarStore((s) => s.sidebarVisible);
  const toggleView = useActivityBarStore((s) => s.toggleView);
  const appViewMode = useActivityBarStore((s) => s.appViewMode);
  const toggleTodoMode = useActivityBarStore((s) => s.toggleTodoMode);
  const toggleSelfChatMode = useActivityBarStore((s) => s.toggleSelfChatMode);
  const toggleHomeMode = useActivityBarStore((s) => s.toggleHomeMode);
  const openSettings = useDialogStore((s) => s.openSettings);

  const processCount = useProcessMonitorStore((s) => s.scanResult?.totalCount ?? 0);

  const isHomeActive = appViewMode === "home";

  const isViewActive = (view: ActivityView) => {
    if (view === "files") return appViewMode === "files";
    return activeView === view && sidebarVisible && appViewMode !== "files";
  };

  const viewItems: { view: ActivityView; icon: React.ReactNode; label: string; badge?: number }[] = [
    { view: "explorer", icon: <FolderTree className="w-[22px] h-[22px]" strokeWidth={1.5} />, label: t("workspaces") },
    { view: "files", icon: <Files className="w-[22px] h-[22px]" strokeWidth={1.5} />, label: t("fileBrowser", { defaultValue: "Files" }) },
    { view: "search", icon: <Search className="w-[22px] h-[22px]" strokeWidth={1.5} />, label: t("search", { ns: "common", defaultValue: "Search" }) },
    { view: "sessions", icon: <History className="w-[22px] h-[22px]" strokeWidth={1.5} />, label: t("recentLaunches") },
    { view: "process", icon: <Activity className="w-[22px] h-[22px]" strokeWidth={1.5} />, label: t("processMonitor", { defaultValue: "Processes" }), badge: processCount },
    { view: "ssh", icon: <Server className="w-[22px] h-[22px]" strokeWidth={1.5} />, label: t("sshMachines", { defaultValue: "SSH Machines" }) },
  ];

  return (
    <div
      className="activity-bar shrink-0 flex flex-col items-center select-none"
      style={{
        width: 48,
        height: "100%",
        background: "var(--app-activity-bar-bg)",
        backdropFilter: `blur(var(--app-glass-blur))`,
        WebkitBackdropFilter: `blur(var(--app-glass-blur))`,
      }}
    >
      {/* Logo — 点击切换首页 */}
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="pt-1 pb-1 flex items-center justify-center">
            <button
              className="w-[28px] h-[28px] rounded-[7px] flex items-center justify-center transition-transform hover:scale-105 cursor-pointer"
              style={{
                background: isHomeActive ? "var(--app-accent)" : "var(--app-activity-bar-bg)",
                border: `1px solid ${isHomeActive ? "var(--app-accent)" : "var(--app-border)"}`,
                boxShadow: isHomeActive
                  ? "0 2px 8px color-mix(in srgb, var(--app-accent) 40%, transparent)"
                  : "var(--app-glass-shadow)",
              }}
              onClick={toggleHomeMode}
            >
              <Command
                className="w-[14px] h-[14px]"
                style={{ color: isHomeActive ? "white" : "var(--app-accent)" }}
              />
            </button>
          </div>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          <p>{t("home", { ns: "common", defaultValue: "Home" })}</p>
        </TooltipContent>
      </Tooltip>

      {/* Separator */}
      <div
        className="w-6 h-px mx-auto my-1"
        style={{ background: "var(--app-border)" }}
      />

      {/* 视图图标 */}
      <div className="flex flex-col w-full gap-0.5">
        {/* Self-Chat (AI 助手 — 置顶) */}
        <ActivityBarIcon
          icon={<Bot className="w-[22px] h-[22px]" strokeWidth={1.5} />}
          label={t("selfChat", { ns: "common", defaultValue: "Self Chat" })}
          active={appViewMode === "selfchat"}
          onClick={toggleSelfChatMode}
        />

        {viewItems.map((item) => (
          <ActivityBarIcon
            key={item.view}
            icon={item.icon}
            label={item.label}
            active={isViewActive(item.view)}
            onClick={() => toggleView(item.view)}
            badge={item.badge}
          />
        ))}

        {/* Todo (切换全屏 todo 视图模式) */}
        <ActivityBarIcon
          icon={<ListTodo className="w-[22px] h-[22px]" strokeWidth={1.5} />}
          label={t("todoList")}
          active={appViewMode === "todo"}
          onClick={toggleTodoMode}
        />
      </div>

      {/* 底部设置 */}
      <div className="mt-auto pb-3 w-full">
        <ActivityBarIcon
          icon={<Settings className="w-[22px] h-[22px]" strokeWidth={1.5} />}
          label={t("settings", { ns: "common", defaultValue: "Settings" })}
          active={false}
          onClick={openSettings}
        />
      </div>
    </div>
  );
}
