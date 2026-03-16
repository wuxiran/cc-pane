import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Terminal, Circle } from "lucide-react";
import { usePanesStore, useTerminalStatusStore } from "@/stores";
import type { PaneNode, Tab, TerminalStatusType } from "@/types";

function getAllTabs(pane: PaneNode): Tab[] {
  if (pane.type === "panel") return pane.tabs;
  return pane.children.flatMap(getAllTabs);
}

function statusColor(status: TerminalStatusType | null): string {
  switch (status) {
    case "active":
      return "#22c55e";
    case "waitingInput":
      return "var(--app-warning)";
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
    switch (status) {
      case "active":
        return t("running");
      case "waitingInput":
        return t("waiting");
      case "idle":
        return t("idle");
      default:
        return t("idle");
    }
  };

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
          className="flex flex-col items-center justify-center py-8 rounded-xl"
          style={{
            background: "var(--app-glass-bg)",
            border: "1px solid var(--app-border)",
          }}
        >
          <Terminal
            className="w-7 h-7 mb-2"
            style={{ color: "var(--app-text-tertiary)" }}
          />
          <p
            className="text-xs"
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
        className="rounded-xl overflow-hidden divide-y"
        style={{
          background: "var(--app-glass-bg)",
          border: "1px solid var(--app-border)",
          "--tw-divide-opacity": "1",
          borderColor: "var(--app-border)",
        } as React.CSSProperties}
      >
        {activeTabs.slice(0, 5).map((tab) => {
          const status = statusMap.get(tab.sessionId!)?.status ?? null;
          return (
            <div
              key={tab.id}
              className="home-session-item flex items-center gap-2 px-3 py-2.5 transition-colors duration-150"
              style={{ borderColor: "var(--app-border)" }}
            >
              <Circle
                className={`w-2.5 h-2.5 shrink-0 ${status === "active" ? "animate-pulse" : ""}`}
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
            </div>
          );
        })}
        <div
          className="px-3 py-2 text-xs"
          style={{
            color: "var(--app-text-tertiary)",
            background: "var(--app-glass-bg-light, var(--app-glass-bg))",
            borderColor: "var(--app-border)",
          }}
        >
          {t("totalSessions", { count: activeTabs.length })}
        </div>
      </div>
    </div>
  );
}
