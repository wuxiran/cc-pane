import { useMemo } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Terminal, Circle } from "lucide-react";
import { usePanesStore, useTerminalStatusStore } from "@/stores";
import { isBusyStatus, type PaneNode, type Tab, type TerminalStatusType } from "@/types";

function getAllTabs(pane: PaneNode): Tab[] {
  if (pane.type === "panel") return pane.tabs;
  return pane.children.flatMap(getAllTabs);
}

function statusColor(status: TerminalStatusType | null): string {
  switch (status) {
    case "active":
    case "thinking":
    case "toolRunning":
      return "var(--chart-2)";
    case "compacting":
      return "var(--chart-1)";
    case "waitingInput":
      return "var(--app-warning)";
    case "error":
      return "var(--destructive)";
    case "idle":
      return "var(--app-text-tertiary)";
    default:
      return "var(--app-text-tertiary)";
  }
}

export default function HomeActiveSessions() {
  const { t } = useTranslation("home");
  const rootPane = usePanesStore((s) => s.rootPane);
  const statusMap = useTerminalStatusStore((s) => s.statusMap);

  const activeTabs = useMemo(() => {
    return getAllTabs(rootPane).filter((tab) => tab.sessionId);
  }, [rootPane]);

  const getStatusLabel = (status: TerminalStatusType | null): string => {
    if (isBusyStatus(status)) return t("running");
    if (status === "waitingInput") return t("waiting");
    return t("idle");
  };

  function focusTab(tabId: string) {
    const store = usePanesStore.getState();
    const location = store.findTabAcrossLayouts(tabId);
    if (!location) return;
    if (location.layoutId !== store.currentLayoutId) {
      store.switchLayout(location.layoutId);
    }
    store.setActivePane(location.panel.id);
    store.selectTab(location.panel.id, location.tab.id);
  }

  if (activeTabs.length === 0) {
    return (
      <div>
        <h3
          className="text-sm font-semibold mb-3"
          style={{ color: "var(--app-text-primary)" }}
        >
          {t("activeSessions")}
        </h3>
        <div
          className="group relative flex h-[280px] flex-col items-center justify-center overflow-hidden rounded-2xl border border-[var(--app-home-border)] bg-[var(--app-home-surface)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-home-surface-hover)]"
        >
          <div
            className="absolute inset-0 bg-gradient-to-b from-transparent to-[color-mix(in_srgb,var(--primary-foreground)_1%,transparent)]"
            aria-hidden="true"
          />
          <Terminal
            className="relative w-8 h-8 mb-2 opacity-40 transition-opacity duration-[var(--dur-fast)] group-hover:opacity-60"
            style={{ color: "var(--app-text-tertiary)" }}
          />
          <p
            className="relative text-xs"
            style={{ color: "var(--app-text-tertiary)" }}
          >
            {t("noActiveSessions")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h3
        className="text-sm font-semibold mb-3"
        style={{ color: "var(--app-text-primary)" }}
      >
        {t("activeSessions")}
      </h3>
      <div
        className="rounded-2xl overflow-hidden divide-y"
        style={{
          background: "var(--app-home-surface)",
          border: "1px solid var(--app-home-border)",
          "--tw-divide-opacity": "1",
          borderColor: "var(--app-home-row-border)",
        } as CSSProperties}
      >
        {activeTabs.slice(0, 5).map((tab) => {
          const status = statusMap.get(tab.sessionId!)?.status ?? null;
          return (
            <button
              key={tab.id}
              type="button"
              className="home-session-item flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors duration-[var(--dur-fast)]"
              style={{ borderColor: "var(--app-home-row-border)" }}
              onClick={() => focusTab(tab.id)}
            >
              <Circle
                className={`w-2.5 h-2.5 shrink-0 ${isBusyStatus(status) ? "animate-pulse" : ""}`}
                fill={statusColor(status)}
                stroke="none"
              />
              <span
                className="text-sm truncate flex-1"
                style={{ color: "var(--app-text-primary)" }}
              >
                {tab.title || tab.projectPath?.split(/[/\\]/).pop() || "Terminal"}
              </span>
              <span
                className="text-xs shrink-0"
                style={{ color: "var(--app-text-tertiary)" }}
              >
                {getStatusLabel(status)}
              </span>
            </button>
          );
        })}
        <div
          className="px-3 py-2 text-xs"
          style={{
            color: "var(--app-text-tertiary)",
            background: "var(--app-home-surface-light, var(--app-home-surface))",
            borderColor: "var(--app-home-row-border)",
          }}
        >
          {t("totalSessions", { count: activeTabs.length })}
        </div>
      </div>
    </div>
  );
}
