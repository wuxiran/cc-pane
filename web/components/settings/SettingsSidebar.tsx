import type { KeyboardEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import packageJson from "../../../package.json";
import {
  SETTINGS_GROUPS,
  getSettingsPanesForPage,
  type SettingsPageDefinition,
  type SettingsPaneDefinition,
  type SettingsPaneId,
} from "./settingsRegistry";

interface SettingsSidebarProps {
  pages: readonly SettingsPageDefinition[];
  panes: readonly SettingsPaneDefinition[];
  activePaneId: SettingsPaneId;
  onSelectPane: (paneId: SettingsPaneId) => void;
  searchSlot?: ReactNode;
}

export default function SettingsSidebar({
  pages,
  panes,
  activePaneId,
  onSelectPane,
  searchSlot,
}: SettingsSidebarProps) {
  const { t } = useTranslation("settings");

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const navigationKeys = ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"];
    if (!navigationKeys.includes(event.key)) return;

    const tabs = Array.from(
      event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
    );
    const currentIndex = tabs.indexOf(event.currentTarget);
    if (currentIndex < 0 || tabs.length === 0) return;

    let nextIndex = currentIndex;
    if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    else if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % tabs.length;
    } else {
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    }

    event.preventDefault();
    const nextTab = tabs[nextIndex];
    if (!nextTab) return;
    const nextPaneId = nextTab.dataset.paneId as SettingsPaneId | undefined;
    if (!nextPaneId) return;
    onSelectPane(nextPaneId);
    nextTab.focus();
  }

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
      <div
        role="tablist"
        aria-label={t("paneNavigation")}
        aria-orientation="vertical"
        className="app-scrollbar flex-1 space-y-3 overflow-y-auto px-2 pb-3 pt-2"
      >
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
              <div className="space-y-2">
                {groupPages.map((page) => {
                  const pagePanes = getSettingsPanesForPage(page.id, panes);
                  if (pagePanes.length === 0) return null;
                  const showPageHeading = pagePanes.length > 1;
                  return (
                    <section key={page.id} aria-labelledby={showPageHeading ? `settings-page-${page.id}` : undefined}>
                      {showPageHeading && (
                        <h3
                          id={`settings-page-${page.id}`}
                          className="mb-1 px-2 text-[11px] font-medium text-[var(--app-text-secondary)]"
                        >
                          {t(page.titleKey)}
                        </h3>
                      )}
                      <div className="space-y-px">
                        {pagePanes.map((pane) => {
                          const PaneIcon = pane.icon;
                          const selected = activePaneId === pane.id;
                          return (
                            <button
                              key={pane.id}
                              id={`settings-pane-tab-${pane.id}`}
                              type="button"
                              role="tab"
                              aria-selected={selected}
                              aria-controls={`settings-pane-${pane.id}`}
                              tabIndex={selected ? 0 : -1}
                              data-pane-id={pane.id}
                              data-selected={selected ? "true" : undefined}
                              className="flex min-h-8 w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-[var(--app-text-secondary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] data-[selected=true]:bg-[var(--app-active-bg)] data-[selected=true]:font-medium data-[selected=true]:text-[var(--app-text-primary)] sm:text-[13px]"
                              onClick={() => onSelectPane(pane.id)}
                              onKeyDown={handleKeyDown}
                            >
                              <PaneIcon aria-hidden="true" size={16} className="shrink-0" />
                              <span className="truncate">{t(pane.titleKey)}</span>
                            </button>
                          );
                        })}
                      </div>
                    </section>
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
