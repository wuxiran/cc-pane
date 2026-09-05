// 快捷键速查表（Ctrl+/）：从命令注册中心按组生成——新增命令自动出现，
// 键位实时读绑定表（用户改键后同步变）。此前速查只能靠埋在设置里的可编辑列表。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { resolveCommandTitle, useCommandsStore } from "@/lib/commands/registry";
import { COMMAND_GROUP_HEADING_KEYS, COMMAND_GROUP_ORDER } from "@/lib/commands/groups";
import { useSettingsStore } from "@/stores";
import { formatKeyCombo } from "@/stores/useShortcutsStore";

export const SHORTCUT_CHEATSHEET_TOGGLE_EVENT = "cc-panes:shortcut-cheatsheet-toggle";

export default function ShortcutCheatsheet() {
  const { t } = useTranslation("shortcuts");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const toggle = () => setOpen((prev) => !prev);
    window.addEventListener(SHORTCUT_CHEATSHEET_TOGGLE_EVENT, toggle);
    return () => window.removeEventListener(SHORTCUT_CHEATSHEET_TOGGLE_EVENT, toggle);
  }, []);

  const commands = useCommandsStore((s) => s.commands);
  const bindings = useSettingsStore((s) => s.settings?.shortcuts.bindings);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("shortcut-cheatsheet")}</DialogTitle>
        </DialogHeader>
        <div className="app-scrollbar grid max-h-[70vh] grid-cols-1 gap-5 overflow-y-auto sm:grid-cols-2">
          {COMMAND_GROUP_ORDER.map((group) => {
            const items = Array.from(commands.values()).filter((cmd) => cmd.group === group);
            if (items.length === 0) return null;
            return (
              <section key={group}>
                <h3 className="mb-1.5 text-xs font-semibold text-[var(--app-text-secondary)]">
                  {t(COMMAND_GROUP_HEADING_KEYS[group] as never)}
                </h3>
                <ul className="flex flex-col gap-0.5">
                  {items.map((cmd) => {
                    const binding = bindings?.[cmd.id];
                    return (
                      <li
                        key={cmd.id}
                        className="flex items-center justify-between gap-3 rounded px-1.5 py-1 text-[13px] hover:bg-[var(--app-hover)]"
                      >
                        <span className="min-w-0 truncate text-[var(--app-text-primary)]">
                          {resolveCommandTitle(cmd)}
                        </span>
                        <kbd className="shrink-0 rounded border border-[var(--app-border)] bg-[var(--app-content)] px-1.5 py-0.5 text-[11px] text-[var(--app-text-tertiary)]">
                          {binding ? formatKeyCombo(binding) : "—"}
                        </kbd>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
        <p className="m-0 text-[11px] text-[var(--app-text-tertiary)]">
          {t("cheatsheetRebindHint")}
        </p>
      </DialogContent>
    </Dialog>
  );
}
