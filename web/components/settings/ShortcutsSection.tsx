import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toastWarn } from "@/lib/feedback";
import { parseKeyEvent, formatKeyCombo, findConflict } from "@/stores";
import type { ShortcutSettings } from "@/types";
import { cn } from "@/lib/utils";
import { SearchableSetting } from "./SettingsSearchContext";
import { SettingsRow, SettingsSection } from "./layout";

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
  "reopen-closed-tab": "reopen-closed-tab",
  settings: "settings",
  "command-palette": "command-palette",
  "toggle-layouts": "toggle-layouts",
  "split-right": "split-right",
  "split-down": "split-down",
  "focus-pane-left": "focus-pane-left",
  "focus-pane-right": "focus-pane-right",
  "focus-pane-up": "focus-pane-up",
  "focus-pane-down": "focus-pane-down",
  "next-tab": "next-tab",
  "prev-tab": "prev-tab",
  "terminal-zoom-in": "terminal-zoom-in",
  "terminal-zoom-out": "terminal-zoom-out",
  "terminal-zoom-reset": "terminal-zoom-reset",
  "terminal-rebuild-display": "terminal-rebuild-display",
  "toggle-mini-mode": "toggle-mini-mode",
  "voice-input": "voice-input",
  "toggle-right-dock": "toggle-right-dock",
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
    // switch-layout-N -> use the parameterized key "switch-layout" with index
    const switchLayoutMatch = action.match(/^switch-layout-(\d+)$/);
    if (switchLayoutMatch) {
      return t("shortcuts:switch-layout", { index: switchLayoutMatch[1] });
    }
    const dockViewMatch = action.match(/^focus-dock-view-(\d+)$/);
    if (dockViewMatch) {
      return t("shortcuts:focus-dock-view", { index: dockViewMatch[1] });
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
      toastWarn(t("settings:shortcutConflict", { combo, label: getActionLabel(conflict) }));
      return;
    }

    const newBindings = { ...value.bindings, [editingAction]: combo };
    setEditingAction(null);
    onChange({ bindings: newBindings });
  }

  return (
    // 键盘捕获挂在外层：编辑中的按键（含冲突提示）都由这里统一处理
    <div className="outline-none" tabIndex={-1} onKeyDown={handleKeyDown}>
      <SearchableSetting sectionId="shortcuts-list">
        <SettingsSection title={t("settings:shortcutsTitle")} description={t("settings:shortcutsHint")}>
          {Object.entries(value.bindings).map(([action, combo]) => {
            const editing = editingAction === action;
            return (
              <SettingsRow
                key={action}
                className="py-2"
                title={getActionLabel(action)}
                control={(
                  <button
                    type="button"
                    className={cn(
                      "shape-control min-w-[80px] cursor-default rounded-md border px-2.5 py-[3px] text-center font-mono text-xs transition-colors duration-[var(--dur-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]",
                      editing
                        ? "border-[var(--app-accent)] bg-[var(--app-active-bg)] text-[var(--app-accent)]"
                        : "border-[var(--app-border)] bg-[var(--app-hover)] text-[var(--app-text-primary)]",
                    )}
                    onClick={() => setEditingAction(action)}
                  >
                    {editing ? t("settings:pressNewKey") : formatKeyCombo(combo)}
                  </button>
                )}
              />
            );
          })}
        </SettingsSection>
      </SearchableSetting>
    </div>
  );
}
