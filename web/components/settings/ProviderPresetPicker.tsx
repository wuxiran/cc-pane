import { useTranslation } from "react-i18next";
import { Wrench } from "lucide-react";
import { PRESET_CATEGORIES, PROVIDER_PRESETS } from "@/constants/providerPresets";
import type { ProviderPreset } from "@/types/provider";

interface Props {
  onSelect: (preset: ProviderPreset) => void;
  /** 是否显示「自定义配置」chip，默认 false */
  showCustom?: boolean;
  onCustom?: () => void;
}

export default function ProviderPresetPicker({ onSelect, showCustom, onCustom }: Props) {
  const { t } = useTranslation("settings");

  return (
    <div className="flex flex-col gap-3">
      {PRESET_CATEGORIES.map((cat) => {
        const presets = PROVIDER_PRESETS.filter((p) => p.category === cat.key);
        if (presets.length === 0) return null;
        return (
          <div key={cat.key} className="flex flex-col gap-1.5">
            <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--app-text-tertiary)" }}>
              {t(cat.labelKey as any)}
            </div>
            <div className="flex flex-wrap gap-2">
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-medium transition-all hover:shadow-sm"
                  style={{
                    background: "var(--app-content)",
                    border: "1px solid var(--app-border)",
                    color: "var(--app-text-primary)",
                  }}
                  onMouseEnter={(e) => {
                    if (preset.accentColor) {
                      (e.currentTarget as HTMLElement).style.borderColor = preset.accentColor;
                    }
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.borderColor = "var(--app-border)";
                  }}
                  onClick={() => onSelect(preset)}
                >
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ background: preset.accentColor || "var(--app-text-tertiary)" }}
                  />
                  {t(preset.nameKey as any)}
                </button>
              ))}
            </div>
          </div>
        );
      })}

      {/* 自定义配置 chip */}
      {showCustom && onCustom && (
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-medium transition-all hover:shadow-sm w-fit"
          style={{
            background: "var(--app-accent)",
            color: "white",
            border: "1px solid var(--app-accent)",
          }}
          onClick={onCustom}
        >
          <Wrench size={12} />
          {t("manualConfig")}
        </button>
      )}
    </div>
  );
}
