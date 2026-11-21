import { Boxes, CalendarClock, Clapperboard, Contact, FolderTree, House, Library, Settings } from "lucide-react";
import { ACTIVITY_ICON_ACTIVE, ACTIVITY_ICON_IDLE } from "@/components/activityBarIconStyle";
import { openAutomationsDialog } from "@/stores/useAutomationsDialogStore";
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

const ICON_CLASS = "h-[18px] w-[18px]";

interface ActivityBarIconProps {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: ModuleBadge;
  moduleId?: ModuleId;
}

function ActivityBarIcon({
  icon,
  label,
  active,
  onClick,
  badge,
  moduleId,
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
            className={`relative flex h-8 w-8 items-center justify-center rounded-lg transition-[color,background-color,transform] duration-[var(--dur)] ease-[var(--ease-out)] active:scale-[0.96] ${
              active ? ACTIVITY_ICON_ACTIVE : ACTIVITY_ICON_IDLE
            }`}
            style={{ boxShadow: active ? "var(--app-activity-item-active-shadow)" : undefined }}
            onClick={onClick}
          >
            {icon}
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
