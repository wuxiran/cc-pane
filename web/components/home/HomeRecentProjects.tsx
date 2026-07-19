import { useTranslation } from "react-i18next";
import { FolderOpen, Play, RotateCcw, ChevronRight, Clock } from "lucide-react";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { useSshMachinesStore, useWorkspacesStore } from "@/stores";
import type { LaunchRecord } from "@/services";
import type { OpenTerminalOptions } from "@/types";
import { buildLaunchRecordTerminalOptions } from "@/utils";

interface HomeRecentProjectsProps {
  records: LaunchRecord[];
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
}

function useFormatRelativeTime() {
  const { t } = useTranslation("home");

  return (dateStr: string): string => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffHour = Math.floor(diffMs / 3600000);
    const diffDay = Math.floor(diffMs / 86400000);

    if (diffMin < 1) return t("justNow");
    if (diffMin < 60) return t("minutesAgo", { count: diffMin });
    if (diffHour < 24) return t("hoursAgo", { count: diffHour });
    if (diffDay < 30) return t("daysAgo", { count: diffDay });
    return date.toLocaleDateString();
  };
}

/** 去重：同一 projectPath 只保留最近一条 */
function deduplicateRecords(records: LaunchRecord[]): LaunchRecord[] {
  const seen = new Set<string>();
  return records.filter((r) => {
    if (seen.has(r.projectPath)) return false;
    seen.add(r.projectPath);
    return true;
  });
}

export default function HomeRecentProjects({ records, onOpenTerminal }: HomeRecentProjectsProps) {
  const { t } = useTranslation("home");
  const toggleView = useActivityBarStore((s) => s.toggleView);
  const setAppViewMode = useActivityBarStore((s) => s.setAppViewMode);
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const machines = useSshMachinesStore((state) => state.machines);
  const formatRelativeTime = useFormatRelativeTime();

  const openRecentProject = (opts: OpenTerminalOptions) => {
    setAppViewMode("panes");
    onOpenTerminal(opts);
  };

  const uniqueRecords = deduplicateRecords(records).slice(0, 8);

  if (uniqueRecords.length === 0) {
    return (
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2
            className="text-base font-semibold"
            style={{ color: "var(--app-text-primary)" }}
          >
            {t("recentProjects")}
          </h2>
        </div>
        <div
          className="relative flex flex-col items-center justify-center py-10 rounded-2xl overflow-hidden border border-[var(--app-home-border)] bg-[var(--app-home-surface)]"
        >
          {/* 点阵纹理装饰 */}
          <div
            className="absolute inset-0 opacity-[0.03]"
            style={{
              backgroundImage: "radial-gradient(circle, var(--app-text-primary) 1px, transparent 1px)",
              backgroundSize: "16px 16px",
            }}
          />
          <FolderOpen
            className="w-10 h-10 mb-3 relative"
            style={{ color: "var(--app-text-tertiary)" }}
          />
          <p
            className="text-sm mb-4 relative"
            style={{ color: "var(--app-text-tertiary)" }}
          >
            {t("noRecentProjects")}
          </p>
          <button
            className="relative px-5 py-2 rounded-lg text-sm font-medium cursor-pointer transition-all duration-[var(--dur-fast)] hover:opacity-90 hover:-translate-y-[0.5px]"
            style={{
              background: "var(--app-accent)",
              color: "var(--primary-foreground)",
              boxShadow: "0 2px 8px color-mix(in srgb, var(--app-accent) 25%, transparent)",
            }}
            onClick={() => {
              setAppViewMode("panes");
              toggleView("explorer");
            }}
          >
            {t("createFirstWorkspace")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2
          className="text-base font-semibold"
          style={{ color: "var(--app-text-primary)" }}
        >
          {t("recentProjects")}
        </h2>
        <button
          className="flex items-center gap-1 text-xs cursor-pointer transition-colors duration-[var(--dur-fast)] hover:underline"
          style={{ color: "var(--app-accent)" }}
          onClick={() => {
            setAppViewMode("panes");
            toggleView("sessions");
          }}
        >
          {t("viewAll")}
          <ChevronRight className="w-3 h-3" />
        </button>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-2">
        {uniqueRecords.map((record) => (
          <div
            key={record.id}
            className="home-project-card flex items-center gap-3.5 p-3 rounded-xl border border-[var(--app-home-border)] bg-[var(--app-home-surface)] transition-all duration-[var(--dur-fast)] group hover:-translate-y-[0.5px] hover:bg-[var(--app-home-surface-hover)] hover:shadow-[var(--sh-md)] hover:border-[var(--app-home-border-hover)]"
          >
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
              style={{
                background: "color-mix(in srgb, var(--app-accent) 10%, transparent)",
              }}
            >
              <FolderOpen
                className="w-[18px] h-[18px]"
                style={{ color: "var(--app-accent)" }}
              />
            </div>
            <div className="flex-1 min-w-0">
              <p
                className="text-sm font-medium truncate"
                style={{ color: "var(--app-text-primary)" }}
              >
                {record.projectName}
              </p>
              <div className="flex items-center gap-1">
                <Clock
                  className="w-3 h-3 shrink-0"
                  style={{ color: "var(--app-text-tertiary)" }}
                />
                <p
                  className="text-xs truncate"
                  style={{ color: "var(--app-text-tertiary)" }}
                >
                  {formatRelativeTime(record.launchedAt)}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all duration-[var(--dur-fast)] translate-x-1 group-hover:translate-x-0 shrink-0">
              <button
                className="p-1.5 rounded-md cursor-pointer transition-colors text-[var(--app-text-secondary)] hover:bg-[var(--app-accent)] hover:text-[var(--primary-foreground)]"
                title={t("open")}
                onClick={() =>
                  openRecentProject({
                    path: record.projectPath,
                    workspaceName: record.workspaceName,
                    providerId: record.providerId,
                    providerSelection: record.providerSelection,
                    workspacePath: record.workspacePath,
                  })
                }
              >
                <Play className="w-3.5 h-3.5" />
              </button>
              {record.resumeSessionId && (
                <button
                  className="p-1.5 rounded-md cursor-pointer transition-colors text-[var(--app-accent)] hover:bg-[var(--app-accent)] hover:text-[var(--primary-foreground)]"
                  title={t("resume")}
                  onClick={() =>
                    openRecentProject(buildLaunchRecordTerminalOptions(record, workspaces, machines))
                  }
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
