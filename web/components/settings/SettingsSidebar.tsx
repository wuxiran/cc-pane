import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import packageJson from "../../../package.json";
import {
  SETTINGS_GROUPS,
  type SettingsPageDefinition,
  type SettingsPageId,
} from "./settingsRegistry";

interface SettingsSidebarProps {
  pages: readonly SettingsPageDefinition[];
  activePageId: SettingsPageId;
  onSelect: (pageId: SettingsPageId) => void;
  searchSlot?: ReactNode;
}

export default function SettingsSidebar({ pages, activePageId, onSelect, searchSlot }: SettingsSidebarProps) {
  const { t } = useTranslation("settings");

  return (
    <nav
      aria-label={t("navigation")}
      className="flex w-[var(--settings-sidebar-width)] shrink-0 flex-col overflow-hidden border-r border-[var(--app-border)] bg-[var(--app-panel-bg)]"
    >
      {searchSlot && (
        <div className="relative z-20 shrink-0 px-2 pb-1.5 pt-2">
          {searchSlot}
        </div>
      )}
      <div className="flex-1 space-y-3 overflow-y-auto px-2 pb-3 pt-2">
        {SETTINGS_GROUPS.map((group) => {
          const groupPages = pages.filter((page) => page.group === group.id);
          if (groupPages.length === 0) return null;
          return (
            <section key={group.id} aria-labelledby={`settings-group-${group.id}`}>
              <h2
                id={`settings-group-${group.id}`}
                className="mb-1 px-2 text-[11px] font-medium text-[var(--app-text-tertiary)]"
              >
                {t(group.titleKey)}
              </h2>
              <div className="space-y-px">
                {groupPages.map((page) => {
                  const Icon = page.icon;
                  const active = activePageId === page.id;
                  return (
                    <button
                      key={page.id}
                      type="button"
                      aria-current={active ? "page" : undefined}
                      data-current={active ? "true" : undefined}
                      className="flex min-h-8 w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-[var(--app-text-secondary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] data-[current=true]:bg-[var(--app-active-bg)] data-[current=true]:font-medium data-[current=true]:text-[var(--app-text-primary)] sm:text-[13px]"
                      onClick={() => onSelect(page.id)}
                    >
                      <Icon aria-hidden="true" size={16} className="shrink-0" />
                      <span className="truncate">{t(page.titleKey)}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      <div className="shrink-0 border-t border-[var(--app-border)] px-3 py-2.5 text-[10px] leading-4 text-[var(--app-text-tertiary)] sm:text-[11px]">
        <div className="truncate">CC-Panes</div>
        <div className="truncate">v{packageJson.version}</div>
      </div>
    </nav>
  );
}
