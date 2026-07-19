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

function getShortcutKeys(combo: string): string[] {
  return formatKeyCombo(combo).split("+").filter(Boolean);
}

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
      <div className="rounded-2xl overflow-hidden border border-[var(--app-home-border)] bg-[var(--app-home-surface)]">
        {SHORTCUT_DISPLAY.map(({ id, labelKey }) => {
          const combo = bindings[id];
          if (!combo) return null;
          const keys = getShortcutKeys(combo);
          return (
            <div
              key={id}
              className="flex items-center justify-between gap-4 px-5 py-3 border-b border-[var(--app-home-row-border)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-home-surface-hover)] last:border-b-0"
            >
              <span
                className="text-xs"
                style={{ color: "var(--app-text-secondary)" }}
              >
                {tShortcuts(labelKey as never)}
              </span>
              <span className="flex items-center gap-1.5 shrink-0">
                {keys.map((key, index) => (
                  <span key={`${id}-${key}-${index}`} className="flex items-center gap-1.5">
                    {index > 0 && (
                      <span
                        className="text-xs"
                        style={{ color: "var(--app-text-tertiary)" }}
                      >
                        +
                      </span>
                    )}
                    <kbd
                      className="px-2 py-1 rounded text-xs font-mono shadow-inner"
                      style={{
                        background: "var(--app-home-kbd-bg)",
                        color: "var(--app-text-primary)",
                        border: "1px solid var(--app-home-border-hover)",
                      }}
                    >
                      {key}
                    </kbd>
                  </span>
                ))}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
