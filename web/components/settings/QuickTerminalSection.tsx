import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toastErr, toastOk } from "@/lib/feedback";
import { Input } from "@/components/ui/input";
import { updateQuickTerminalShortcut } from "@/services/quickTerminalService";
import { getErrorMessage } from "@/utils";
import type { QuickTerminalSettings } from "@/types";
import { SettingsRangeControl, SettingsRow, SettingsSection, SettingsSwitchRow } from "./layout";

interface QuickTerminalSectionProps {
  value: QuickTerminalSettings;
  onChange: (value: QuickTerminalSettings) => void;
}

// F1 全局快捷终端（docs/105）。快捷键改动必须立即在后端重注册全局热键，
// 所以走 updateQuickTerminalShortcut（unregister 旧 + register 新），
// 不能只靠保存设置——保存路径不会触发全局热键重绑。其余项（enabled/
// autoHideOnBlur/heightFraction）随设置保存即可。
export default function QuickTerminalSection({ value, onChange }: QuickTerminalSectionProps) {
  const { t } = useTranslation("settings");
  const [editingShortcut, setEditingShortcut] = useState(false);
  const [pendingShortcut, setPendingShortcut] = useState("");

  function update<K extends keyof QuickTerminalSettings>(key: K, v: QuickTerminalSettings[K]) {
    onChange({ ...value, [key]: v });
  }

  function handleShortcutKeyDown(e: React.KeyboardEvent) {
    e.preventDefault();
    e.stopPropagation();

    if (e.key === "Escape") {
      setEditingShortcut(false);
      setPendingShortcut("");
      return;
    }
    if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;

    const parts: string[] = [];
    if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
    if (e.shiftKey) parts.push("Shift");
    if (e.altKey) parts.push("Alt");
    parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);

    setPendingShortcut(parts.join("+"));
  }

  async function confirmShortcut() {
    if (!pendingShortcut || pendingShortcut === value.shortcut) {
      setEditingShortcut(false);
      setPendingShortcut("");
      return;
    }
    try {
      await updateQuickTerminalShortcut(value.shortcut, pendingShortcut);
      update("shortcut", pendingShortcut);
      toastOk(t("quickTerminalShortcutUpdated"));
    } catch (err) {
      toastErr(t("quickTerminalShortcutConflict", { error: getErrorMessage(err) }));
    }
    setEditingShortcut(false);
    setPendingShortcut("");
  }

  // heightFraction 以 0..1 存储，UI 用百分比展示
  const heightPercent = Math.round(value.heightFraction * 100);

  return (
    <SettingsSection title={t("quickTerminalTitle")} description={t("quickTerminalDesc")}>
      <SettingsSwitchRow
        id="quick-terminal-enabled"
        title={t("quickTerminalEnabled")}
        checked={value.enabled}
        onCheckedChange={(enabled) => update("enabled", enabled)}
      />

      <SettingsRow
        title={t("quickTerminalShortcut")}
        control={editingShortcut ? (
          <Input
            aria-label={t("quickTerminalShortcut")}
            className="h-8 w-44 text-center font-mono text-xs"
            value={pendingShortcut || t("pressNewKey")}
            readOnly
            autoFocus
            onKeyDown={handleShortcutKeyDown}
            onBlur={() => {
              if (pendingShortcut) {
                void confirmShortcut();
              } else {
                setEditingShortcut(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="shape-control min-w-[80px] cursor-default rounded-md border border-[var(--app-border)] bg-[var(--app-hover)] px-2.5 py-1 text-center font-mono text-xs text-[var(--app-text-primary)] transition-colors duration-[var(--dur-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
            onClick={() => setEditingShortcut(true)}
          >
            {value.shortcut}
          </button>
        )}
      />

      <SettingsSwitchRow
        id="quick-terminal-autohide"
        title={t("quickTerminalAutoHide")}
        description={t("quickTerminalAutoHideHint")}
        checked={value.autoHideOnBlur}
        onCheckedChange={(autoHideOnBlur) => update("autoHideOnBlur", autoHideOnBlur)}
      />

      <SettingsRow
        title={t("quickTerminalHeight")}
        description={t("quickTerminalHeightHint")}
        htmlFor="quick-terminal-height"
        control={(
          <SettingsRangeControl
            id="quick-terminal-height"
            value={heightPercent}
            min={15}
            max={85}
            step={5}
            format={(pct) => `${pct}%`}
            onChange={(pct) => update("heightFraction", (pct || 0) / 100)}
          />
        )}
      />
    </SettingsSection>
  );
}
