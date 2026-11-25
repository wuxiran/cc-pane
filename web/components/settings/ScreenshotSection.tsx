import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toastErr, toastOk } from "@/lib/feedback";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { screenshotService } from "@/services";
import { getErrorMessage } from "@/utils";
import type { ScreenshotSettings } from "@/types";
import { SettingsRow, SettingsSection } from "./layout";

interface ScreenshotSectionProps {
  value: ScreenshotSettings;
  onChange: (value: ScreenshotSettings) => void;
}

export default function ScreenshotSection({ value, onChange }: ScreenshotSectionProps) {
  const { t } = useTranslation("settings");
  const [editingShortcut, setEditingShortcut] = useState(false);
  const [pendingShortcut, setPendingShortcut] = useState("");

  function update<K extends keyof ScreenshotSettings>(key: K, v: ScreenshotSettings[K]) {
    onChange({ ...value, [key]: v });
  }

  /** 监听键盘输入，生成快捷键字符串 */
  function handleShortcutKeyDown(e: React.KeyboardEvent) {
    e.preventDefault();
    e.stopPropagation();

    if (e.key === "Escape") {
      setEditingShortcut(false);
      setPendingShortcut("");
      return;
    }

    // 忽略单独的修饰键
    if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;

    const parts: string[] = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.metaKey) parts.push("Super");
    if (e.shiftKey) parts.push("Shift");
    if (e.altKey) parts.push("Alt");
    parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);

    const combo = parts.join("+");
    setPendingShortcut(combo);
  }

  /** 确认快捷键更改 */
  async function confirmShortcut() {
    if (!pendingShortcut) return;
    try {
      await screenshotService.updateShortcut(value.shortcut, pendingShortcut);
      update("shortcut", pendingShortcut);
      toastOk(t("screenshotShortcutUpdated"));
    } catch (err) {
      toastErr(t("screenshotShortcutConflict", { error: getErrorMessage(err) }));
    }
    setEditingShortcut(false);
    setPendingShortcut("");
  }

  return (
    <SettingsSection title={t("screenshot")} description={t("screenshotDesc")}>
      {/* 快捷键：不做 htmlFor 关联——按钮态的可访问名就是它显示的快捷键本身，
          关联 label 反而会覆盖；编辑态输入框用 aria-label 命名。 */}
      <SettingsRow
        title={t("screenshotShortcut")}
        control={editingShortcut ? (
          <Input
            aria-label={t("screenshotShortcut")}
            className="h-8 w-44 text-center font-mono text-[length:var(--text-small)]"
            value={pendingShortcut || t("pressNewKey")}
            readOnly
            autoFocus
            onKeyDown={handleShortcutKeyDown}
            onBlur={() => {
              if (pendingShortcut) {
                confirmShortcut();
              } else {
                setEditingShortcut(false);
              }
            }}
          />
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="min-w-24 font-mono"
            onClick={() => setEditingShortcut(true)}
          >
            {value.shortcut}
          </Button>
        )}
      />
      <SettingsRow
        title={t("screenshotRetention")}
        description={t("screenshotRetentionHint")}
        htmlFor="screenshot-retention-days"
        control={(
          <Input
            id="screenshot-retention-days"
            type="number"
            min={0}
            max={365}
            className="h-8 w-24 text-right"
            value={value.retentionDays}
            onChange={(e) => update("retentionDays", parseInt(e.target.value, 10) || 0)}
          />
        )}
      />
    </SettingsSection>
  );
}
