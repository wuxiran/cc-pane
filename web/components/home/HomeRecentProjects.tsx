import { useTranslation } from "react-i18next";
import { FolderOpen, Play, RotateCcw, ChevronRight, Clock } from "lucide-react";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { useSshMachinesStore, useWorkspacesStore } from "@/stores";
import type { LaunchRecord } from "@/services";
import type { OpenTerminalOptions } from "@/types";
import { buildLaunchRecordTerminalOptions } from "@/utils";
import { Button } from "@/components/ui/button";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { openHomeCreateWorkspace } from "./homeSetupDialogStore";

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

  const header = (
    <div className="mb-2 flex items-center justify-between px-2">
      <h3 className="text-[length:var(--text-small)] font-medium text-[var(--app-text-secondary)]">{t("recentProjects")}</h3>
      {uniqueRecords.length > 0 && (
        <button
          type="button"
          className="flex items-center gap-0.5 text-[length:var(--text-small)] text-[var(--app-accent)] hover:underline"
          onClick={() => {
            setAppViewMode("panes");
            toggleView("sessions");
          }}
        >
          {t("viewAll")}
          <ChevronRight className="size-3" aria-hidden="true" />
        </button>
      )}
    </div>
  );

  if (uniqueRecords.length === 0) {
    return (
      <div className="min-w-0">
        {header}
        <div className="flex flex-col items-center justify-center gap-1 px-4 py-8 text-center">
          <FolderOpen className="mb-1 size-6 text-[var(--app-text-tertiary)]" aria-hidden="true" />
          <p className="text-[length:var(--text-body)] text-[var(--app-text-secondary)]">{t("noRecentProjects")}</p>
          <Button
            type="button"
            size="sm"
            className="mt-3"
            onClick={openHomeCreateWorkspace}
          >
            {t("createFirstWorkspace")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-w-0">
      {header}
      <ul>
        {uniqueRecords.map((record) => (
          <li
            key={record.id}
            className="home-project-card group flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-home-surface-hover)]"
          >
            <FolderOpen className="size-4 shrink-0 text-[var(--app-accent)]" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-[length:var(--text-body)] text-[var(--app-text-primary)]">
              {record.projectName}
            </span>
            <span className="flex shrink-0 items-center gap-1 text-[length:var(--text-small)] text-[var(--app-text-tertiary)]">
              <Clock className="size-3" aria-hidden="true" />
              {formatRelativeTime(record.launchedAt)}
            </span>
            <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-[var(--dur-fast)] focus-within:opacity-100 group-hover:opacity-100">
              <IconTooltipButton
                label={t("open")}
                className="size-7"
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
                <Play className="size-3.5" aria-hidden="true" />
              </IconTooltipButton>
              {record.resumeSessionId && (
                <IconTooltipButton
                  label={t("resume")}
                  className="size-7 text-[var(--app-accent)]"
                  onClick={() => openRecentProject(buildLaunchRecordTerminalOptions(record, workspaces, machines))}
                >
                  <RotateCcw className="size-3.5" aria-hidden="true" />
                </IconTooltipButton>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
