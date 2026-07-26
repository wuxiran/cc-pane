import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import ModulePlacementHint from "@/components/modules/ModulePlacementHint";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { MODULE_CONSUMERS, type ModulePosition } from "@/modules/registry";
import { useModulePrefsStore } from "@/stores/useModulePrefsStore";

const POSITIONS: readonly ModulePosition[] = ["activityBar", "rightDock", "hidden"];

export default function ModulesSection() {
  const { t } = useTranslation(["settings", "sidebar"]);
  const preferences = useModulePrefsStore((state) => state.preferences);
  const setEnabled = useModulePrefsStore((state) => state.setEnabled);
  const setPosition = useModulePrefsStore((state) => state.setPosition);
  const setAutoOpen = useModulePrefsStore((state) => state.setAutoOpen);
  const setAllowAiDialog = useModulePrefsStore((state) => state.setAllowAiDialog);

  return (
    <div className="flex flex-col gap-3">
      {MODULE_CONSUMERS.settings.map((module) => {
        const Icon = module.icon;
        const preference = preferences[module.id];
        const moduleName = t(module.titleKey as never, { ns: "sidebar" });
        const positions = POSITIONS.filter((position) => (
          position === "hidden" || module.surfaces.includes(position)
        ));
        return (
          <div
            key={module.id}
            data-testid={`module-setting-${module.id}`}
            className="py-1"
          >
            <div className="flex min-h-14 items-center gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-[var(--app-active-bg)] text-[var(--app-text-secondary)]">
                <Icon aria-hidden="true" size={16} strokeWidth={1.6} />
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--app-text-primary)]">
                {moduleName}
              </span>
              <Switch
                checked={preference.enabled}
                aria-label={t("modules.enabledLabel", { module: moduleName })}
                onCheckedChange={(enabled) => setEnabled(module.id, enabled)}
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    data-testid={`module-position-trigger-${module.id}`}
                    aria-label={t("modules.positionLabel", { module: moduleName })}
                    className="flex h-8 w-36 items-center justify-between gap-2 rounded-md border border-[var(--app-border)] bg-[var(--app-content)] px-2.5 text-[13px] text-[var(--app-text-primary)] outline-none hover:bg-[var(--app-hover)] focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
                  >
                    <span className="truncate">
                      {t(`modules.positions.${preference.position}` as never)}
                    </span>
                    <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-[var(--app-text-tertiary)]" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuRadioGroup
                    value={preference.position}
                    onValueChange={(position) => setPosition(module.id, position as ModulePosition)}
                  >
                    {positions.map((position) => (
                      <DropdownMenuRadioItem
                        key={position}
                        value={position}
                        aria-label={t(`modules.positions.${position}` as never)}
                        data-testid={`module-setting-position-${module.id}-${position}`}
                        className="text-[13px]"
                      >
                        <span>{t(`modules.positions.${position}` as never)}</span>
                        {position !== "activityBar" && (
                          <ModulePlacementHint label={t("modules.placementHint")} />
                        )}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {module.id === "aiPanel" && (
              <div className="flex items-center gap-3 pb-2 pl-11">
                <span className="min-w-0 flex-1 text-[12px] text-[var(--app-text-secondary)]">
                  {t("modules.autoOpenLabel")}
                </span>
                <Switch
                  checked={preference.autoOpen === true}
                  aria-label={t("modules.autoOpenLabel")}
                  onCheckedChange={(autoOpen) => setAutoOpen(module.id, autoOpen)}
                />
              </div>
            )}
            {module.id === "aiPanel" && (
              <div className="flex items-center gap-3 pb-2 pl-11">
                <span className="min-w-0 flex-1 text-[12px] text-[var(--app-text-secondary)]">
                  {t("modules.allowAiDialogLabel")}
                </span>
                <Switch
                  checked={preference.allowAiDialog !== false}
                  aria-label={t("modules.allowAiDialogLabel")}
                  onCheckedChange={(allow) => setAllowAiDialog(module.id, allow)}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
