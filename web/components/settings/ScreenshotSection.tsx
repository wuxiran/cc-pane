import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { screenshotService } from "@/services";
import { getErrorMessage } from "@/utils";
import type { ScreenshotSettings } from "@/types";

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
    if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
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
      toast.success(t("screenshotShortcutUpdated"));
    } catch (err) {
      toast.error(t("screenshotShortcutConflict", { error: getErrorMessage(err) }));
    }
    setEditingShortcut(false);
    setPendingShortcut("");
  }

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-[15px] font-semibold mb-1" style={{ color: "var(--app-text-primary)" }}>
        {t("screenshotTitle")}
      </h3>
      <p className="text-xs mb-3" style={{ color: "var(--app-text-tertiary)" }}>
        {t("screenshotDesc")}
      </p>

      {/* 快捷键 */}
      <div className="flex items-center justify-between">
        <Label>{t("screenshotShortcut")}</Label>
        {editingShortcut ? (
          <div className="flex items-center gap-2">
            <Input
              className="w-[180px] h-8 text-center text-xs"
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
          </div>
        ) : (
          <button
            className="px-3 py-1 rounded text-xs font-mono cursor-pointer border"
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

      {/* 保留天数 */}
      <div className="flex items-center justify-between">
        <div>
          <Label>{t("screenshotRetention")}</Label>
          <p className="text-xs mt-0.5" style={{ color: "var(--app-text-tertiary)" }}>
            {t("screenshotRetentionHint")}
          </p>
        </div>
        <Input
          type="number"
          min={0}
          max={365}
          className="w-[80px] h-8 text-center text-xs"
          value={value.retentionDays}
          onChange={(e) => update("retentionDays", parseInt(e.target.value, 10) || 0)}
        />
      </div>
    </div>
  );
}
