import { useEffect, useState } from "react";
import { Check, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toastOk } from "@/lib/feedback";
import { MiniUiPreview } from "@/components/theme/MiniUiPreview";
import { ThemeEditor } from "@/components/theme/ThemeEditor";
import { PresetSwatches, SystemThemePreview } from "@/components/theme/ThemeSwatches";
import { Button } from "@/components/ui/button";
import { isTauriRuntime } from "@/services/runtime";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import { useDensityStore } from "@/stores/useDensityStore";
import { useThemeStore } from "@/stores/useThemeStore";
import { navigateToSettings } from "./settingsNavigation";
import {
  canonicalThemePreference,
  FEATURED_THEME_IDS,
  THEME_PRESETS,
  type ThemeGroup,
  type ThemePreference,
} from "@/theme/themePresets";
import {
  canonicalThemeShape,
  DEFAULT_THEME_SHAPE,
  FEATURED_THEME_SHAPES,
  THEME_SHAPES,
} from "@/theme/themeShapes";
import type { ThemeSettings } from "@/types/settings";
import {
  SettingsBlock,
  SettingsNavRow,
  SettingsSection,
  SettingsSwitchRow,
} from "./layout";

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
  const platform = document.documentElement.dataset.platform;
  const materialDefault = platform === "macos";
  const materialSupported = platform === "macos" || platform === "windows";
  const [showAllPresets, setShowAllPresets] = useState(false);
  const [showAllShapes, setShowAllShapes] = useState(false);
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
    toastOk(t("theme.restoredDefault"));
  }

  function renderGroup(group: ThemeGroup) {
    const presets = THEME_PRESETS.filter(
      (preset) =>
        preset.group === group
        && (showAllPresets || FEATURED_THEME_IDS.includes(preset.id) || preference === preset.id),
    );
    return (
      <section className="space-y-2" aria-labelledby={`theme-group-${group}`}>
        <h3
          id={`theme-group-${group}`}
          className="text-[length:var(--text-small)] font-medium text-[var(--app-text-secondary)]"
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
                    : "border-[var(--app-border)] bg-[var(--app-content)] hover:bg-[var(--app-hover)]",
                )}
              >
                <PresetSwatches preset={preset} size="card" />
                <span className="mt-2 flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-[length:var(--text-small)] font-medium text-[var(--app-text-primary)]">
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

  function renderShapeCard(shape: (typeof THEME_SHAPES)[number]) {
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
            : "border-[var(--app-border)] bg-[var(--app-content)] hover:bg-[var(--app-hover)]",
        )}
      >
        <MiniUiPreview shape={shape.code} />
        <span className="mt-2.5 flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-[length:var(--text-small)] font-semibold text-[var(--app-text-primary)]">
            {name}
          </span>
          {selected && <Check aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-[var(--app-accent)]" />}
        </span>
        <span className="mt-1 text-[length:var(--text-caption)] leading-4 text-[var(--app-text-tertiary)]">
          {description}
        </span>
        {(shape.isDefault || shape.traits.translucent) && (
          <span className="mt-2 flex flex-wrap gap-1.5">
            {shape.isDefault && (
              <span className="rounded-sm bg-[var(--app-active-bg)] px-1.5 py-0.5 text-[length:var(--text-micro)] font-medium text-[var(--app-accent)]">
                {t("theme.defaultBadge")}
              </span>
            )}
            {shape.traits.translucent && (
              <span className="rounded-sm bg-[var(--app-hover)] px-1.5 py-0.5 text-[length:var(--text-micro)] text-[var(--app-text-secondary)]">
                {t("theme.wallpaperBadge")}
              </span>
            )}
          </span>
        )}
      </button>
    );
  }

  return (
    <>
      {view !== "shape" && (
        <SettingsSection title={t("theme.colorTitle")} sectionId="theme-color">
          <SettingsBlock className="flex flex-col gap-4">
            {renderGroup("dark")}
            {renderGroup("light")}
            <section className="space-y-2" aria-labelledby="theme-group-system">
              <h3 id="theme-group-system" className="text-[length:var(--text-small)] font-medium text-[var(--app-text-secondary)]">
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
                    : "border-[var(--app-border)] bg-[var(--app-content)] hover:bg-[var(--app-hover)]",
                )}
              >
                <SystemThemePreview selected={preference === "system"} />
                <span className="mt-2 block truncate text-[length:var(--text-small)] font-medium text-[var(--app-text-primary)]">
                  {t("theme.followSystem")}
                </span>
              </button>
            </section>
            {!showAllPresets && (
              <Button variant="ghost" size="sm" className="self-start" onClick={() => setShowAllPresets(true)}>
                {t("theme.showAllPresets", { count: THEME_PRESETS.length })}
              </Button>
            )}
          </SettingsBlock>
          {/* 终端配色跨页链接：外观是一站式入口，终端主题留在终端页（批 5） */}
          <SettingsNavRow
            title={t("theme.terminalThemeLink")}
            description={t("theme.terminalThemeHint")}
            onClick={() => navigateToSettings({ paneId: "terminal", targetSectionId: "terminal-root" })}
          />
        </SettingsSection>
      )}

      {view !== "shape" && <ThemeEditor />}

      {view !== "shape" && isTauriRuntime() && (
        <SettingsSection title={t("theme.system.title")} sectionId="theme-system">
          <SettingsSwitchRow
            id="theme-system-accent"
            title={t("theme.system.accent")}
            checked={value.systemAccent === true}
            onCheckedChange={(checked) => onChange({ ...value, systemAccent: checked })}
          />
          {materialSupported && (
            <SettingsSwitchRow
              id="theme-system-material"
              title={t("theme.system.material")}
              checked={value.systemMaterial ?? materialDefault}
              onCheckedChange={(checked) => onChange({ ...value, systemMaterial: checked })}
            />
          )}
        </SettingsSection>
      )}

      {view !== "theme" && (
        <SettingsSection
          title={t("theme.shapeTitle")}
          sectionId="theme-shape"
          actions={(
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={selectedShape === DEFAULT_THEME_SHAPE}
              onClick={restoreDefaultShape}
            >
              <RotateCcw aria-hidden="true" />
              {t("theme.restoreDefault")}
            </Button>
          )}
        >
          <SettingsBlock className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {THEME_SHAPES.filter(
                (shape) =>
                  showAllShapes
                  || FEATURED_THEME_SHAPES.includes(shape.code)
                  || selectedShape === shape.code,
              ).map((shape) => renderShapeCard(shape))}
            </div>
            {!showAllShapes && (
              <Button variant="ghost" size="sm" className="self-start" onClick={() => setShowAllShapes(true)}>
                {t("theme.showAllShapes", { count: THEME_SHAPES.length })}
              </Button>
            )}
            {showBlurFallback && (
              <p className="text-[length:var(--text-caption)] leading-4 text-[var(--app-text-tertiary)]">
                {t("theme.blurFallback")}
              </p>
            )}
          </SettingsBlock>
        </SettingsSection>
      )}

      {view !== "theme" && (
        <SettingsSection
          title={t("theme.density.title")}
          description={t("theme.density.description")}
          sectionId="theme-density"
        >
          <SettingsBlock>
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
                    "shape-control flex cursor-default items-start gap-2.5 rounded-md border p-3 transition-colors",
                    density === option
                      ? "border-[var(--app-accent)] bg-[var(--app-active-bg)]"
                      : "border-[var(--app-border)] bg-[var(--app-content)] hover:bg-[var(--app-hover)]",
                  )}
                >
                  <RadioGroupItem
                    id={`theme-density-${option}`}
                    value={option}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="block text-[length:var(--text-small)] font-medium text-[var(--app-text-primary)]">
                      {t(`theme.density.options.${option}.name` as never)}
                    </span>
                    <span className="mt-0.5 block text-[length:var(--text-caption)] leading-4 text-[var(--app-text-tertiary)]">
                      {t(`theme.density.options.${option}.description` as never)}
                    </span>
                  </span>
                </Label>
              ))}
            </RadioGroup>
          </SettingsBlock>
        </SettingsSection>
      )}
    </>
  );
}
