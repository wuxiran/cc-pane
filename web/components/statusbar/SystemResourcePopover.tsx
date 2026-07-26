import { ChevronDown, ChevronRight, RefreshCw, SquareTerminal, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import StatusIndicator from "@/components/StatusIndicator";
import { Button } from "@/components/ui/button";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { PopoverContent } from "@/components/ui/popover";
import type {
  CliTool,
  ResourceTree,
  SessionResourceUsage,
  SystemStats,
  TerminalStatusType,
} from "@/types";
import { formatSize } from "@/utils";

export interface SessionView extends SessionResourceUsage {
  title: string;
  workspaceName: string;
  adoptable: boolean;
  claimBlocked: boolean;
  cliTool: CliTool;
  status: TerminalStatusType | null;
  toolName: string | null;
}

export interface WorkspaceGroup {
  name: string;
  sessions: SessionView[];
  cpuPercent: number;
  memoryBytes: number;
}

interface SystemResourcePopoverProps {
  headerStats: SystemStats;
  tree: ResourceTree | null;
  groups: WorkspaceGroup[];
  collapsedGroups: Set<string>;
  refreshing: boolean;
  armedSessionId: string | null;
  killingSessionId: string | null;
  orphansExpanded: boolean;
  orphanKillArmed: boolean;
  killingOrphans: boolean;
  onRefresh: () => void;
  onToggleGroup: (name: string) => void;
  onFocusSession: (sessionId: string) => void;
  onArmSession: (sessionId: string) => void;
  onKillSession: (sessionId: string) => void;
  onToggleOrphans: () => void;
  onArmOrphanKill: () => void;
  onKillOrphans: () => void;
}

function formatGib(bytes: number): string {
  const value = Math.round((bytes / 1024 ** 3) * 10) / 10;
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
}

function formatCpu(cpuPercent: number): string {
  return `${Math.round(cpuPercent * 10) / 10}%`;
}

export function SystemResourcePopover({
  headerStats,
  tree,
  groups,
  collapsedGroups,
  refreshing,
  armedSessionId,
  killingSessionId,
  orphansExpanded,
  orphanKillArmed,
  killingOrphans,
  onRefresh,
  onToggleGroup,
  onFocusSession,
  onArmSession,
  onKillSession,
  onToggleOrphans,
  onArmOrphanKill,
  onKillOrphans,
}: SystemResourcePopoverProps) {
  const { t } = useTranslation("common");
  const orphanCount = tree?.orphans.length ?? 0;

  return (
    <PopoverContent side="top" align="end" sideOffset={6} className="w-[430px] p-0">
      <div className="flex h-10 items-center gap-3 border-b border-[var(--app-border)] px-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--app-text-primary)]">
          {t("resourceManagerTitle")}
        </h2>
        <div className="flex shrink-0 items-center gap-2 text-xs tabular-nums text-[var(--app-text-secondary)]">
          <span>{t("cpuShort")} {formatCpu(headerStats.cpuPercent)}</span>
          <span>{t("memoryShort")} {formatGib(headerStats.memUsed)}/{formatGib(headerStats.memTotal)}G</span>
          <span>{t("resourceManagerAppMemory")} {formatCpu(tree?.appMemoryPercent ?? 0)}</span>
        </div>
        <IconTooltipButton
          label={t("resourceManagerRefresh")}
          className="h-7 w-7"
          disabled={refreshing}
          onClick={onRefresh}
        >
          <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
        </IconTooltipButton>
      </div>

      <div className="max-h-[430px] overflow-y-auto p-2">
        <div className="mb-1 px-1 text-[11px] font-semibold text-[var(--app-text-tertiary)]">
          {t("resourceManagerManagedSessions")}
        </div>
        {groups.length === 0 ? (
          <div className="px-2 py-5 text-center text-xs text-[var(--app-text-tertiary)]">
            {t("resourceManagerNoManagedSessions")}
          </div>
        ) : (
          groups.map((group) => {
            const collapsed = collapsedGroups.has(group.name);
            return (
              <div key={group.name} className="mb-1">
                <button
                  type="button"
                  className="flex h-7 w-full items-center gap-1 rounded px-1 text-left text-xs font-medium text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)]"
                  onClick={() => onToggleGroup(group.name)}
                >
                  {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
                  <span className="min-w-0 flex-1 truncate">{group.name}</span>
                  <span className="shrink-0 tabular-nums text-[11px] text-[var(--app-text-tertiary)]">
                    {formatCpu(group.cpuPercent)} · {formatSize(group.memoryBytes)}
                  </span>
                </button>
                {!collapsed && group.sessions.map((session) => {
                  const armed = armedSessionId === session.sessionId;
                  const killing = killingSessionId === session.sessionId;
                  return (
                    <div key={session.sessionId} className="group flex h-8 items-center gap-1 pl-5 pr-1">
                      <button
                        type="button"
                        aria-label={`${session.adoptable ? t("resourceManagerAdopt") : t("resourceManagerFocusSession")}: ${session.title}`}
                        title={
                          session.claimBlocked
                            ? t("resourceManagerAdoptClaimed")
                            : session.adoptable
                              ? t("resourceManagerAdopt")
                              : undefined
                        }
                        className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-[var(--app-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-accent)]"
                        disabled={session.claimBlocked}
                        onClick={() => onFocusSession(session.sessionId)}
                      >
                        <StatusIndicator status={session.status} toolName={session.toolName} size={7} />
                        <SquareTerminal className="size-3.5 shrink-0 text-[var(--app-text-tertiary)]" />
                        <span className="shrink-0 text-[10px] uppercase text-[var(--app-text-tertiary)]">
                          {session.cliTool === "none" ? "CLI" : session.cliTool}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-xs text-[var(--app-text-primary)]">
                          {session.title}
                        </span>
                        <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-[var(--app-text-secondary)]">
                          {formatCpu(session.cpuPercent)}
                        </span>
                        <span className="w-[58px] shrink-0 text-right text-[11px] tabular-nums text-[var(--app-text-secondary)]">
                          {formatSize(session.memoryBytes)}
                        </span>
                      </button>
                      {armed ? (
                        <Button
                          size="sm"
                          variant="destructive"
                          className="h-6 px-2 text-[11px]"
                          disabled={killing}
                          onClick={() => onKillSession(session.sessionId)}
                        >
                          {t("resourceManagerConfirmEnd")}
                        </Button>
                      ) : (
                        <IconTooltipButton
                          label={t("resourceManagerEndSessionNamed", { name: session.title })}
                          className="h-6 w-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-[var(--app-status-danger-bg)] hover:text-[var(--app-status-danger)]"
                          onClick={() => onArmSession(session.sessionId)}
                        >
                          <X className="size-3.5" />
                        </IconTooltipButton>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })
        )}

        <div className="mt-2 border-t border-[var(--app-border)] pt-2">
          <div className="flex min-h-8 items-center gap-1 px-1">
            <button
              type="button"
              aria-label={t(orphansExpanded ? "resourceManagerCollapseOrphans" : "resourceManagerExpandOrphans")}
              className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-1 text-left hover:bg-[var(--app-hover)]"
              onClick={onToggleOrphans}
            >
              {orphansExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              <span
                className="text-xs font-medium"
                style={{ color: orphanCount > 0 ? "var(--app-status-warning)" : "var(--app-text-tertiary)" }}
              >
                {t("resourceManagerOrphanCount", { count: orphanCount })}
              </span>
            </button>
            {orphanCount > 0 && (orphanKillArmed ? (
              <Button
                size="sm"
                variant="destructive"
                className="h-7 px-2 text-[11px]"
                disabled={killingOrphans}
                onClick={onKillOrphans}
              >
                {t("resourceManagerConfirmTerminateOrphans", { count: orphanCount })}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[11px] text-[var(--app-status-danger)]"
                onClick={onArmOrphanKill}
              >
                <Trash2 className="size-3" />
                {t("resourceManagerTerminateOrphans", { count: orphanCount })}
              </Button>
            ))}
          </div>
          {orphansExpanded && tree?.orphans.map((orphan) => (
            <div key={orphan.pid} className="flex min-h-7 items-center gap-2 pl-6 pr-2 text-xs">
              <span className="min-w-0 flex-1 truncate text-[var(--app-text-secondary)]" title={orphan.command}>
                {orphan.name}
              </span>
              <span className="shrink-0 tabular-nums text-[11px] text-[var(--app-text-tertiary)]">
                PID {orphan.pid} · {formatCpu(orphan.cpuPercent)} · {formatSize(orphan.memoryBytes)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </PopoverContent>
  );
}
