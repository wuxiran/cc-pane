// 终端「颜色」分区：光标/选区四个颜色覆盖。留空 = 跟随终端主题。
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import type { TerminalSettings } from "@/types";
import { SettingsRow, SettingsSection } from "./layout";

const colors = ["cursorColor", "cursorAccent", "selectionBackground", "selectionForeground"] as const;

export default function TerminalVisibilitySettings({ value, onChange }: {
  value: TerminalSettings;
  onChange: (value: TerminalSettings) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <SettingsSection title={t("terminalGroups.colors")} description={t("terminalColorHint")}>
      {colors.map((key) => (
        <SettingsRow
          key={key}
          title={t(key)}
          htmlFor={`terminal-${key}`}
          control={(
            <Input
              id={`terminal-${key}`}
              className="w-44 shrink-0 font-mono"
              placeholder={t("terminalColorAuto")}
              value={value[key] ?? ""}
              maxLength={7}
              pattern="#[0-9a-fA-F]{6}"
              aria-invalid={Boolean(value[key] && !/^#[0-9a-f]{6}$/i.test(value[key]!))}
              onChange={(event) => onChange({ ...value, [key]: event.target.value || null })}
            />
          )}
        />
      ))}
    </SettingsSection>
  );
}
