import { useTranslation } from "react-i18next";
import type { NotificationSettings } from "@/types";
import { SearchableSetting } from "./SettingsSearchContext";
import { SettingsSection, SettingsSwitchRow } from "./layout";

interface NotificationSectionProps {
  value: NotificationSettings;
  onChange: (value: NotificationSettings) => void;
}

export default function NotificationSection({ value, onChange }: NotificationSectionProps) {
  const { t } = useTranslation(["settings", "dialogs"]);

  function update<K extends keyof NotificationSettings>(key: K, v: NotificationSettings[K]) {
    onChange({ ...value, [key]: v });
  }

  return (
    <SearchableSetting sectionId="notification-controls">
      <SettingsSection title={t("notification")} description={t("notificationDesc", { ns: "dialogs" })}>
        <SettingsSwitchRow
          id="notification-enabled"
          title={t("enableNotification")}
          checked={value.enabled}
          onCheckedChange={(checked) => update("enabled", checked)}
        />
        <SettingsSwitchRow
          id="notification-on-exit"
          title={t("notifyOnExit")}
          checked={value.onExit}
          disabled={!value.enabled}
          onCheckedChange={(checked) => update("onExit", checked)}
        />
        <SettingsSwitchRow
          id="notification-on-waiting-input"
          title={t("notifyOnWaitingInput")}
          checked={value.onWaitingInput}
          disabled={!value.enabled}
          onCheckedChange={(checked) => update("onWaitingInput", checked)}
        />
        <SettingsSwitchRow
          id="notification-only-unfocused"
          title={t("notifyOnlyUnfocused")}
          checked={value.onlyWhenUnfocused}
          disabled={!value.enabled}
          onCheckedChange={(checked) => update("onlyWhenUnfocused", checked)}
        />
      </SettingsSection>
    </SearchableSetting>
  );
}
