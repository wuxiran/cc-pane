import { Folder, Star } from "lucide-react";
import { useTranslation } from "react-i18next";
import StatusIndicator from "@/components/StatusIndicator";
import { usePanesStore, useTerminalStatusStore } from "@/stores";

export default function StarredPanel() {
  const { t } = useTranslation("panes");
  const starredTabs = usePanesStore((s) => s.starredTabs());
  const openStarredTab = usePanesStore((s) => s.openStarredTab);
  const getStatus = useTerminalStatusStore((s) => s.getStatus);

  return (
    <div className="flex h-full min-h-0 w-full flex-col" style={{ background: "var(--app-panel-bg)", color: "var(--app-text-primary)" }}>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4" style={{ borderColor: "var(--app-border)" }}>
        <Star className="h-4 w-4" fill="currentColor" style={{ color: "var(--app-accent)" }} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{t("starredPanelTitle")}</div>
          <div className="truncate text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
            {t("starredPanelCount", { count: starredTabs.length })}
          </div>
        </div>
      </div>

      {starredTabs.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <div
            className="flex h-12 w-12 items-center justify-center rounded-md border"
            style={{ borderColor: "var(--app-border)", color: "var(--app-text-tertiary)" }}
          >
            <Star className="h-5 w-5" />
          </div>
          <div className="max-w-sm text-sm" style={{ color: "var(--app-text-secondary)" }}>
            {t("starredPanelEmpty")}
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="grid gap-2">
            {starredTabs.map(({ layoutId, layoutName, paneId, tab }) => (
              <button
                key={`${layoutId}:${paneId}:${tab.id}`}
                type="button"
                className="flex min-h-14 w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors hover:bg-[var(--app-hover)]"
                style={{ borderColor: "var(--app-border)", background: "var(--app-content-bg)" }}
                onClick={() => openStarredTab(tab.id)}
              >
                <StatusIndicator status={getStatus(tab.sessionId)} size={8} />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <Star className="h-3.5 w-3.5 shrink-0" fill="currentColor" style={{ color: "var(--app-accent)" }} />
                    <span className="truncate text-sm font-medium">{tab.title}</span>
                  </div>
                  <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
                    <Folder className="h-3 w-3 shrink-0" />
                    <span className="truncate">{layoutName}</span>
                    {tab.projectPath ? (
                      <>
                        <span className="shrink-0 opacity-60">/</span>
                        <span className="truncate">{tab.projectPath}</span>
                      </>
                    ) : null}
                  </div>
                </div>
                <span className="shrink-0 text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
                  {t("starredPanelOpen")}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
