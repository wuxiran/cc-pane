import { Check, ClipboardCopy, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toastErr, toastOk } from "@/lib/feedback";
import {
  SettingsBlock,
  SettingsRangeControl,
  SettingsRow,
  SettingsSection,
} from "@/components/settings/layout";
import { MiniUiPreview } from "@/components/theme/MiniUiPreview";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useThemeStore } from "@/stores/useThemeStore";
import {
  ACCENT_PRESETS,
  buildThemeExport,
  collectEffectiveTokens,
  hasAnyOverride,
  PANEL_LIGHTNESS_MAX,
  PANEL_LIGHTNESS_MIN,
  RADIUS_OVERRIDE_MAX,
  RADIUS_OVERRIDE_MIN,
  serializeThemeExport,
  SHAPE_BASE_RADIUS,
} from "@/theme/themeOverrides";
import { themeGroup, themePreset } from "@/theme/themePresets";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const formatRadius = (value: number) => `${value.toFixed(2)}rem`;
const formatPanelDelta = (value: number) => (value > 0 ? `+${value}%` : `${value}%`);

/**
 * 主题自定义微调区块（设置「主题」页签）：对当前预设主题叠加 accent 预设色 /
 * 圆角基准 / 面板明度偏移，微调即写 documentElement inline style 全应用实时
 * 生效，并持久化在 useThemeStore.customOverrides；支持一键恢复默认与导出
 * 当前有效主题 JSON（剪贴板）。色板色值一律查 ACCENT_PRESETS 映射渲染，
 * 控件本身不沉淀裸 hex。
 */
export function ThemeEditor() {
  const { t } = useTranslation("settings");
  const themeId = useThemeStore((state) => state.themeId);
  const shape = useThemeStore((state) => state.shape);
  const customOverrides = useThemeStore((state) => state.customOverrides);
  const setThemeOverrides = useThemeStore((state) => state.setThemeOverrides);
  const resetThemeOverrides = useThemeStore((state) => state.resetThemeOverrides);

  // 微调依附 baseThemeId：切到别的预设后旧微调不生效（保留待切回），
  // 控件因此按「无微调」展示默认值。
  const overrides = customOverrides && customOverrides.baseThemeId === themeId
    ? customOverrides
    : null;
  const group = themeGroup(themeId);
  const dirty = hasAnyOverride(overrides);

  function selectAccent(accent: string | undefined) {
    setThemeOverrides({ accent });
  }

  function changeRadius(radius: number) {
    setThemeOverrides({ radius });
  }

  function changePanelLightness(delta: number) {
    // 0 等价于无偏移，清掉字段保持持久化数据干净。
    setThemeOverrides({ panelLightnessDelta: delta === 0 ? undefined : delta });
  }

  function restoreDefaults() {
    resetThemeOverrides();
    toastOk(t("theme.custom.resetDone"));
  }

  async function exportTheme() {
    const payload = buildThemeExport({
      themeId,
      themeName: t(themePreset(themeId).labelKey as never),
      shape,
      overrides,
      exportedAt: new Date().toISOString(),
      tokens: collectEffectiveTokens(),
    });
    try {
      await navigator.clipboard.writeText(serializeThemeExport(payload));
      toastOk(t("theme.custom.exported"));
    } catch {
      toastErr(t("theme.custom.exportFailed"));
    }
  }

  return (
    <SettingsSection
      title={t("theme.custom.title")}
      description={t("theme.custom.description")}
      sectionId="theme-custom"
      actions={(
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!dirty}
            onClick={restoreDefaults}
          >
            <RotateCcw aria-hidden="true" />
            {t("theme.custom.reset")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void exportTheme()}
          >
            <ClipboardCopy aria-hidden="true" />
            {t("theme.custom.export")}
          </Button>
        </>
      )}
    >
      <SettingsBlock className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6">
        {/* 实时预览：与主题卡同一 mini UI，套当前 data-theme + data-shape，
            overrides 经 MiniUiPreview 内部订阅同步反映。 */}
        <div className="w-full max-w-[220px] shrink-0">
          <MiniUiPreview theme={themeId} shape={shape} />
        </div>
        <div className="min-w-0 space-y-2" role="group" aria-label={t("theme.custom.accentLabel")}>
          <span className="text-[length:var(--text-row)] font-medium text-[var(--app-text-primary)]">
            {t("theme.custom.accentLabel")}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              aria-pressed={overrides?.accent === undefined}
              onClick={() => selectAccent(undefined)}
              className={cn(
                "shape-control flex h-6 items-center rounded-full border px-2 text-[length:var(--text-caption)] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]",
                overrides?.accent === undefined
                  ? "border-[var(--app-accent)] bg-[var(--app-active-bg)] text-[var(--app-accent)]"
                  : "border-dashed border-[var(--app-border)] text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)]",
              )}
            >
              {t("theme.custom.accentFollowTheme")}
            </button>
            {ACCENT_PRESETS.map((preset) => {
              const variant = preset[group];
              const selected = overrides?.accent === preset.id;
              return (
                <Tooltip key={preset.id}><TooltipTrigger asChild><button
                  type="button"
                  aria-pressed={selected}
                  aria-label={t(preset.labelKey as never)}
                  onClick={() => selectAccent(preset.id)}
                  className={cn(
                    "shape-control flex size-6 items-center justify-center rounded-full border border-black/10 outline-none transition-transform focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]",
                    selected && "ring-2 ring-[var(--app-accent)] ring-offset-2 ring-offset-[var(--app-panel-bg)]",
                  )}
                  style={{ background: variant.color, color: variant.foreground }}
                >
                  {selected && <Check aria-hidden="true" className="size-3.5" strokeWidth={3} />}
                </button></TooltipTrigger><TooltipContent>{t(preset.labelKey as never)}</TooltipContent></Tooltip>
              );
            })}
          </div>
        </div>
      </SettingsBlock>
      <SettingsRow
        title={t("theme.custom.radiusLabel")}
        htmlFor="theme-custom-radius"
        control={(
          <SettingsRangeControl
            id="theme-custom-radius"
            value={overrides?.radius ?? SHAPE_BASE_RADIUS[shape]}
            min={RADIUS_OVERRIDE_MIN}
            max={RADIUS_OVERRIDE_MAX}
            step={0.05}
            format={formatRadius}
            onChange={changeRadius}
          />
        )}
      />
      <SettingsRow
        title={t("theme.custom.panelLightnessLabel")}
        htmlFor="theme-custom-panel-lightness"
        control={(
          <SettingsRangeControl
            id="theme-custom-panel-lightness"
            value={overrides?.panelLightnessDelta ?? 0}
            min={PANEL_LIGHTNESS_MIN}
            max={PANEL_LIGHTNESS_MAX}
            step={1}
            format={formatPanelDelta}
            onChange={changePanelLightness}
          />
        )}
      />
    </SettingsSection>
  );
}
