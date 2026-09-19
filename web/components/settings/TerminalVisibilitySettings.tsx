import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { TerminalSettings } from "@/types";

const colors = ["cursorColor", "cursorAccent", "selectionBackground", "selectionForeground"] as const;

export default function TerminalVisibilitySettings({ value, onChange }: {
  value: TerminalSettings;
  onChange: (value: TerminalSettings) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="space-y-3">
      {colors.map((key) => (
        <div className="flex items-center justify-between gap-6" key={key}>
          <Label htmlFor={`terminal-${key}`}>{t(key)}</Label>
          <Input
            id={`terminal-${key}`} className="w-44 shrink-0" placeholder={t("terminalColorAuto")}
            value={value[key] ?? ""} maxLength={7} pattern="#[0-9a-fA-F]{6}"
            aria-invalid={Boolean(value[key] && !/^#[0-9a-f]{6}$/i.test(value[key]!))}
            onChange={(event) => onChange({ ...value, [key]: event.target.value || null })}
          />
        </div>
      ))}
      <p className="text-[11px] text-[var(--app-text-tertiary)]">{t("terminalColorHint")}</p>
      <div className="flex items-center justify-between gap-6">
        <Label htmlFor="terminal-auto-close-completed">{t("autoCloseCompletedTasks")}</Label>
        <Switch id="terminal-auto-close-completed" checked={value.autoCloseCompletedTasks ?? false}
          onCheckedChange={(checked) => onChange({ ...value, autoCloseCompletedTasks: checked })} />
      </div>
      <p className="text-[11px] text-[var(--app-text-tertiary)]">{t("autoCloseCompletedTasksHint")}</p>
    </div>
  );
}
