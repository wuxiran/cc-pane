import "@/i18n/islandResources";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { SegmentedTabs } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import type { IslandDisplay, IslandPosition, IslandSettings } from "@/types/island";

interface IslandSectionProps {
  value: IslandSettings;
  onChange: (value: IslandSettings) => void;
}

type ToggleKey = "popOnFinish" | "showQuota" | "collapseInFullscreen" | "hideWhenMainFocused";

const TOGGLES: readonly ToggleKey[] = ["popOnFinish", "showQuota", "collapseInFullscreen", "hideWhenMainFocused"];

// 灵动岛设置。保存后后端 update_settings 负责建 / 销毁窗口与重新落位。
export default function IslandSection({ value, onChange }: IslandSectionProps) {
  const { t } = useTranslation(["island", "settings"]);
  const update = <K extends keyof IslandSettings>(key: K, next: IslandSettings[K]) => {
    onChange({ ...value, [key]: next });
  };
  const disabled = !value.enabled;

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-[length:var(--text-title)] font-semibold mb-1" style={{ color: "var(--app-text-primary)" }}>
        {t("settings:islandTitle")}
      </h3>
      <p className="text-xs mb-3" style={{ color: "var(--app-text-tertiary)" }}>
        {t("settings:islandDesc")}
      </p>

      <div className="flex flex-col gap-[calc(var(--density-gap)+4px)]">
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="island-enabled">{t("settings.enabled")}</Label>
            <p className="text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("settings.enabledHint")}</p>
          </div>
          <Switch id="island-enabled" checked={value.enabled} onCheckedChange={(enabled) => update("enabled", enabled)} />
        </div>

        <div className={`flex items-center justify-between gap-3 ${disabled ? "opacity-50" : ""}`}>
          <Label>{t("settings.position")}</Label>
          <SegmentedTabs<IslandPosition>
            size="sm"
            aria-label={t("settings.position")}
            value={value.position}
            onValueChange={(position) => update("position", position)}
            items={[
              { value: "top", label: t("settings.positionTop"), disabled },
              { value: "left", label: t("settings.positionLeft"), disabled },
              { value: "right", label: t("settings.positionRight"), disabled },
            ]}
          />
        </div>

        <div className={`flex items-center justify-between gap-3 ${disabled ? "opacity-50" : ""}`}>
          <Label>{t("settings.display")}</Label>
          <SegmentedTabs<IslandDisplay>
            size="sm"
            aria-label={t("settings.display")}
            value={value.display}
            onValueChange={(display) => update("display", display)}
            items={[
              { value: "mouse", label: t("settings.displayMouse"), disabled },
              { value: "primary", label: t("settings.displayPrimary"), disabled },
            ]}
          />
        </div>

        {TOGGLES.map((key) => (
          <div key={key} className={`flex items-center justify-between gap-3 ${disabled ? "opacity-50" : ""}`}>
            <Label htmlFor={`island-${key}`}>{t(`settings.${key}`)}</Label>
            <Switch
              id={`island-${key}`}
              checked={value[key]}
              disabled={disabled}
              onCheckedChange={(checked) => update(key, checked)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
