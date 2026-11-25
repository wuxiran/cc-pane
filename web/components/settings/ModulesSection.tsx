import { Fragment } from "react";
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
import { SettingsRow, SettingsSection } from "./layout";

const POSITIONS: readonly ModulePosition[] = ["activityBar", "rightDock", "hidden"];

export default function ModulesSection() {
  const { t } = useTranslation(["settings", "sidebar"]);
  const preferences = useModulePrefsStore((state) => state.preferences);
  const setEnabled = useModulePrefsStore((state) => state.setEnabled);
  const setPosition = useModulePrefsStore((state) => state.setPosition);
  const setAutoOpen = useModulePrefsStore((state) => state.setAutoOpen);
  const setAllowAiDialog = useModulePrefsStore((state) => state.setAllowAiDialog);

  return (
    <SettingsSection
      title={t("modules.title")}
      description={t("modules.description")}
      sectionId="modules-root"
    >
      {MODULE_CONSUMERS.settings.filter((module) => module.configurable !== false).map((module) => {
        const preference = preferences[module.id];
        const moduleName = t(module.titleKey as never, { ns: "sidebar" });
        const positions = POSITIONS.filter((position) => (
          position === "hidden" || module.surfaces.includes(position)
        ));
        return (
          <Fragment key={module.id}>
            <SettingsRow
              data-testid={`module-setting-${module.id}`}
              icon={module.icon}
              title={moduleName}
              control={(
                <>
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
                        className="flex h-8 w-36 items-center justify-between gap-2 rounded-md border border-[var(--app-border)] bg-[var(--app-content)] px-2.5 text-[length:var(--text-row)] text-[var(--app-text-primary)] outline-none hover:bg-[var(--app-hover)] focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
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
                            className="text-[length:var(--text-row)]"
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
                </>
              )}
            />
            {/* aiPanel 独有的两个开关：同卡片内的并列行，缩进到模块名对齐处，不另起卡片 */}
            {module.id === "aiPanel" && (
              <SettingsRow
                className="pl-14"
                title={t("modules.autoOpenLabel")}
                htmlFor="module-ai-panel-auto-open"
                control={(
                  <Switch
                    id="module-ai-panel-auto-open"
                    checked={preference.autoOpen === true}
                    onCheckedChange={(autoOpen) => setAutoOpen(module.id, autoOpen)}
                  />
                )}
              />
            )}
            {module.id === "aiPanel" && (
              <SettingsRow
                className="pl-14"
                title={t("modules.allowAiDialogLabel")}
                htmlFor="module-ai-panel-allow-ai-dialog"
                control={(
                  <Switch
                    id="module-ai-panel-allow-ai-dialog"
                    checked={preference.allowAiDialog !== false}
                    onCheckedChange={(allow) => setAllowAiDialog(module.id, allow)}
                  />
                )}
              />
            )}
          </Fragment>
        );
      })}
    </SettingsSection>
  );
}
