import { useTranslation } from "react-i18next";
import { Keyboard } from "lucide-react";
import { useSettingsStore } from "@/stores";
import { formatKeyCombo } from "@/stores";

const SHORTCUT_DISPLAY: { id: string; labelKey: string }[] = [
  { id: "toggle-sidebar", labelKey: "toggle-sidebar" },
  { id: "new-tab", labelKey: "new-tab" },
  { id: "settings", labelKey: "settings" },
  { id: "close-tab", labelKey: "close-tab" },
  { id: "split-right", labelKey: "split-right" },
  { id: "toggle-fullscreen", labelKey: "toggle-fullscreen" },
];

/** 稳定空对象引用，避免每次 selector 返回新 {} 导致无限重渲染 */
const EMPTY_BINDINGS: Record<string, string> = {};

export default function HomeShortcuts() {
  const { t } = useTranslation("home");
  const { t: tShortcuts } = useTranslation("shortcuts");
  const bindings = useSettingsStore(
    (s) => s.settings?.shortcuts.bindings ?? EMPTY_BINDINGS,
  );

  return (
    <div>
      <h3
        className="flex items-center gap-2 text-sm font-semibold mb-3"
        style={{ color: "var(--app-text-primary)" }}
      >
        <Keyboard className="w-4 h-4" style={{ color: "var(--app-text-tertiary)" }} />
        {t("shortcuts")}
      </h3>
      <div className="grid grid-cols-2 gap-2">
        {SHORTCUT_DISPLAY.map(({ id, labelKey }) => {
          const combo = bindings[id];
          if (!combo) return null;
          return (
            <div
              key={id}
              className="flex items-center justify-between px-3 py-2.5 rounded-xl"
              style={{
                background: "var(--app-glass-bg)",
                border: "1px solid var(--app-border)",
              }}
            >
              <span
                className="text-xs"
                style={{ color: "var(--app-text-secondary)" }}
              >
                {tShortcuts(labelKey as never)}
              </span>
              <kbd
                className="px-2 py-0.5 rounded text-xs font-mono"
                style={{
                  background: "var(--app-hover)",
                  color: "var(--app-text-primary)",
                  border: "1px solid var(--app-border)",
                  borderBottom: "2px solid var(--app-border)",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
                }}
              >
                {formatKeyCombo(combo)}
              </kbd>
            </div>
          );
        })}
      </div>
    </div>
  );
}
