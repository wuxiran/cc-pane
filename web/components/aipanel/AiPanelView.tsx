import { ChevronLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import AiPanelFrame from "@/components/aipanel/AiPanelFrame";
import AiPanelHistoryList from "@/components/aipanel/AiPanelHistoryList";
import { useAiPanelStore } from "@/stores/useAiPanelStore";

function formatUpdatedAt(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/**
 * AI 面板的两级视图：按工作空间分组的历史列表 ↔ 单个面板详情。
 *
 * 列表是默认落点——面板不再是“当下这一个”，而是一份可回溯的历史。
 * AI 推送新面板时由 listener 调 selectPanel 直接跳详情。
 */
export default function AiPanelView() {
  const { t, i18n } = useTranslation("sidebar");
  const panels = useAiPanelStore((state) => state.panels);
  const history = useAiPanelStore((state) => state.history);
  const activePanelId = useAiPanelStore((state) => state.activePanelId);
  const view = useAiPanelStore((state) => state.view);
  const setView = useAiPanelStore((state) => state.setView);

  const activePanel = panels.find((panel) => panel.panelId === activePanelId);
  // 无人持有 = 快照。按钮点下去没有会话能收事件，必须让用户看见这件事，
  // 否则它和一个活面板长得一模一样，点了却毫无反应。
  const isArchived = history.some(
    (entry) => entry.panelId === activePanelId && entry.ownerSessionId === null,
  );

  if (view === "list" || !activePanel) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-[var(--app-panel-bg)]">
        <div className="flex min-h-14 shrink-0 items-center gap-3 border-b border-[var(--app-border)] px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-[var(--app-text-primary)]">
              {t("aiPanel.historyTitle")}
            </div>
            <div className="mt-1 truncate text-[11px] text-[var(--app-text-tertiary)]">
              {t("aiPanel.historySubtitle")}
            </div>
          </div>
        </div>
        <div className="min-h-0 flex-1">
          <AiPanelHistoryList />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--app-panel-bg)]">
      <div className="flex min-h-14 shrink-0 items-center gap-2 border-b border-[var(--app-border)] px-2 py-2">
        <button
          type="button"
          aria-label={t("aiPanel.backToHistory")}
          onClick={() => setView("list")}
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-[var(--app-text-secondary)] outline-none hover:bg-[var(--app-hover)] focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-[var(--app-text-primary)]">
              {activePanel.title}
            </span>
            {isArchived && (
              <span
                title={t("aiPanel.archivedHint")}
                className="shrink-0 rounded-full bg-[var(--app-active-bg)] px-2 py-0.5 text-[10px] text-[var(--app-text-tertiary)]"
              >
                {t("aiPanel.archived")}
              </span>
            )}
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-[11px] text-[var(--app-text-tertiary)]">
            <span className="truncate">
              {t("aiPanel.drivenBy", { name: activePanel.driverName })}
            </span>
            <span aria-hidden="true">/</span>
            <span className="shrink-0">
              {t("aiPanel.updatedAt", {
                time: formatUpdatedAt(activePanel.updatedAt, i18n.language),
              })}
            </span>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <AiPanelFrame panel={activePanel} />
      </div>
    </div>
  );
}
