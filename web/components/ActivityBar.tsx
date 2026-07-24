import { Command, FolderTree, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import LayoutBar from "@/components/LayoutBar";
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
  MODULE_REGISTRY,
  type ModuleBadge,
  type ModuleId,
  type ModulePosition,
} from "@/modules/registry";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { useModulePrefsStore } from "@/stores/useModulePrefsStore";
import { useDialogStore, useLayoutUiStore, useOrchestratorStore } from "@/stores";

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
            className={`relative flex h-10 w-10 items-center justify-center rounded-xl transition-[color,background-color,transform] duration-[var(--dur)] ease-[var(--ease-out)] active:scale-[0.96] ${
              active
                ? "text-[var(--app-accent)]"
                : "text-[var(--app-icon-inactive)] hover:bg-[var(--app-activity-item-hover)] hover:text-[var(--app-icon-hover)]"
            }`}
            style={{
              background: active ? "var(--app-activity-item-active)" : undefined,
              boxShadow: active ? "var(--app-activity-item-active-shadow)" : undefined,
            }}
            onClick={onClick}
          >
            {icon}
            {showBadge && (
              <span
                className={`absolute right-[4px] top-[4px] flex h-[14px] min-w-[14px] items-center justify-center rounded-full px-[3px] text-[9px] font-bold leading-none text-white ${
                  badgeTone === "red" ? "bg-[var(--app-status-danger)]" : "bg-[var(--app-accent)]"
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
    <ContextMenuContent className="w-56 text-[13px]">
      <ContextMenuLabel className="text-[13px]">
        {t("moduleMenu.title")}
      </ContextMenuLabel>
      <ContextMenuSeparator />
      {MODULE_REGISTRY.map((module) => {
        const Icon = module.icon;
        const preference = preferences[module.id];
        return (
          <ContextMenuSub key={module.id}>
            <ContextMenuSubTrigger
              data-testid={`module-menu-${module.id}`}
              className="text-[13px]"
            >
              <Icon aria-hidden="true" className="size-4" strokeWidth={1.6} />
              <span className="truncate">{t(module.titleKey as never)}</span>
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-52 text-[13px]">
              <ContextMenuCheckboxItem
                data-testid={`module-enabled-${module.id}`}
                checked={preference.enabled}
                className="text-[13px]"
                onCheckedChange={(checked) => setEnabled(module.id, checked === true)}
              >
                {t("moduleMenu.enabled")}
              </ContextMenuCheckboxItem>
              <ContextMenuSeparator />
              <ContextMenuRadioGroup
                value={preference.position}
              >
                <ContextMenuRadioItem
                  data-testid={`module-position-${module.id}-activityBar`}
                  value="activityBar"
                  className="text-[13px]"
                  onSelect={() => changePosition(module.id, "activityBar")}
                >
                  {t("moduleMenu.activityBar")}
                </ContextMenuRadioItem>
                <ContextMenuRadioItem
                  data-testid={`module-position-${module.id}-rightDock`}
                  value="rightDock"
                  className="text-[13px]"
                  onSelect={() => changePosition(module.id, "rightDock")}
                >
                  <span>{t("moduleMenu.rightDock")}</span>
                  <ModulePlacementHint label={t("moduleMenu.placementHint")} />
                </ContextMenuRadioItem>
                <ContextMenuRadioItem
                  data-testid={`module-position-${module.id}-hidden`}
                  value="hidden"
                  className="text-[13px]"
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
  const toggleView = useActivityBarStore((state) => state.toggleView);
  const appViewMode = useActivityBarStore((state) => state.appViewMode);
  const orchestrationOverlayOpen = useActivityBarStore((state) => state.orchestrationOverlayOpen);
  const openSettings = useDialogStore((state) => state.openSettings);
  const bindings = useOrchestratorStore((state) => state.bindings);
  const preferences = useModulePrefsStore((state) => state.preferences);

  const visibleModules = MODULE_REGISTRY.filter((module) => {
    const preference = preferences[module.id];
    return preference.enabled && preference.position === "activityBar";
  });

  const isModuleActive = (id: ModuleId) => {
    if (id === "orchestration") return orchestrationOverlayOpen;
    if (id === "resources" || id === "todo") return appViewMode === id;
    return activeView === id && sidebarVisible && appViewMode !== "files";
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-testid="activity-bar"
          className="activity-bar flex shrink-0 select-none flex-col items-center py-2"
          style={{
            width: 56,
            height: "100%",
            background: "var(--app-activity-bar-bg)",
            borderRight: "1px solid var(--app-activity-border)",
            backdropFilter: "blur(var(--app-glass-blur))",
            WebkitBackdropFilter: "blur(var(--app-glass-blur))",
            WebkitAppRegion: "no-drag",
          } as React.CSSProperties}
        >
          <div className="flex w-full flex-col items-center gap-2 pb-2">
            <ActivityBarIcon
              icon={<Command className="h-[22px] w-[22px]" strokeWidth={1.6} />}
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
              icon={<FolderTree className="h-[22px] w-[22px]" strokeWidth={1.5} />}
              label={t("workspaces")}
              active={activeView === "explorer" && sidebarVisible && appViewMode !== "files"}
              onClick={() => toggleView("explorer")}
            />
            {visibleModules.map((module) => {
              const Icon = module.icon;
              return (
                <ActivityBarIcon
                  key={module.id}
                  moduleId={module.id}
                  icon={<Icon className="h-[22px] w-[22px]" strokeWidth={1.5} />}
                  label={t(module.titleKey as never)}
                  active={isModuleActive(module.id)}
                  onClick={() => module.open("activityBar")}
                  badge={module.badge?.({ bindings })}
                />
              );
            })}
          </div>

          <div className="mt-auto flex w-full flex-col items-center gap-1.5 pb-2">
            {layoutSwitcherMode === "corner" && <LayoutBar />}
            <ActivityBarIcon
              icon={<Settings className="h-[22px] w-[22px]" strokeWidth={1.5} />}
              label={t("settings", { ns: "common", defaultValue: "Settings" })}
              active={false}
              onClick={openSettings}
            />
          </div>
        </div>
      </ContextMenuTrigger>
      <ModuleContextMenu />
    </ContextMenu>
  );
}
