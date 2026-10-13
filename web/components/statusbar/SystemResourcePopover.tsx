import { ChevronDown, ChevronRight, RefreshCw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePanelResize } from "@/hooks/usePanelResize";
import { usePanelPreferencesStore, type ResourceSortMode } from "@/stores/usePanelPreferencesStore";
import { sortResourceGroups } from "./resourceSorting";
import { HeavyCommandsTab } from "./HeavyCommandsTab";
import { SystemResourceSessionRow } from "./SystemResourceSessionRow";
import { TopProcessesBlock } from "./TopProcessesBlock";
import { useResourcePopoverStore } from "@/stores/useResourcePopoverStore";

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
  /** 已展开进程构成的会话。 */
  expandedSessionIds: Set<string>;
  onRefresh: () => void;
  onToggleGroup: (name: string) => void;
  onToggleSessionProcesses: (sessionId: string) => void;
  onFocusSession: (sessionId: string) => void;
  onArmSession: (sessionId: string) => void;
  onKillSession: (sessionId: string) => void;
  onToggleOrphans: () => void;
  onArmOrphanKill: () => void;
  onKillOrphans: () => void;
}

/** 弹层标签：进程视图（原有）/ 最贵命令（台账聚合，只在打开时拉取）。 */
export type ResourcePopoverTab = "processes" | "commands";

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
  expandedSessionIds,
  onRefresh,
  onToggleGroup,
  onToggleSessionProcesses,
  onFocusSession,
  onArmSession,
  onKillSession,
  onToggleOrphans,
  onArmOrphanKill,
  onKillOrphans,
}: SystemResourcePopoverProps) {
  const { t } = useTranslation("common");
  const orphanCount = tree?.orphans.length ?? 0;
  const panelRef = useRef<HTMLDivElement>(null);
  const width = usePanelPreferencesStore(s => s.resourceWidth);
  const setWidth = usePanelPreferencesStore(s => s.setResourceWidth);
  const sort = usePanelPreferencesStore(s => s.resourceSort);
  const setSort = usePanelPreferencesStore(s => s.setResourceSort);
  const resize = usePanelResize({ element: panelRef, width, min: 430, max: 960, direction: -1, onCommit: setWidth });
  const displayGroups = useMemo(() => sortResourceGroups(groups, sort, t("resourceTopUsage")), [groups, sort, t]);
  const [tab, setTab] = useState<ResourcePopoverTab>("processes");
  // 从标签琥珀点进来：高亮那一行；再打开时不残留
  const highlightSessionId = useResourcePopoverStore(s => s.highlightSessionId);
  useEffect(() => () => useResourcePopoverStore.getState().clearHighlight(), []);

  return (
    <PopoverContent ref={panelRef} side="top" align="end" sideOffset={6} className="relative p-0" style={{ width, maxWidth: "calc(100vw - 16px)" }}>
      <div role="separator" aria-label={t("resourceResize")} aria-orientation="vertical" tabIndex={0}
        aria-valuemin={430} aria-valuemax={960} aria-valuenow={width}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-[var(--app-active-bg)]"
        onPointerDown={resize} onKeyDown={e => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); setWidth(width + (e.key === "ArrowLeft" ? 10 : -10)); } }} />
      <div className="flex min-h-10 flex-wrap items-center gap-3 border-b border-[var(--app-border)] px-3 py-1">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--app-text-primary)]">
          {t("resourceManagerTitle")}
        </h2>
        <div className="flex shrink-0 items-center gap-2 text-xs tabular-nums text-[var(--app-text-secondary)]">
          <span>{t("cpuShort")} {formatCpu(headerStats.cpuPercent)}</span>
          <span>{t("memoryShort")} {formatGib(headerStats.memUsed)}/{formatGib(headerStats.memTotal)}G</span>
          <span title={t("resourceAppMemoryScope")}>{t("resourceManagerAppMemory")} {formatSize(tree?.appMemoryBytes ?? 0)} ({formatCpu(tree?.appMemoryPercent ?? 0)})</span>
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

      <div className="flex items-center gap-1 border-b border-[var(--app-border)] px-3 py-1">
        <div role="tablist" aria-label={t("resourceTabs")} className="flex flex-1 items-center gap-1">
          {(["processes", "commands"] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`rounded px-2 py-1 text-xs ${tab === id ? "bg-[var(--app-active-bg)] text-[var(--app-text-primary)]" : "text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)]"}`}
              onClick={() => setTab(id)}
            >
              {t(id === "processes" ? "resourceTabProcesses" : "resourceTabCommands")}
            </button>
          ))}
        </div>
        {tab === "processes" && (
          <select aria-label={t("resourceSort")} value={sort} onChange={e => setSort(e.target.value as ResourceSortMode)} className="rounded bg-[var(--app-panel-bg)] px-2 py-1 text-xs">
            <option value="group">{t("resourceSortGroup")}</option><option value="cpu">{t("resourceSortCpu")}</option><option value="memory">{t("resourceSortMemory")}</option>
          </select>
        )}
      </div>

      {tab === "commands" ? (
        <div className="max-h-[430px] overflow-y-auto">
          <HeavyCommandsTab active />
        </div>
      ) : (
      <div className="max-h-[430px] overflow-y-auto p-2">
        <div className="mb-1 px-1 text-[11px] font-semibold text-[var(--app-text-tertiary)]">
          {t("resourceManagerManagedSessions")}
        </div>
        {groups.length === 0 ? (
          <div className="px-2 py-5 text-center text-xs text-[var(--app-text-tertiary)]">
            {t("resourceManagerNoManagedSessions")}
          </div>
        ) : (
          displayGroups.map((group) => {
            const collapsed = collapsedGroups.has(group.name);
            return (
              <div key={group.name} className="mb-1">
                <button
                  type="button"
                  aria-expanded={!collapsed}
                  className="flex h-7 w-full items-center gap-1 rounded px-1 text-left text-xs font-medium text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)]"
                  onClick={() => onToggleGroup(group.name)}
                >
                  {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
                  <span title={group.name} className="min-w-0 flex-1 truncate">{group.name}</span>
                  <span className="shrink-0 tabular-nums text-[11px] text-[var(--app-text-tertiary)]">
                    {formatCpu(group.cpuPercent)} · {formatSize(group.memoryBytes)}
                  </span>
                </button>
                {!collapsed && group.sessions.map((session) => (
                  <SystemResourceSessionRow
                    key={session.sessionId}
                    session={session}
                    armed={armedSessionId === session.sessionId}
                    killing={killingSessionId === session.sessionId}
                    expanded={expandedSessionIds.has(session.sessionId)}
                    highlighted={highlightSessionId === session.sessionId}
                    onToggleProcesses={onToggleSessionProcesses}
                    onFocus={onFocusSession}
                    onArm={onArmSession}
                    onKill={onKillSession}
                  />
                ))}
              </div>
            );
          })
        )}

        {/* 会话之外：整机高负载但受管会话都不重时，元凶在外面。只读。 */}
        <TopProcessesBlock topProcesses={tree?.topProcesses} />

        <div className="mt-2 border-t border-[var(--app-border)] pt-2">
          <div className="flex min-h-8 items-center gap-1 px-1">
            <button
              type="button"
              aria-expanded={orphansExpanded}
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
      )}
    </PopoverContent>
  );
}
