import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import type { NotificationSettings } from "@/types";

interface NotificationSectionProps {
  value: NotificationSettings;
  onChange: (value: NotificationSettings) => void;
}

export default function NotificationSection({ value, onChange }: NotificationSectionProps) {
  const { t } = useTranslation("settings");

  function update<K extends keyof NotificationSettings>(key: K, v: NotificationSettings[K]) {
    onChange({ ...value, [key]: v });
  }

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-[15px] font-semibold mb-1" style={{ color: "var(--app-text-primary)" }}>
        {t("notificationTitle")}
      </h3>
      <p className="text-xs mb-3" style={{ color: "var(--app-text-tertiary)" }}>
        {t("notificationDesc", { ns: "dialogs" })}
      </p>

      <div className="flex items-center justify-between">
        <Label>{t("enableNotification")}</Label>
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => update("enabled", e.target.checked)}
          className="w-4 h-4 cursor-pointer"
          style={{ accentColor: "var(--app-accent)" }}
        />
      </div>

      <div className={`flex items-center justify-between ${!value.enabled ? "opacity-50" : ""}`}>
        <Label>{t("notifyOnExit")}</Label>
        <input
          type="checkbox"
          checked={value.onExit}
          disabled={!value.enabled}
          onChange={(e) => update("onExit", e.target.checked)}
          className="w-4 h-4 cursor-pointer"
          style={{ accentColor: "var(--app-accent)" }}
        />
      </div>

      <div className={`flex items-center justify-between ${!value.enabled ? "opacity-50" : ""}`}>
        <Label>{t("notifyOnWaitingInput")}</Label>
        <input
          type="checkbox"
          checked={value.onWaitingInput}
          disabled={!value.enabled}
          onChange={(e) => update("onWaitingInput", e.target.checked)}
          className="w-4 h-4 cursor-pointer"
          style={{ accentColor: "var(--app-accent)" }}
        />
      </div>

      <div className={`flex items-center justify-between ${!value.enabled ? "opacity-50" : ""}`}>
        <Label>{t("notifyOnlyUnfocused")}</Label>
        <input
          type="checkbox"
          checked={value.onlyWhenUnfocused}
          disabled={!value.enabled}
          onChange={(e) => update("onlyWhenUnfocused", e.target.checked)}
          className="w-4 h-4 cursor-pointer"
          style={{ accentColor: "var(--app-accent)" }}
        />
      </div>
    </div>
  );
}
