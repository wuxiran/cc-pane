import "@/i18n/browserToolsResources";
import { RotateCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { BrowserViewportResult } from "@/services/browserService";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";

export interface BrowserPreviewSettings { width: number; height: number; scale: number | null }
export const DEFAULT_BROWSER_PREVIEW: BrowserPreviewSettings = { width: 1440, height: 1000, scale: null };
export function previewScale(settings: BrowserPreviewSettings, available: { width: number; height: number }): number {
  return Math.max(0.1, Math.min(settings.scale ?? 1, available.width / settings.width, available.height / settings.height));
}
export default function BrowserViewportToolbar({ settings, actual, onChange, onClose }: {
  settings: BrowserPreviewSettings; actual: BrowserViewportResult | null;
  onChange: (value: BrowserPreviewSettings) => void; onClose: () => void;
}) {
  const { t } = useTranslation("browserTools");
  const dimension = (key: "width" | "height", max: number) => <input
    aria-label={t(key)} type="number" min={240} max={max} value={settings[key]}
    onChange={(event) => { const value = Number(event.target.value); if (value >= 240 && value <= max) onChange({ ...settings, [key]: value }); }}
    className="h-7 w-[76px] rounded-lg bg-[var(--app-sidebar)] px-2 text-center text-xs tabular-nums" />;
  return <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--app-border)] px-3 py-2 text-xs text-[var(--app-text-secondary)]">
    <select aria-label={t("devicePreset")} value="custom" onChange={(event) => {
      const [width, height] = event.target.value.split("x").map(Number);
      if (width && height) onChange({ ...settings, width, height });
    }} className="max-w-32 bg-transparent"><option value="custom">{t("responsive")}</option><option value="390x844">{t("phone")} · 390×844</option><option value="768x1024">{t("tablet")} · 768×1024</option><option value="1440x1000">{t("desktop")} · 1440×1000</option></select>
    {dimension("width", 3840)}<span>×</span>{dimension("height", 2160)}
    <IconTooltipButton label={t("rotate")} className="size-7" onClick={() => onChange({ ...settings, width: Math.min(3840, settings.height), height: Math.min(2160, settings.width) })}><RotateCw className="size-3.5" /></IconTooltipButton>
    <select aria-label={t("displayScale")} value={settings.scale ?? "fit"} onChange={(event) => onChange({ ...settings, scale: event.target.value === "fit" ? null : Number(event.target.value) })} className="rounded-lg bg-[var(--app-sidebar)] p-1.5">
      <option value="fit">{t("fit")}</option>{[.25, .5, .57, .75, 1].map((value) => <option key={value} value={value}>{Math.round(value * 100)}%</option>)}
    </select>
    {actual && <span role="status" className="min-w-0 truncate tabular-nums" title={t("actualViewport")}>{Math.round(actual.width)} × {Math.round(actual.height)} · {Math.round(actual.scale * 100)}%</span>}
    <div className="flex-1" /><IconTooltipButton label={t("closePreview")} className="size-7" onClick={onClose}><X className="size-3.5" /></IconTooltipButton>
  </div>;
}
