import { useMemo } from "react";
import { FolderOpen, PanelTopOpen, Radio, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  formatContentSize,
  groupPanelsByWorkspace,
} from "@/components/aipanel/aiPanelGrouping";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  openAiPanelFromHistory,
  removeAiPanelFromHistory,
} from "@/hooks/useAiPanelHistory";
import { useAiPanelStore } from "@/stores/useAiPanelStore";
import type { AiPanelSummary } from "@/types/aiPanel";

function formatUpdatedAt(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export default function AiPanelHistoryList() {
  const { t, i18n } = useTranslation("sidebar");
  const history = useAiPanelStore((state) => state.history);
  const loading = useAiPanelStore((state) => state.historyLoading);
  const livePanelIds = useAiPanelStore((state) => state.panels);

  // 选稳定引用后本地派生：store 方法里做 filter/map 会让快照永不相等而崩页
  const groups = useMemo(() => groupPanelsByWorkspace(history), [history]);
  const liveIds = useMemo(
    () => new Set(livePanelIds.map((panel) => panel.panelId)),
    [livePanelIds],
  );

  if (history.length === 0) {
    return (
      <EmptyState
        icon={PanelTopOpen}
        title={loading ? t("aiPanel.historyLoading") : t("aiPanel.historyEmpty")}
        illustration="empty-history"
        className="h-full"
      />
    );
  }

  const handleOpen = async (panel: AiPanelSummary) => {
    const opened = await openAiPanelFromHistory(panel.panelId).catch(() => false);
    if (!opened) toast.error(t("aiPanel.openHistoryFailed"));
  };

  const handleDelete = async (event: React.MouseEvent, panel: AiPanelSummary) => {
    event.stopPropagation();
    const removed = await removeAiPanelFromHistory(panel.panelId).catch(() => false);
    if (!removed) toast.error(t("aiPanel.deleteFailed"));
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      {groups.map((group) => (
        <section key={group.workspaceName ?? "__ungrouped__"} className="min-w-0">
          <header className="sticky top-0 z-10 flex items-center gap-2 bg-[var(--app-panel-bg)] px-3 py-2 text-[11px] font-medium text-[var(--app-text-tertiary)]">
            <FolderOpen aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate">
              {group.workspaceName ?? t("aiPanel.ungroupedWorkspace")}
            </span>
            <span className="shrink-0 tabular-nums">{group.panels.length}</span>
          </header>

          <ul className="min-w-0">
            {group.panels.map((panel) => {
              const isLive = liveIds.has(panel.panelId);
              return (
                <li key={panel.panelId}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => void handleOpen(panel)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        void handleOpen(panel);
                      }
                    }}
                    className="group flex w-full min-w-0 cursor-pointer items-start gap-2 px-3 py-2 text-left outline-none hover:bg-[var(--app-hover)] focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-[13px] text-[var(--app-text-primary)]">
                          {panel.title}
                        </span>
                        {isLive && (
                          <Radio
                            aria-label={t("aiPanel.livePanel")}
                            className="size-3 shrink-0 text-[var(--app-status-success)]"
                          />
                        )}
                      </div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-[var(--app-text-tertiary)]">
                        <span className="truncate">{panel.driverName}</span>
                        <span aria-hidden="true">/</span>
                        <span className="shrink-0">
                          {formatUpdatedAt(panel.updatedAt, i18n.language)}
                        </span>
                        <span aria-hidden="true">/</span>
                        <span className="shrink-0 tabular-nums">
                          {formatContentSize(panel.contentBytes)}
                        </span>
                      </div>
                    </div>

                    <button
                      type="button"
                      aria-label={t("aiPanel.deletePanel")}
                      onClick={(event) => void handleDelete(event, panel)}
                      className="flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--app-text-tertiary)] opacity-0 outline-none hover:bg-[var(--app-active-bg)] hover:text-[var(--app-status-danger)] focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] group-hover:opacity-100"
                    >
                      <Trash2 aria-hidden="true" className="size-3.5" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
