import { ArrowUpCircle, Boxes, CalendarClock, Clapperboard, Cloud, Contact, FolderTree, House, Library, Settings } from "lucide-react";
import { ACTIVITY_ICON_ACTIVE, ACTIVITY_ICON_IDLE } from "@/components/activityBarIconStyle";
import { openAutomationsDialog } from "@/stores/useAutomationsDialogStore";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import LayoutBar from "@/components/LayoutBar";
import { useLibrarySpaceEntry } from "@/components/library/LibrarySpaceEntry";
import ModuleAddMenu from "@/components/modules/ModuleAddMenu";
import ModulePlacementHint from "@/components/modules/ModulePlacementHint";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  MODULE_CONSUMERS,
  type ModuleBadge,
  type ModuleId,
  type ModulePosition,
} from "@/modules/registry";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { useModulePrefsStore } from "@/stores/useModulePrefsStore";
import { useAiPanelStore } from "@/stores/useAiPanelStore";
import { useDialogStore, useLayoutUiStore, useOrchestratorStore } from "@/stores";
import { useExperimentalFeature } from "@/hooks/useExperimentalFeature";
import { useUpdateStore } from "@/stores/useUpdateStore";
import { isTauriRuntime } from "@/services/runtime";
// 直接从模块导入：与 StatusBar 更新按钮共用同一条 triggerUpdate 流程（重新 check → 原生确认 → 下载安装 → 重启）
import { triggerUpdate } from "@/services/updaterService";
import { handleErrorSilent } from "@/utils";

const ICON_CLASS = "h-[18px] w-[18px]";

interface ActivityBarIconProps {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: ModuleBadge;
  moduleId?: ModuleId;
  /** 强调态：图标用 accent 色（非选中语义，用于「有事要做」的入口，如升级） */
  emphasized?: boolean;
  /** 右上角 accent 小圆点（无数字） */
  dot?: boolean;
  disabled?: boolean;
  busy?: boolean;
  testId?: string;
}

function ActivityBarIcon({
  icon,
  label,
  active,
  onClick,
  badge,
  moduleId,
  emphasized = false,
  dot = false,
  disabled = false,
  busy = false,
  testId,
}: ActivityBarIconProps) {
  const badgeValue = typeof badge === "number" ? badge : badge?.value;
  const showBadge = typeof badge === "number" ? badge > 0 : badge != null;
  const badgeTone = typeof badge === "number" ? "blue" : badge?.tone;

  return (
    <div className="relative flex w-full justify-center" data-module-id={moduleId}>
      {active && (
        <span
          aria-hidden
          className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-md bg-[var(--app-accent)]"
        />
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            aria-busy={busy || undefined}
            data-testid={testId}
            // 用 aria-disabled 而不是原生 disabled：原生 disabled 会吞掉 pointer 事件，进行态的 tooltip 就显示不出来
            aria-disabled={disabled || undefined}
            className={`relative flex h-8 w-8 items-center justify-center rounded-lg transition-[color,background-color,transform] duration-[var(--dur)] ease-[var(--ease-out)] active:scale-[0.96] aria-disabled:cursor-default aria-disabled:active:scale-100 ${
              active
                ? ACTIVITY_ICON_ACTIVE
                : emphasized
                  ? "text-[var(--app-accent)] hover:bg-[color-mix(in_srgb,var(--app-text-primary)_7%,transparent)]"
                  : ACTIVITY_ICON_IDLE
            }`}
            style={{ boxShadow: active ? "var(--app-activity-item-active-shadow)" : undefined }}
            onClick={disabled ? undefined : onClick}
          >
            {icon}
            {dot && !showBadge && (
              <span
                aria-hidden
                data-testid={testId ? `${testId}-dot` : undefined}
                className="absolute -right-[1px] -top-[1px] h-2 w-2 rounded-full bg-[var(--app-accent)] ring-2 ring-[var(--app-activity-bar-bg)]"
              />
            )}
            {showBadge && (
              <span
                className={`absolute -right-[3px] -top-[3px] flex h-[14px] min-w-[14px] items-center justify-center rounded-full px-[3px] text-[length:var(--text-nano)] font-bold leading-none text-white ${
                  badgeTone === "red"
                    ? "bg-[var(--app-status-danger)]"
                    : badgeTone === "amber"
                      ? "bg-[var(--app-status-warning)]"
                      : "bg-[var(--app-accent)]"
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
    </div>
  );
}

/**
 * 有可用更新时出现在底部图标组最上方的升级入口。
 * 点击复用 StatusBar 同一条 triggerUpdate 流程；流程期间（确认框 + 下载安装）禁用防重复点击。
 */
function ActivityBarUpdateButton() {
  const { t } = useTranslation("sidebar");
  const available = useUpdateStore((state) => state.available);
  const version = useUpdateStore((state) => state.version);
  const [updating, setUpdating] = useState(false);
  // 同步闸：state 更新前的连点（同一帧两次 click）也只触发一次流程
  const inFlightRef = useRef(false);

  // 非桌面运行时 triggerUpdate 直接 no-op，入口出现只会是「点了没用」
  if (!isTauriRuntime() || !available || !version) return null;

  const handleClick = async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setUpdating(true);
    try {
      await triggerUpdate();
    } catch (error) {
      // triggerUpdate 内部已对检查/下载失败弹窗；这里兜住意外抛出，避免变成未处理拒绝
      handleErrorSilent(error, "activity bar update");
    } finally {
      inFlightRef.current = false;
      setUpdating(false);
    }
  };

  return (
    <ActivityBarIcon
      testId="activity-bar-update"
      icon={
        <ArrowUpCircle
          className={`${ICON_CLASS} ${updating ? "animate-spin motion-reduce:animate-none" : ""}`}
        />
      }
      label={updating ? t("appUpdate.updating", { version }) : t("appUpdate.available", { version })}
      active={false}
      emphasized
      dot={!updating}
      disabled={updating}
      busy={updating}
      onClick={() => void handleClick()}
    />
  );
}

function ModuleContextMenu() {
  const { t } = useTranslation("sidebar");
  const preferences = useModulePrefsStore((state) => state.preferences);
  const setEnabled = useModulePrefsStore((state) => state.setEnabled);
  const setPosition = useModulePrefsStore((state) => state.setPosition);

  const changePosition = (id: ModuleId, position: ModulePosition) => {
    setPosition(id, position);
    if (!preferences[id].enabled) setEnabled(id, true);
  };

  return (
    <ContextMenuContent className="w-56 text-[length:var(--text-row)]">
      <ContextMenuLabel className="text-[length:var(--text-row)]">
        {t("moduleMenu.title")}
      </ContextMenuLabel>
      <ContextMenuSeparator />
      {MODULE_CONSUMERS.contextMenu.filter((module) => module.configurable !== false).map((module) => {
        const Icon = module.icon;
        const preference = preferences[module.id];
        return (
          <ContextMenuSub key={module.id}>
            <ContextMenuSubTrigger
              data-testid={`module-menu-${module.id}`}
              className="text-[length:var(--text-row)]"
            >
              <Icon aria-hidden="true" className="size-4" strokeWidth={1.6} />
              <span className="truncate">{t(module.titleKey as never)}</span>
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-52 text-[length:var(--text-row)]">
              <ContextMenuCheckboxItem
                data-testid={`module-enabled-${module.id}`}
                checked={preference.enabled}
                className="text-[length:var(--text-row)]"
                onCheckedChange={(checked) => setEnabled(module.id, checked === true)}
              >
                {t("moduleMenu.enabled")}
              </ContextMenuCheckboxItem>
              <ContextMenuSeparator />
              <ContextMenuRadioGroup
                value={preference.position}
              >
                {module.surfaces.includes("activityBar") && (
                <ContextMenuRadioItem
                  data-testid={`module-position-${module.id}-activityBar`}
                  value="activityBar"
                  aria-label={t("moduleMenu.activityBar")}
                  className="text-[length:var(--text-row)]"
                  onSelect={() => changePosition(module.id, "activityBar")}
                >
                  {t("moduleMenu.activityBar")}
                </ContextMenuRadioItem>
                )}
                {module.surfaces.includes("rightDock") && (
                <ContextMenuRadioItem
                  data-testid={`module-position-${module.id}-rightDock`}
                  value="rightDock"
                  aria-label={t("moduleMenu.rightDock")}
                  className="text-[length:var(--text-row)]"
                  onSelect={() => changePosition(module.id, "rightDock")}
                >
                  <span>{t("moduleMenu.rightDock")}</span>
                  <ModulePlacementHint label={t("moduleMenu.placementHint")} />
                </ContextMenuRadioItem>
                )}
                <ContextMenuRadioItem
                  data-testid={`module-position-${module.id}-hidden`}
                  value="hidden"
                  aria-label={t("moduleMenu.hidden")}
                  className="text-[length:var(--text-row)]"
                  onSelect={() => changePosition(module.id, "hidden")}
                >
                  <span>{t("moduleMenu.hidden")}</span>
                  <ModulePlacementHint label={t("moduleMenu.placementHint")} />
                </ContextMenuRadioItem>
              </ContextMenuRadioGroup>
            </ContextMenuSubContent>
          </ContextMenuSub>
        );
      })}
    </ContextMenuContent>
  );
}

export default function ActivityBar() {
  const { t } = useTranslation("sidebar");
  const layoutSwitcherMode = useLayoutUiStore((state) => state.switcherMode);
  const activeView = useActivityBarStore((state) => state.activeView);
  const sidebarVisible = useActivityBarStore((state) => state.sidebarVisible);
  const activityBarVisible = useActivityBarStore((state) => state.activityBarVisible);
  const toggleView = useActivityBarStore((state) => state.toggleView);
  const toggleDramaGenMode = useActivityBarStore((state) => state.toggleDramaGenMode);
  const toggleResourcesMode = useActivityBarStore((state) => state.toggleResourcesMode);
  const appViewMode = useActivityBarStore((state) => state.appViewMode);
  const orchestrationOverlayOpen = useActivityBarStore((state) => state.orchestrationOverlayOpen);
  const openSettings = useDialogStore((state) => state.openSettings);
  const bindings = useOrchestratorStore((state) => state.bindings);
  const aiPanelUnreadCount = useAiPanelStore((state) => state.unreadPanelIds.length);
  const preferences = useModulePrefsStore((state) => state.preferences);
  // 实验功能入口：设置里勾选后才出现（默认关，客户装上看不到）。
  const dramaStudioEnabled = useExperimentalFeature("dramaStudio");
  const librarySpaceEnabled = useExperimentalFeature("librarySpace");
  const librarySpace = useLibrarySpaceEntry();

  const visibleModules = MODULE_CONSUMERS.activityBar.filter((module) => {
    const preference = preferences[module.id];
    return preference.enabled
      && preference.position === "activityBar"
      && module.surfaces.includes("activityBar");
  });

  // 标题栏折叠按钮把两者一起收起；任何路径重新拉出侧栏时图标条自动跟随回归
  if (!activityBarVisible && !sidebarVisible) return null;

  const isModuleActive = (id: ModuleId) => {
    if (id === "orchestration") return orchestrationOverlayOpen;
    if (id === "todo") return appViewMode === id && sidebarVisible;
    return activeView === id && sidebarVisible && appViewMode === "panes";
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-testid="activity-bar"
          data-material-surface=""
          className="activity-bar shape-surface flex shrink-0 select-none flex-col items-center py-2"
          style={{
            width: 44,
            height: "100%",
            background: "var(--app-activity-bar-bg)",
            borderRight: "1px solid var(--app-activity-border)",
            WebkitAppRegion: "no-drag",
          } as React.CSSProperties}
        >
          <div className="flex w-full flex-col items-center gap-2 pb-2">
            <ActivityBarIcon
              icon={<House className={ICON_CLASS} />}
              label={t("home")}
              active={appViewMode === "home"}
              onClick={useActivityBarStore.getState().toggleHomeMode}
            />
            <div
              className="h-px w-6"
              style={{ background: "var(--app-activity-border)" }}
            />
          </div>

          <div className="flex w-full flex-col gap-1.5">
            <ActivityBarIcon
              icon={<FolderTree className={ICON_CLASS} />}
              label={t("workspaces")}
              active={activeView === "explorer" && sidebarVisible && appViewMode === "panes"}
              onClick={() => toggleView("explorer")}
            />
            {/* 供应商 / 运行配置：独立入口，不再埋在设置里 */}
            <ActivityBarIcon
              icon={<Cloud className={ICON_CLASS} />}
              label={t("providers")}
              active={appViewMode === "providers"}
              onClick={useActivityBarStore.getState().toggleProvidersMode}
            />
            {/* 通讯录：常驻、有人设的 Bot 联系人（原在资源管理器标题旁） */}
            <ActivityBarIcon
              icon={<Contact className={ICON_CLASS} />}
              label={t("bots.tab")}
              active={activeView === "contacts" && sidebarVisible && appViewMode === "panes"}
              onClick={() => toggleView("contacts")}
            />
            <ActivityBarIcon
              icon={<Boxes className={ICON_CLASS} />}
              label={t("moduleNames.resources")}
              active={appViewMode === "resources"}
              onClick={toggleResourcesMode}
            />
            {librarySpaceEnabled && librarySpace.available ? (
              <ActivityBarIcon
                icon={<Library className={ICON_CLASS} />}
                label={librarySpace.label}
                active={false}
                onClick={librarySpace.open}
              />
            ) : null}
            {dramaStudioEnabled ? (
              <ActivityBarIcon
                icon={<Clapperboard className={ICON_CLASS} />}
                label={t("dramaStudio")}
                active={appViewMode === "dramaGen"}
                onClick={toggleDramaGenMode}
              />
            ) : null}
            {visibleModules.map((module) => {
              const Icon = module.icon;
              return (
                <ActivityBarIcon
                  key={module.id}
                  moduleId={module.id}
                  icon={<Icon className={ICON_CLASS} />}
                  label={t(module.titleKey as never)}
                  active={isModuleActive(module.id)}
                  onClick={() => module.open("activityBar")}
                  badge={module.badge?.({ bindings, aiPanelUnreadCount })}
                />
              );
            })}
          </div>

          <div className="mt-auto flex w-full flex-col items-center gap-1.5 pb-2">
            <ActivityBarUpdateButton />
            {layoutSwitcherMode === "corner" && <LayoutBar />}
            <ModuleAddMenu />
            <ActivityBarIcon
              icon={<CalendarClock className={ICON_CLASS} />}
              label={t("agentChatsAutomations")}
              active={false}
              onClick={openAutomationsDialog}
            />
            <ActivityBarIcon
              icon={<Settings className={ICON_CLASS} />}
              label={t("settings", { ns: "common", defaultValue: "Settings" })}
              active={false}
              onClick={openSettings}
            />
          </div>
        </div>
      </ContextMenuTrigger>
      <ModuleContextMenu />
      {librarySpace.dialog}
    </ContextMenu>
  );
}
