import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { parseKeyEvent, formatKeyCombo, findConflict } from "@/stores";
import type { ShortcutSettings } from "@/types";

interface ShortcutsSectionProps {
  value: ShortcutSettings;
  onChange: (value: ShortcutSettings) => void;
}

/** Action key to shortcuts namespace i18n key mapping */
const actionI18nKeys: Record<string, string> = {
  "toggle-sidebar": "toggle-sidebar",
  "toggle-fullscreen": "toggle-fullscreen",
  "new-tab": "new-tab",
  "close-tab": "close-tab",
  settings: "settings",
  "split-right": "split-right",
  "split-down": "split-down",
  "next-tab": "next-tab",
  "prev-tab": "prev-tab",
  "toggle-mini-mode": "toggle-mini-mode",
};

export default function ShortcutsSection({ value, onChange }: ShortcutsSectionProps) {
  const { t } = useTranslation(["settings", "shortcuts"]);
  const [editingAction, setEditingAction] = useState<string | null>(null);

  /** Map action keys to their i18n labels */
  function getActionLabel(action: string): string {
    // switch-tab-N -> use the parameterized key "switch-tab" with index
    const switchTabMatch = action.match(/^switch-tab-(\d+)$/);
    if (switchTabMatch) {
      return t("shortcuts:switch-tab", { index: switchTabMatch[1] });
    }
    // Other actions use the static mapping
    if (action in actionI18nKeys) {
      return t(`shortcuts:${actionI18nKeys[action]}` as "shortcuts:toggle-sidebar");
    }
    return action;
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!editingAction) return;
    e.preventDefault();
    e.stopPropagation();

    const combo = parseKeyEvent(e.nativeEvent);
    if (!combo) return;

    if (combo === "Escape") {
      setEditingAction(null);
      return;
    }

    const conflict = findConflict(value.bindings, editingAction, combo);
    if (conflict) {
      toast.warning(t("settings:shortcutConflict", { combo, label: getActionLabel(conflict) }));
      return;
    }

    const newBindings = { ...value.bindings, [editingAction]: combo };
    setEditingAction(null);
    onChange({ bindings: newBindings });
  }

  return (
    <div className="flex flex-col gap-3 outline-none" tabIndex={-1} onKeyDown={handleKeyDown}>
      <h3 className="text-[15px] font-semibold mb-1" style={{ color: "var(--app-text-primary)" }}>
        {t("settings:shortcutsTitle")}
      </h3>
      <p className="text-xs" style={{ color: "var(--app-text-tertiary)" }}>
        {t("settings:shortcutsHint")}
      </p>

      <div className="flex flex-col gap-0.5">
        {Object.entries(value.bindings).map(([action, combo]) => (
          <div
            key={action}
            className="flex justify-between items-center py-1.5"
            style={{ borderBottom: "1px solid var(--app-border)" }}
          >
            <span className="text-[13px]" style={{ color: "var(--app-text-secondary)" }}>
              {getActionLabel(action)}
            </span>
            <button
              className="text-xs px-2.5 py-[3px] rounded font-mono min-w-[80px] text-center cursor-pointer transition-all"
              style={{
                background: editingAction === action ? "var(--app-active-bg)" : "var(--app-hover)",
                border: `1px solid ${editingAction === action ? "var(--app-accent)" : "var(--app-border)"}`,
                color: editingAction === action ? "var(--app-accent)" : "var(--app-text-primary)",
              }}
              onClick={() => setEditingAction(action)}
            >
              {editingAction === action ? t("settings:pressNewKey") : formatKeyCombo(combo)}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
