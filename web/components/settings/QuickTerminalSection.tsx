import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toastErr, toastOk } from "@/lib/feedback";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { updateQuickTerminalShortcut } from "@/services/quickTerminalService";
import { getErrorMessage } from "@/utils";
import type { QuickTerminalSettings } from "@/types";

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
    <div className="flex flex-col gap-3">
      <h3 className="text-[15px] font-semibold mb-1" style={{ color: "var(--app-text-primary)" }}>
        {t("quickTerminalTitle")}
      </h3>
      <p className="text-xs mb-3" style={{ color: "var(--app-text-tertiary)" }}>
        {t("quickTerminalDesc")}
      </p>

      <div className="flex items-center justify-between">
        <Label htmlFor="quick-terminal-enabled">{t("quickTerminalEnabled")}</Label>
        <Switch
          id="quick-terminal-enabled"
          checked={value.enabled}
          onCheckedChange={(enabled) => update("enabled", enabled)}
        />
      </div>

      <div className="flex items-center justify-between">
        <Label>{t("quickTerminalShortcut")}</Label>
        {editingShortcut ? (
          <Input
            aria-label={t("quickTerminalShortcut")}
            className="w-[180px] h-8 text-center text-xs"
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
            className="px-3 py-1 rounded text-xs font-mono cursor-default border"
            style={{
              background: "var(--app-surface-2)",
              color: "var(--app-text-primary)",
              borderColor: "var(--app-border)",
            }}
            onClick={() => setEditingShortcut(true)}
          >
            {value.shortcut}
          </button>
        )}
      </div>

      <div className="flex items-center justify-between">
        <div>
          <Label htmlFor="quick-terminal-autohide">{t("quickTerminalAutoHide")}</Label>
          <p className="text-xs mt-0.5" style={{ color: "var(--app-text-tertiary)" }}>
            {t("quickTerminalAutoHideHint")}
          </p>
        </div>
        <Switch
          id="quick-terminal-autohide"
          checked={value.autoHideOnBlur}
          onCheckedChange={(autoHideOnBlur) => update("autoHideOnBlur", autoHideOnBlur)}
        />
      </div>

      <div className="flex items-center justify-between">
        <div>
          <Label htmlFor="quick-terminal-height">{t("quickTerminalHeight")}</Label>
          <p className="text-xs mt-0.5" style={{ color: "var(--app-text-tertiary)" }}>
            {t("quickTerminalHeightHint")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            id="quick-terminal-height"
            type="range"
            min={15}
            max={85}
            step={5}
            className="w-[140px]"
            value={heightPercent}
            onChange={(e) => {
              const pct = parseInt(e.target.value, 10) || 0;
              update("heightFraction", pct / 100);
            }}
          />
          <span className="text-xs font-mono w-[44px] text-right" style={{ color: "var(--app-text-primary)" }}>
            {heightPercent}%
          </span>
        </div>
      </div>
    </div>
  );
}
