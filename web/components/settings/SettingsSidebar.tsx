import { useTranslation } from "react-i18next";
import {
  SETTINGS_GROUPS,
  type SettingsPaneDefinition,
  type SettingsPaneId,
} from "./settingsRegistry";

interface SettingsSidebarProps {
  panes: readonly SettingsPaneDefinition[];
  activePaneId: SettingsPaneId;
  onSelect: (paneId: SettingsPaneId) => void;
}

export default function SettingsSidebar({ panes, activePaneId, onSelect }: SettingsSidebarProps) {
  const { t } = useTranslation("settings");

  return (
    <nav
      aria-label={t("navigation")}
      className="w-[280px] shrink-0 overflow-y-auto border-r border-[var(--app-border)] bg-[var(--app-panel-bg)] px-4 py-5"
    >
      <div className="space-y-5">
        {SETTINGS_GROUPS.map((group) => {
          const groupPanes = panes.filter((pane) => pane.group === group.id);
          if (groupPanes.length === 0) return null;
          return (
            <section key={group.id} aria-labelledby={`settings-group-${group.id}`}>
              <h2
                id={`settings-group-${group.id}`}
                className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--app-text-tertiary)]"
              >
                {t(group.titleKey)}
              </h2>
              <div className="space-y-0.5">
                {groupPanes.map((pane) => {
                  const Icon = pane.icon;
                  const active = activePaneId === pane.id;
                  return (
                    <button
                      key={pane.id}
                      type="button"
                      aria-current={active ? "page" : undefined}
                      data-current={active ? "true" : undefined}
                      className="relative flex w-full items-center gap-2.5 rounded-md border border-transparent px-3 py-2 text-left text-[13px] text-[var(--app-text-secondary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] data-[current=true]:border-[var(--app-border)] data-[current=true]:bg-[var(--app-active-bg)] data-[current=true]:font-semibold data-[current=true]:text-[var(--app-accent)]"
                      onClick={() => onSelect(pane.id)}
                    >
                      <Icon aria-hidden="true" size={16} className="shrink-0" />
                      <span className="truncate">{t(pane.titleKey)}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </nav>
  );
}
