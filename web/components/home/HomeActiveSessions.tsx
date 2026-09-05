import { useCallback, useMemo } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Terminal, Circle } from "lucide-react";
import { focusTab } from "@/hooks/useFocusTab";
import { statusColorToken } from "@/lib/statusPresentation";
import { useDialogStore, usePanesStore, useTerminalStatusStore } from "@/stores";
import { asTabId } from "@/types/ids";
import { isBusyStatus, type PaneNode, type Tab, type TerminalStatusType } from "@/types";
import { EmptyState } from "@/components/ui/EmptyState";

function getAllTabs(pane: PaneNode): Tab[] {
  if (pane.type === "panel") return pane.tabs;
  return pane.children.flatMap(getAllTabs);
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

  // 与首页「快速操作」的“新建终端”同一动作：打开启动器
  const handleNewTerminal = useCallback(() => {
    useDialogStore.getState().openLauncher();
  }, []);

  if (activeTabs.length === 0) {
    return (
      <div>
        <h3
          className="text-sm font-semibold mb-3"
          style={{ color: "var(--app-text-primary)" }}
        >
          {t("activeSessions")}
        </h3>
        {/* 空态去死重：dot-grid 纹理底 + 中大插画 + 引导文案 + 主行动按钮。
            纹理为静态 radial-gradient 点阵，无动画依赖，reduced-motion 下观感一致。 */}
        <div
          className="relative flex min-h-[240px] xl:min-h-[300px] flex-col items-center justify-center overflow-hidden rounded-2xl border border-[var(--app-home-border)] bg-[var(--app-home-surface)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-home-surface-hover)]"
          style={{
            backgroundImage:
              "radial-gradient(color-mix(in srgb, var(--app-text-tertiary) 16%, transparent) 1px, transparent 1.5px)",
            backgroundSize: "20px 20px",
          }}
          data-testid="home-active-sessions-empty"
        >
          <EmptyState
            icon={Terminal}
            illustration="empty-terminal"
            accent="h-24 w-24 xl:h-28 xl:w-28"
            title={t("noActiveSessions")}
            description={t("noActiveSessionsHint")}
            action={{ label: t("newTerminal"), onClick: handleNewTerminal }}
            className="py-8"
          />
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
              onClick={() => focusTab(asTabId(tab.id))}
            >
              <Circle
                className={`w-2.5 h-2.5 shrink-0 ${isBusyStatus(status) ? "animate-pulse" : ""}`}
                fill={statusColorToken(status)}
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
          className="px-3 py-2 text-xs tabular-nums"
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
