import { useEffect } from "react";
import { Check, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { MiniUiPreview } from "@/components/theme/MiniUiPreview";
import { PresetSwatches, SystemThemePreview } from "@/components/theme/ThemeSwatches";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import { useDensityStore } from "@/stores/useDensityStore";
import { useThemeStore } from "@/stores/useThemeStore";
import {
  canonicalThemePreference,
  THEME_PRESETS,
  type ThemeGroup,
  type ThemePreference,
} from "@/theme/themePresets";
import {
  canonicalThemeShape,
  DEFAULT_THEME_SHAPE,
  THEME_SHAPES,
} from "@/theme/themeShapes";
import type { ThemeSettings } from "@/types/settings";

interface ThemeSectionProps {
  view?: "theme" | "shape" | "all";
  value: ThemeSettings;
  onChange: (value: ThemeSettings) => void;
}

function supportsBackdropBlur(): boolean {
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function") return true;
  return CSS.supports("backdrop-filter", "blur(1px)")
    || CSS.supports("-webkit-backdrop-filter", "blur(1px)");
}

export default function ThemeSection({ view = "all", value, onChange }: ThemeSectionProps) {
  const { t } = useTranslation("settings");
  const preference = canonicalThemePreference(value.mode);
  const selectedShape = canonicalThemeShape(value.shape);
  const density = useDensityStore((state) => state.density);
  const setDensity = useDensityStore((state) => state.setDensity);
  const showBlurFallback = THEME_SHAPES.find((shape) => shape.code === selectedShape)?.traits.translucent
    && !supportsBackdropBlur();

  // Draft resets and settings reloads must update the live preview, not only card clicks.
  useEffect(() => {
    useThemeStore.getState().setThemeMode(preference);
  }, [preference]);

  useEffect(() => {
    useThemeStore.getState().setThemeShape(selectedShape);
  }, [selectedShape]);

  function selectTheme(next: ThemePreference) {
    useThemeStore.getState().setThemeMode(next);
    onChange({ ...value, mode: next });
  }

  function selectShape(next: string) {
    const shape = canonicalThemeShape(next);
    useThemeStore.getState().setThemeShape(shape);
    onChange({ ...value, shape });
  }

  function restoreDefaultShape() {
    selectShape(DEFAULT_THEME_SHAPE);
    toast.success(t("theme.restoredDefault"));
  }

  function renderGroup(group: ThemeGroup) {
    const presets = THEME_PRESETS.filter((preset) => preset.group === group);
    return (
      <section className="space-y-2" aria-labelledby={`theme-group-${group}`}>
        <h3
          id={`theme-group-${group}`}
          className="text-[12px] font-medium text-[var(--app-text-secondary)]"
        >
          {t(`theme.groups.${group}` as never)}
        </h3>
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
                  "shape-control group relative min-w-0 rounded-md border p-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]",
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
    <div className="flex flex-col gap-7">
      {view !== "shape" && <section
        className="space-y-4"
        aria-labelledby="theme-color-heading"
        data-settings-section="theme-color"
      >
        <div>
          <h2 id="theme-color-heading" className="text-[13px] font-semibold text-[var(--app-text-primary)]">
            {t("theme.colorTitle")}
          </h2>
        </div>

        {renderGroup("dark")}
        {renderGroup("light")}

        <section className="space-y-2" aria-labelledby="theme-group-system">
          <h3 id="theme-group-system" className="text-[12px] font-medium text-[var(--app-text-secondary)]">
            {t("theme.groups.system")}
          </h3>
          <button
            type="button"
            aria-pressed={preference === "system"}
            onClick={() => selectTheme("system")}
            className={cn(
              "shape-control w-[calc(50%-0.375rem)] min-w-0 rounded-md border p-2 text-left outline-none transition-colors sm:w-[calc(33.333%-0.5rem)] focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]",
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
      </section>}

      {view !== "theme" && <section
        className={cn("space-y-4", view === "all" && "border-t border-[var(--app-border)] pt-6")}
        aria-labelledby="theme-shape-heading"
        data-settings-section="theme-shape"
      >
        <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:gap-4">
          <div className="min-w-0">
            <h2 id="theme-shape-heading" className="text-[13px] font-semibold text-[var(--app-text-primary)]">
              {t("theme.shapeTitle")}
            </h2>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={selectedShape === DEFAULT_THEME_SHAPE}
            onClick={restoreDefaultShape}
          >
            <RotateCcw aria-hidden="true" />
            {t("theme.restoreDefault")}
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {THEME_SHAPES.map((shape) => {
            const selected = selectedShape === shape.code;
            const name = t(`theme.shapes.${shape.code}.name` as never);
            const description = t(shape.descriptionKey as never);
            return (
              <button
                key={shape.code}
                type="button"
                aria-pressed={selected}
                onClick={() => selectShape(shape.code)}
                className={cn(
                  "shape-control relative flex min-h-[170px] min-w-0 flex-col border p-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]",
                  selected
                    ? "border-[var(--app-accent)] bg-[var(--app-active-bg)]"
                    : "border-[var(--app-border)] bg-[var(--app-panel-bg)] hover:bg-[var(--app-hover)]",
                )}
              >
                <MiniUiPreview shape={shape.code} />
                <span className="mt-2.5 flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate text-[12px] font-semibold text-[var(--app-text-primary)]">
                    {name}
                  </span>
                  {selected && <Check aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-[var(--app-accent)]" />}
                </span>
                <span className="mt-1 text-[11px] leading-4 text-[var(--app-text-tertiary)]">
                  {description}
                </span>
                {(shape.isDefault || shape.traits.translucent) && (
                  <span className="mt-2 flex flex-wrap gap-1.5">
                    {shape.isDefault && (
                      <span className="rounded-sm bg-[var(--app-active-bg)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--app-accent)]">
                        {t("theme.defaultBadge")}
                      </span>
                    )}
                    {shape.traits.translucent && (
                      <span className="rounded-sm bg-[var(--app-hover)] px-1.5 py-0.5 text-[10px] text-[var(--app-text-secondary)]">
                        {t("theme.wallpaperBadge")}
                      </span>
                    )}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {showBlurFallback && (
          <p className="text-[11px] leading-4 text-[var(--app-text-tertiary)]">
            {t("theme.blurFallback")}
          </p>
        )}
      </section>}

      {view !== "theme" && <section
        className={cn("space-y-4", view === "all" && "border-t border-[var(--app-border)] pt-6")}
        aria-labelledby="theme-density-heading"
        data-settings-section="theme-density"
      >
        <div>
          <h2 id="theme-density-heading" className="text-[13px] font-semibold text-[var(--app-text-primary)]">
            {t("theme.density.title")}
          </h2>
          <p className="mt-1 text-[12px] text-[var(--app-text-tertiary)]">
            {t("theme.density.description")}
          </p>
        </div>

        <RadioGroup
          value={density}
          onValueChange={setDensity}
          aria-label={t("theme.density.title")}
          className="grid gap-2 sm:grid-cols-2"
        >
          {(["comfortable", "compact"] as const).map((option) => (
            <Label
              key={option}
              htmlFor={`theme-density-${option}`}
              className={cn(
                "shape-control flex cursor-pointer items-start gap-2.5 rounded-md border p-3 transition-colors",
                density === option
                  ? "border-[var(--app-accent)] bg-[var(--app-active-bg)]"
                  : "border-[var(--app-border)] bg-[var(--app-panel-bg)] hover:bg-[var(--app-hover)]",
              )}
            >
              <RadioGroupItem
                id={`theme-density-${option}`}
                value={option}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="block text-[12px] font-medium text-[var(--app-text-primary)]">
                  {t(`theme.density.options.${option}.name` as never)}
                </span>
                <span className="mt-0.5 block text-[11px] leading-4 text-[var(--app-text-tertiary)]">
                  {t(`theme.density.options.${option}.description` as never)}
                </span>
              </span>
            </Label>
          ))}
        </RadioGroup>
      </section>}
    </div>
  );
}
