import { Check, MonitorCog, Palette } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PresetSwatches } from "@/components/theme/ThemeSwatches";
import { THEME_PRESETS, type ThemePreference } from "@/theme/themePresets";
import { useSettingsStore, useThemeStore } from "@/stores";
import { handleErrorSilent } from "@/utils";

/** 状态栏右侧的快捷主题菜单：深色 / 浅色预设 + 跟随系统。 */
export default function ThemeQuickMenu() {
  const { t: settingsT } = useTranslation("settings");
  const themePreference = useThemeStore((s) => s.preference);

  async function handleSelectTheme(nextTheme: ThemePreference) {
    useThemeStore.getState().setThemeMode(nextTheme);
    const store = useSettingsStore.getState();
    if (store.settings) {
      const updated = {
        ...store.settings,
        theme: { ...store.settings.theme, mode: nextTheme },
      };
      try {
        await store.saveSettings(updated);
      } catch (e) {
        handleErrorSilent(e, "save theme");
      }
    }
  }

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              aria-label={settingsT("theme.openMenu")}
              className="rounded p-0.5 transition-colors hover:bg-[var(--app-hover)]"
            >
              <Palette className="h-3.5 w-3.5 text-[var(--app-accent)]" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>{settingsT("theme.openMenu")}</p>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" side="top" className="w-52 p-1.5">
        <DropdownMenuLabel className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--app-text-tertiary)]">
          {settingsT("theme.groups.dark")}
        </DropdownMenuLabel>
        {THEME_PRESETS.filter((preset) => preset.group === "dark").map(
          (preset) => (
            <DropdownMenuItem
              key={preset.id}
              onSelect={() => void handleSelectTheme(preset.id)}
              className={
                themePreference === preset.id
                  ? "bg-[var(--app-active-bg)] text-[var(--app-text-primary)]"
                  : ""
              }
            >
              <PresetSwatches preset={preset} />
              <span className="min-w-0 flex-1 truncate text-[12px]">
                {settingsT(preset.labelKey as never)}
              </span>
              {themePreference === preset.id && (
                <Check className="ml-auto size-3.5 text-[var(--app-accent)]" />
              )}
            </DropdownMenuItem>
          ),
        )}
        <DropdownMenuSeparator className="my-1" />
        <DropdownMenuLabel className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--app-text-tertiary)]">
          {settingsT("theme.groups.light")}
        </DropdownMenuLabel>
        {THEME_PRESETS.filter((preset) => preset.group === "light").map(
          (preset) => (
            <DropdownMenuItem
              key={preset.id}
              onSelect={() => void handleSelectTheme(preset.id)}
              className={
                themePreference === preset.id
                  ? "bg-[var(--app-active-bg)] text-[var(--app-text-primary)]"
                  : ""
              }
            >
              <PresetSwatches preset={preset} />
              <span className="min-w-0 flex-1 truncate text-[12px]">
                {settingsT(preset.labelKey as never)}
              </span>
              {themePreference === preset.id && (
                <Check className="ml-auto size-3.5 text-[var(--app-accent)]" />
              )}
            </DropdownMenuItem>
          ),
        )}
        <DropdownMenuSeparator className="my-1" />
        <DropdownMenuItem
          onSelect={() => void handleSelectTheme("system")}
          className={
            themePreference === "system"
              ? "bg-[var(--app-active-bg)] text-[var(--app-text-primary)]"
              : ""
          }
        >
          <MonitorCog className="size-4 text-[var(--app-text-secondary)]" />
          <span className="min-w-0 flex-1 truncate text-[12px]">
            {settingsT("theme.followSystem")}
          </span>
          {themePreference === "system" && (
            <Check className="ml-auto size-3.5 text-[var(--app-accent)]" />
          )}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
