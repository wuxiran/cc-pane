import { useTranslation } from "react-i18next";
import { Columns3, LayoutGrid } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import type { LayoutEntry, Panel } from "@/types";
import { getPanels, tabKindLabel } from "./mobileUtils";

interface MobileLayoutBoardProps {
  layouts: LayoutEntry[];
  currentLayoutId?: string;
  panels: Panel[];
  activePaneId?: string;
  activeTabCount: number;
  onSwitchLayout: (layoutId: string) => void;
  onSelectPane: (paneId: string) => void;
  onSelectTab: (paneId: string, tabId: string) => void;
}

export default function MobileLayoutBoard({
  layouts,
  currentLayoutId,
  panels,
  activePaneId,
  activeTabCount,
  onSwitchLayout,
  onSelectPane,
  onSelectTab,
}: MobileLayoutBoardProps) {
  const { t } = useTranslation("mobile");

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold text-[var(--app-text-primary)]">{t("views.layouts")}</h2>
        <span className="text-[12px] text-[var(--app-text-tertiary)]">
          {t("layouts.paneTabSummary", { panes: panels.length, tabs: activeTabCount })}
        </span>
      </div>

      <section className="rounded-md border border-[var(--app-home-border)] bg-[var(--app-home-surface)] p-3">
        <div className="mb-2 text-[12px] font-semibold text-[var(--app-text-tertiary)]">{t("layouts.currentSection")}</div>
        <div className="grid grid-cols-2 gap-2">
          {layouts.map((layout) => {
            const active = layout.id === currentLayoutId;
            const panelCount = getPanels(layout.rootPane).length;
            return (
              <button
                key={layout.id}
                type="button"
                onClick={() => onSwitchLayout(layout.id)}
                className={`min-w-0 rounded-md border px-3 py-2 text-left transition active:scale-[0.99] ${
                  active
                    ? "border-[color-mix(in_srgb,var(--app-accent)_40%,transparent)] bg-[color-mix(in_srgb,var(--app-accent)_10%,transparent)] text-[var(--app-accent)]"
                    : "border-[var(--app-home-border)] bg-[var(--app-home-surface)] text-[var(--app-text-primary)] hover:bg-[var(--app-home-surface-hover)]"
                }`}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Columns3 className="h-4 w-4 flex-none" />
                  <span className="truncate text-[13px] font-semibold">{layout.name}</span>
                </div>
                <div className="mt-1 text-[11px] text-[var(--app-text-tertiary)]">{t("layouts.paneCount", { count: panelCount })}</div>
              </button>
            );
          })}
        </div>
        {layouts.length === 0 && (
          <EmptyState icon={LayoutGrid} title={t("layouts.empty")} />
        )}
      </section>

      <section className="rounded-md border border-[var(--app-home-border)] bg-[var(--app-home-surface)] p-3">
        <div className="mb-2 text-[12px] font-semibold text-[var(--app-text-tertiary)]">{t("layouts.paneTabSection")}</div>
        <div className="space-y-2">
          {panels.map((panel, panelIndex) => {
            const activePane = panel.id === activePaneId;
            return (
              <div
                key={panel.id}
                className={`rounded-md border p-2 ${
                  activePane
                    ? "border-[color-mix(in_srgb,var(--app-accent)_40%,transparent)] bg-[color-mix(in_srgb,var(--app-accent)_10%,transparent)]"
                    : "border-[var(--app-home-border)] bg-[var(--app-home-surface)]"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelectPane(panel.id)}
                  className="flex w-full items-center justify-between gap-2 text-left"
                >
                  <span className="min-w-0 truncate text-[13px] font-semibold text-[var(--app-text-primary)]">{t("layouts.paneLabel", { index: panelIndex + 1 })}</span>
                  <span className="flex-none text-[11px] text-[var(--app-text-tertiary)]">{t("layouts.tabCount", { count: panel.tabs.length })}</span>
                </button>
                <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
                  {panel.tabs.map((tab) => {
                    const activeTab = tab.id === panel.activeTabId;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => onSelectTab(panel.id, tab.id)}
                        className={`max-w-[150px] flex-none rounded-md border px-2 py-1.5 text-left ${
                          activeTab
                            ? "border-[color-mix(in_srgb,var(--app-accent)_40%,transparent)] bg-[var(--app-panel-bg)] text-[var(--app-accent)]"
                            : "border-[var(--app-home-border)] bg-[var(--app-panel-bg)] text-[var(--app-text-secondary)]"
                        }`}
                      >
                        <div className="truncate text-[12px] font-semibold">{tab.title}</div>
                        <div className="mt-0.5 truncate text-[10px] uppercase text-[var(--app-text-tertiary)]">{tabKindLabel(tab)}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        {panels.length === 0 && (
          <EmptyState icon={Columns3} title={t("layouts.noPanes")} />
        )}
      </section>
    </div>
  );
}
