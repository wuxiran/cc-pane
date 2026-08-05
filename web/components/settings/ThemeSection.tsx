import { useEffect } from "react";
import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PresetSwatches, SystemThemePreview } from "@/components/theme/ThemeSwatches";
import { cn } from "@/lib/utils";
import { useThemeStore } from "@/stores/useThemeStore";
import {
  canonicalThemePreference,
  THEME_PRESETS,
  type ThemeGroup,
  type ThemePreference,
} from "@/theme/themePresets";
import type { ThemeSettings } from "@/types/settings";

interface ThemeSectionProps {
  value: ThemeSettings;
  onChange: (value: ThemeSettings) => void;
}

export default function ThemeSection({ value, onChange }: ThemeSectionProps) {
  const { t } = useTranslation("settings");
  const preference = canonicalThemePreference(value.mode);

  // 视觉主题只跟随 draft.mode 一个源。点卡片只写 draft（设置面板 500ms 自动落盘，
  // 与 StatusBar 下拉的即时保存语义一致）；「重置本节」等外部改 draft 的路径也能
  // 立刻反映到画面上，不会出现「选中态变了但颜色没变」的分叉。
  useEffect(() => {
    useThemeStore.getState().setThemeMode(preference);
  }, [preference]);

  function selectTheme(next: ThemePreference) {
    onChange({ ...value, mode: next });
  }

  function renderGroup(group: ThemeGroup) {
    const presets = THEME_PRESETS.filter((preset) => preset.group === group);
    return (
      <section className="space-y-2" aria-labelledby={`theme-group-${group}`}>
        <h2
          id={`theme-group-${group}`}
          className="text-[12px] font-medium text-[var(--app-text-secondary)]"
        >
          {t(`theme.groups.${group}` as never)}
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {presets.map((preset) => {
            const selected = preference === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                aria-pressed={selected}
                onClick={() => selectTheme(preset.id)}
                className={cn(
                  "group relative min-w-0 rounded-md border p-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]",
                  selected
                    ? "border-[var(--app-accent)] bg-[var(--app-active-bg)]"
                    : "border-[var(--app-border)] bg-[var(--app-panel-bg)] hover:bg-[var(--app-hover)]",
                )}
              >
                <PresetSwatches preset={preset} size="card" />
                <span className="mt-2 flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-[12px] font-medium text-[var(--app-text-primary)]">
                    {t(preset.labelKey as never)}
                  </span>
                  {selected && <Check className="ml-auto size-3.5 shrink-0 text-[var(--app-accent)]" />}
                </span>
              </button>
            );
          })}
        </div>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-6" data-settings-section="theme-style">
      <div>
        <h1 className="text-[15px] font-semibold text-[var(--app-text-primary)]">
          {t("theme.styleTitle")}
        </h1>
        <p className="mt-1 text-[12px] text-[var(--app-text-tertiary)]">
          {t("theme.styleDescription")}
        </p>
      </div>

      {renderGroup("dark")}
      {renderGroup("light")}

      <section className="space-y-2" aria-labelledby="theme-group-system">
        <h2 id="theme-group-system" className="text-[12px] font-medium text-[var(--app-text-secondary)]">
          {t("theme.groups.system")}
        </h2>
        <button
          type="button"
          aria-pressed={preference === "system"}
          onClick={() => selectTheme("system")}
          className={cn(
            "w-[calc(50%-0.375rem)] min-w-0 rounded-md border p-2 text-left outline-none transition-colors sm:w-[calc(33.333%-0.5rem)] focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]",
            preference === "system"
              ? "border-[var(--app-accent)] bg-[var(--app-active-bg)]"
              : "border-[var(--app-border)] bg-[var(--app-panel-bg)] hover:bg-[var(--app-hover)]",
          )}
        >
          <SystemThemePreview selected={preference === "system"} />
          <span className="mt-2 block truncate text-[12px] font-medium text-[var(--app-text-primary)]">
            {t("theme.followSystem")}
          </span>
        </button>
      </section>
    </div>
  );
}
