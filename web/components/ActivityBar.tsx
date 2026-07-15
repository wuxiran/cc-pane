import {
  Command, FolderTree, History, ListTodo, Settings, Files, Server, Boxes, Workflow,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useActivityBarStore, type ActivityView } from "@/stores/useActivityBarStore";
import { useDialogStore, useOrchestratorStore } from "@/stores";
import LayoutBar from "@/components/LayoutBar";

type ActivityBadge = number | { tone: "red" | "blue"; value?: number };

interface ActivityBarIconProps {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: ActivityBadge;
}

function ActivityBarIcon({ icon, label, active, onClick, badge }: ActivityBarIconProps) {
  const badgeValue = typeof badge === "number" ? badge : badge?.value;
  const showBadge = typeof badge === "number" ? badge > 0 : badge != null;
  const badgeTone = typeof badge === "number" ? "blue" : badge?.tone;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={`relative mx-auto h-10 w-10 rounded-xl flex items-center justify-center transition-all duration-200 ${
            active
              ? "text-[var(--app-accent)]"
              : "text-[var(--app-icon-inactive)] hover:text-[var(--app-icon-hover)] hover:bg-[var(--app-activity-item-hover)]"
          }`}
          style={{
            background: active ? "var(--app-activity-item-active)" : undefined,
            boxShadow: active ? "var(--app-activity-item-active-shadow)" : undefined,
          }}
          onClick={onClick}
        >
          {icon}
          {/* Badge */}
          {showBadge && (
            <span
              className={`absolute top-[4px] right-[4px] min-w-[14px] h-[14px] px-[3px] flex items-center justify-center rounded-full text-[9px] font-bold leading-none text-white ${
                badgeTone === "red" ? "bg-red-500" : "bg-[var(--app-accent)]"
              }`}
            >
              {badgeValue != null && badgeValue > 0 ? (badgeValue > 999 ? "999+" : badgeValue) : ""}
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
  const orchestrationOverlayOpen = useActivityBarStore((s) => s.orchestrationOverlayOpen);
  const toggleTodoMode = useActivityBarStore((s) => s.toggleTodoMode);
  const toggleHomeMode = useActivityBarStore((s) => s.toggleHomeMode);
  const toggleResourcesMode = useActivityBarStore((s) => s.toggleResourcesMode);
  const openSettings = useDialogStore((s) => s.openSettings);
  const orchestrationFailed = useOrchestratorStore((s) =>
    s.bindings.some((binding) => binding.status === "failed")
  );
  const orchestrationActiveCount = useOrchestratorStore((s) =>
    s.bindings.filter((binding) => binding.status === "running" || binding.status === "waiting")
      .length
  );

  const isViewActive = (view: ActivityView) => {
    if (view === "orchestration") return orchestrationOverlayOpen;
    if (view === "files") return appViewMode === "files";
    return activeView === view && sidebarVisible && appViewMode !== "files";
  };

  const viewItems: { view: ActivityView; icon: React.ReactNode; label: string; badge?: ActivityBadge }[] = [
    { view: "explorer", icon: <FolderTree className="w-[22px] h-[22px]" strokeWidth={1.5} />, label: t("workspaces") },
    { view: "files", icon: <Files className="w-[22px] h-[22px]" strokeWidth={1.5} />, label: t("fileBrowser", { defaultValue: "Files" }) },
    { view: "sessions", icon: <History className="w-[22px] h-[22px]" strokeWidth={1.5} />, label: t("recentLaunches") },
    // { view: "process", icon: <Activity className="w-[22px] h-[22px]" strokeWidth={1.5} />, label: t("processMonitor", { defaultValue: "Processes" }), badge: processCount }, // 已禁用（macOS 卡顿排查）
    { view: "ssh", icon: <Server className="w-[22px] h-[22px]" strokeWidth={1.5} />, label: t("sshMachines", { defaultValue: "SSH Machines" }) },
    {
      view: "orchestration",
      icon: <Workflow className="w-[22px] h-[22px]" strokeWidth={1.5} />,
      label: t("orchestration", { defaultValue: "Orchestration" }),
      badge: orchestrationFailed
        ? { tone: "red" }
        : orchestrationActiveCount > 0
          ? { tone: "blue", value: orchestrationActiveCount }
          : undefined,
    },
  ];

  return (
    <div
      className="activity-bar shrink-0 flex flex-col items-center select-none py-2"
      style={{
        width: 56,
        height: "100%",
        background: "var(--app-activity-bar-bg)",
        borderRight: "1px solid var(--app-activity-border)",
        backdropFilter: `blur(var(--app-glass-blur))`,
        WebkitBackdropFilter: `blur(var(--app-glass-blur))`,
        WebkitAppRegion: "no-drag",
      } as React.CSSProperties}
    >
      <div className="flex w-full flex-col items-center gap-2 pb-2">
        <ActivityBarIcon
          icon={<Command className="w-[22px] h-[22px]" strokeWidth={1.6} />}
          label={t("home")}
          active={appViewMode === "home"}
          onClick={toggleHomeMode}
        />
        <div
          className="h-px w-6"
          style={{ background: "var(--app-activity-border)" }}
        />
      </div>

      {/* 视图图标 */}
      <div className="flex flex-col w-full gap-1.5">
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

        {/* 资源中心（全屏 Provider / Skills / MCP 三合一大页面） */}
        <ActivityBarIcon
          icon={<Boxes className="w-[22px] h-[22px]" strokeWidth={1.5} />}
          label={t("resourceHub", { defaultValue: "资源中心" })}
          active={appViewMode === "resources"}
          onClick={toggleResourcesMode}
        />

        {/* Todo (切换全屏 todo 视图模式) */}
        <ActivityBarIcon
          icon={<ListTodo className="w-[22px] h-[22px]" strokeWidth={1.5} />}
          label={t("todoList")}
          active={appViewMode === "todo"}
          onClick={toggleTodoMode}
        />
      </div>

      {/* 底部设置 */}
      <div className="mt-auto flex w-full flex-col items-center gap-1.5 pb-2">
        <LayoutBar />
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
