import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  RefreshCw,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import StatusIndicator from "@/components/StatusIndicator";
import { Button } from "@/components/ui/button";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { systemStatsService } from "@/services/systemStatsService";
import { terminalService } from "@/services/terminalService";
import { usePanesStore, useTerminalStatusStore } from "@/stores";
import type {
  CliTool,
  ResourceTree,
  SessionResourceUsage,
  SystemStats,
  Tab,
  TerminalPaneLeaf,
  TerminalPaneNode,
  TerminalStatusType,
} from "@/types";
import { formatSize, handleErrorSilent } from "@/utils";

const POLL_INTERVAL_MS = 3_000;
const GIB = 1024 ** 3;

interface SessionView extends SessionResourceUsage {
  title: string;
  workspaceName: string;
  cliTool: CliTool;
  status: TerminalStatusType | null;
  toolName: string | null;
}

interface WorkspaceGroup {
  name: string;
  sessions: SessionView[];
  cpuPercent: number;
  memoryBytes: number;
}

function formatGib(bytes: number): string {
  const value = Math.round((bytes / GIB) * 10) / 10;
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
}

function formatCpu(cpuPercent: number): string {
  return `${Math.round(cpuPercent * 10) / 10}%`;
}

function findSessionLeaf(node: TerminalPaneNode | undefined, sessionId: string): TerminalPaneLeaf | null {
  if (!node) return null;
  if (node.type === "leaf") return node.sessionId === sessionId ? node : null;
  for (const child of node.children) {
    const found = findSessionLeaf(child, sessionId);
    if (found) return found;
  }
  return null;
}

function sessionMetadata(tab: Tab, sessionId: string) {
  const leaf = findSessionLeaf(tab.terminalRootPane, sessionId);
  return {
    workspaceName: leaf?.workspaceName ?? tab.workspaceName,
    cliTool: leaf?.cliTool ?? tab.cliTool ?? "none",
  };
}

function useSystemStats(): SystemStats | null {
  const [stats, setStats] = useState<SystemStats | null>(null);

  useEffect(() => {
    let disposed = false;
    let refreshing = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const refresh = async () => {
      if (disposed || refreshing || document.hidden) return;
      refreshing = true;
      try {
        const next = await systemStatsService.get();
        if (!disposed && next) setStats(next);
      } catch (error) {
        handleErrorSilent(error, "get system stats");
      } finally {
        refreshing = false;
      }
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const start = () => {
      if (timer !== null || document.hidden) return;
      void refresh();
      timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    };
    const onVisibilityChange = () => {
      if (document.hidden) stop();
      else start();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    start();
    return () => {
      disposed = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return stats;
}

export default function SystemResourceSegment() {
  const { t } = useTranslation("common");
  const stats = useSystemStats();
  const statusMap = useTerminalStatusStore((state) => state.statusMap);
  const [open, setOpen] = useState(false);
  const [tree, setTree] = useState<ResourceTree | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [orphansExpanded, setOrphansExpanded] = useState(false);
  const [armedSessionId, setArmedSessionId] = useState<string | null>(null);
  const [killingSessionId, setKillingSessionId] = useState<string | null>(null);
  const [orphanKillArmed, setOrphanKillArmed] = useState(false);
  const [killingOrphans, setKillingOrphans] = useState(false);
  const refreshingRef = useRef(false);

  const refreshResourceTree = useCallback(async () => {
    if (!open || document.hidden || refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      const next = await systemStatsService.getResourceTree();
      if (next) setTree(next);
    } catch (error) {
      handleErrorSilent(error, "get resource tree");
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      setArmedSessionId(null);
      setOrphanKillArmed(false);
      return;
    }
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const start = () => {
      if (timer !== null || document.hidden) return;
      void refreshResourceTree();
      timer = setInterval(() => void refreshResourceTree(), POLL_INTERVAL_MS);
    };
    const onVisibilityChange = () => {
      if (document.hidden) stop();
      else start();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    start();
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [open, refreshResourceTree]);

  const groups = useMemo<WorkspaceGroup[]>(() => {
    if (!tree) return [];
    const panes = usePanesStore.getState();
    const byWorkspace = new Map<string, SessionView[]>();
    for (const session of tree.sessions) {
      const location = panes.findTabBySessionAcrossLayouts(session.sessionId);
      const metadata = location ? sessionMetadata(location.tab, session.sessionId) : null;
      const workspaceName = metadata?.workspaceName ?? t("resourceManagerOtherWorkspace");
      const status = statusMap.get(session.sessionId);
      const item: SessionView = {
        ...session,
        title: location?.tab.title || `${t("resourceManagerTerminal")} ${session.rootPid}`,
        workspaceName,
        cliTool: metadata?.cliTool ?? "none",
        status: status?.status ?? null,
        toolName: status?.currentToolName ?? null,
      };
      const items = byWorkspace.get(workspaceName) ?? [];
      items.push(item);
      byWorkspace.set(workspaceName, items);
    }

    return [...byWorkspace.entries()]
      .map(([name, sessions]) => ({
        name,
        sessions,
        cpuPercent: sessions.reduce((sum, session) => sum + session.cpuPercent, 0),
        memoryBytes: sessions.reduce((sum, session) => sum + session.memoryBytes, 0),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [statusMap, t, tree]);

  const toggleGroup = (name: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const focusSession = (sessionId: string) => {
    const panes = usePanesStore.getState();
    const location = panes.findTabBySessionAcrossLayouts(sessionId);
    if (!location) return;
    if (location.layoutId !== panes.currentLayoutId) panes.switchLayout(location.layoutId);
    panes.setActivePane(location.panel.id);
    panes.selectTab(location.panel.id, location.tab.id);
    setOpen(false);
  };

  const killSession = async (sessionId: string) => {
    setKillingSessionId(sessionId);
    try {
      await terminalService.killSession(sessionId, "user-close");
      setArmedSessionId(null);
      await refreshResourceTree();
    } catch (error) {
      toast.error(t("resourceManagerKillSessionFailed"));
      handleErrorSilent(error, "kill managed session");
    } finally {
      setKillingSessionId(null);
    }
  };

  const killOrphans = async () => {
    if (!tree || tree.orphans.length === 0) return;
    setKillingOrphans(true);
    try {
      const results = await systemStatsService.killOrphans(tree.orphans.map((orphan) => orphan.pid));
      const failed = results.filter((result) => !result.success).length;
      if (failed > 0) toast.error(t("resourceManagerKillOrphansPartial", { count: failed }));
      else toast.success(t("resourceManagerKillOrphansSuccess", { count: results.length }));
      setOrphanKillArmed(false);
      await refreshResourceTree();
    } catch (error) {
      toast.error(t("resourceManagerKillOrphansFailed"));
      handleErrorSilent(error, "kill orphan processes");
    } finally {
      setKillingOrphans(false);
    }
  };

  if (!stats) return null;
  const cpuPercent = Math.round(stats.cpuPercent);
  const memoryPercent = stats.memTotal > 0 ? (stats.memUsed / stats.memTotal) * 100 : 0;
  const cpuWarning = stats.cpuPercent > 85;
  const memoryWarning = memoryPercent > 90;
  const headerStats = tree?.system ?? stats;
  const orphanCount = tree?.orphans.length ?? 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="system-resource-segment"
          aria-label={t("resourceManagerOpen")}
          className="flex h-full w-[150px] shrink-0 items-center justify-end whitespace-nowrap px-1.5 tabular-nums transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-accent)]"
        >
          <span>{t("cpuShort")} </span>
          <span style={cpuWarning ? { color: "var(--app-status-warning)" } : undefined}>
            {cpuPercent}%
          </span>
          <span> · {t("memoryShort")} </span>
          <span style={memoryWarning ? { color: "var(--app-status-warning)" } : undefined}>
            {formatGib(stats.memUsed)}/{formatGib(stats.memTotal)}G
          </span>
        </button>
      </PopoverTrigger>

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
            onClick={() => void refreshResourceTree()}
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
                    onClick={() => toggleGroup(group.name)}
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
                          aria-label={`${t("resourceManagerFocusSession")}: ${session.title}`}
                          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-[var(--app-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-accent)]"
                          onClick={() => focusSession(session.sessionId)}
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
                            onClick={() => void killSession(session.sessionId)}
                          >
                            {t("resourceManagerConfirmEnd")}
                          </Button>
                        ) : (
                          <IconTooltipButton
                            label={t("resourceManagerEndSessionNamed", { name: session.title })}
                            className="h-6 w-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-[var(--app-status-danger-bg)] hover:text-[var(--app-status-danger)]"
                            onClick={() => setArmedSessionId(session.sessionId)}
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
                onClick={() => setOrphansExpanded((value) => !value)}
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
                  onClick={() => void killOrphans()}
                >
                  {t("resourceManagerConfirmTerminateOrphans", { count: orphanCount })}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[11px] text-[var(--app-status-danger)]"
                  onClick={() => {
                    setOrphansExpanded(true);
                    setOrphanKillArmed(true);
                  }}
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
    </Popover>
  );
}
