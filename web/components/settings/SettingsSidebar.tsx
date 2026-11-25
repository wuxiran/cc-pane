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
  /** macOS 独立窗口（Overlay 标题栏）：顶部留一条拖拽带，红绿灯浮在其上，不压住搜索框。 */
  titlebarInset?: boolean;
}

/** 设置左侧导航：顶部搜索，下面按组列出页面（细线图标 + 文字，选中浅底），底部安静的版本号。 */
export default function SettingsSidebar({
  pages,
  activePageId,
  onSelect,
  searchSlot,
  titlebarInset = false,
}: SettingsSidebarProps) {
  const { t } = useTranslation("settings");

  return (
    <nav
      aria-label={t("navigation")}
      className="flex w-[var(--settings-sidebar-width)] shrink-0 flex-col overflow-hidden border-r border-[var(--app-border)] bg-[var(--app-sidebar-bg,var(--app-panel-bg))]"
    >
      {titlebarInset && (
        <div data-testid="settings-titlebar-inset" data-tauri-drag-region="" className="h-8 shrink-0" />
      )}
      {searchSlot && (
        <div className={titlebarInset ? "relative z-20 shrink-0 px-3 pb-2 pt-1" : "relative z-20 shrink-0 px-3 pb-2 pt-3"}>
          {searchSlot}
        </div>
      )}
      <div className="app-scrollbar flex-1 space-y-4 overflow-y-auto px-2 pb-3 pt-1">
        {SETTINGS_GROUPS.map((group) => {
          const groupPages = pages.filter((page) => page.group === group.id);
          if (groupPages.length === 0) return null;
          return (
            <section key={group.id} aria-labelledby={`settings-group-${group.id}`}>
              <h2
                id={`settings-group-${group.id}`}
                className="mb-1 px-2 text-[length:var(--text-caption)] font-medium uppercase tracking-[0.04em] text-[var(--app-text-tertiary)]"
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
                      className="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[length:var(--text-row)] text-[var(--app-text-secondary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] data-[current=true]:bg-[var(--app-active-bg)] data-[current=true]:text-[var(--app-text-primary)]"
                      onClick={() => onSelect(page.id)}
                    >
                      <Icon aria-hidden="true" size={15} strokeWidth={1.6} className="shrink-0" />
                      <span className="truncate">{t(page.titleKey)}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      <div className="flex shrink-0 items-baseline gap-1.5 px-4 py-2.5 text-[length:var(--text-caption)] leading-4 text-[var(--app-text-tertiary)] opacity-80">
        <span className="truncate">CC-Panes</span>
        <span className="truncate font-mono">v{packageJson.version}</span>
      </div>
    </nav>
  );
}
