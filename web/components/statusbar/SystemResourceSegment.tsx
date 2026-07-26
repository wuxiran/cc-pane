import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { sessionRestoreService } from "@/services/sessionRestoreService";
import { systemStatsService } from "@/services/systemStatsService";
import { terminalService } from "@/services/terminalService";
import { usePanesStore, useTerminalStatusStore } from "@/stores";
import type {
  CliTool,
  ResourceTree,
  SavedSession,
  SshConnectionInfo,
  WslLaunchInfo,
  SystemStats,
  Tab,
  TerminalPaneLeaf,
  TerminalPaneNode,
} from "@/types";
import { handleErrorSilent } from "@/utils";
import {
  SystemResourcePopover,
  type SessionView,
  type WorkspaceGroup,
} from "./SystemResourcePopover";

const POLL_INTERVAL_MS = 3_000;
const GIB = 1024 ** 3;

/**
 * 判断一条待接管会话的运行时指纹是否足以在日后重建。
 * 接管本身只是 reattach 到已存在的 PTY，与运行时无关；但接管后的 tab 一旦被重建，
 * 缺指纹就会在本地错误目录启动。所以指纹不全一律拒绝，不做静默降级。
 *
 * 老记录（migration 26 之前保存的）没有 wslConfig，会走到拒绝分支——这是有意的，
 * 下一次周期保存就会把指纹补上。
 */
export function resolveAdoptRuntime(
  saved: SavedSession | undefined,
): { ok: true; ssh?: SshConnectionInfo; wsl?: WslLaunchInfo } | { ok: false; kind: string } {
  const kind = saved?.runtimeKind ?? "local";
  if (kind === "local") return { ok: true };
  if (kind === "wsl") {
    if (!saved?.wslConfig) return { ok: false, kind };
    try {
      const wsl = JSON.parse(saved.wslConfig) as WslLaunchInfo;
      // remotePath 是重建时的 cwd，缺它等于没有指纹
      return wsl?.remotePath ? { ok: true, wsl } : { ok: false, kind };
    } catch {
      return { ok: false, kind };
    }
  }
  if (kind === "ssh") {
    if (!saved?.sshConfig) return { ok: false, kind };
    try {
      const ssh = JSON.parse(saved.sshConfig) as SshConnectionInfo;
      return ssh?.host ? { ok: true, ssh } : { ok: false, kind };
    } catch {
      return { ok: false, kind };
    }
  }
  return { ok: false, kind };
}

function formatGib(bytes: number): string {
  const value = Math.round((bytes / GIB) * 10) / 10;
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
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
  // 无主会话（本实例没有 tab 引用）的归属元数据，来自跨实例共享的 session_restore 表。
  // 没有它，这些会话只能显示成「终端 <pid>」/「其他工作区」，也无法被接管到正确的项目下。
  const [savedSessions, setSavedSessions] = useState<Map<string, SavedSession>>(new Map());
  const [sessionClaims, setSessionClaims] = useState<Record<string, string>>({});
  const [claimOwnerInstanceId, setClaimOwnerInstanceId] = useState<string | undefined>();
  const [claimsSupported, setClaimsSupported] = useState(false);
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

  // 只在面板打开时拉一次：这张表变动很慢（60s 自动保存），没必要跟着 3s 轮询走。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    Promise.all([sessionRestoreService.load(), terminalService.getAdoptionSnapshot()])
      .then(([sessions, snapshot]) => {
        if (cancelled) return;
        if (Array.isArray(sessions)) {
          setSavedSessions(new Map(sessions.map((session) => [session.sessionId, session])));
        }
        setSessionClaims(snapshot.claims);
        setClaimOwnerInstanceId(snapshot.ownerInstanceId);
        setClaimsSupported(snapshot.claimsSupported && snapshot.complete);
      })
      .catch((error) => {
        if (!cancelled) {
          setSessionClaims({});
          setClaimOwnerInstanceId(undefined);
          setClaimsSupported(false);
        }
        handleErrorSilent(error, "load adoption snapshot");
      });
    return () => {
      cancelled = true;
    };
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
      // 本实例没引用时回退到 session_restore 的归属记录，而不是直接判成「其他工作区」
      const saved = location ? undefined : savedSessions.get(session.sessionId);
      const workspaceName =
        metadata?.workspaceName ?? saved?.workspaceName ?? t("resourceManagerOtherWorkspace");
      const status = statusMap.get(session.sessionId);
      const claimOwner = sessionClaims[session.sessionId];
      const claimBlocked = Boolean(
        !location
        && (!claimsSupported || (claimOwner && claimOwner !== claimOwnerInstanceId)),
      );
      const item: SessionView = {
        ...session,
        title:
          location?.tab.title
          || saved?.customTitle
          || `${t("resourceManagerTerminal")} ${session.rootPid}`,
        workspaceName,
        adoptable: !location && !claimBlocked,
        claimBlocked,
        cliTool: metadata?.cliTool ?? saved?.cliTool ?? "none",
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
  }, [claimOwnerInstanceId, claimsSupported, savedSessions, sessionClaims, statusMap, t, tree]);

  const toggleGroup = (name: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const focusSession = async (sessionId: string) => {
    const panes = usePanesStore.getState();
    const location = panes.findTabBySessionAcrossLayouts(sessionId);
    if (!location) {
      const claimOwner = sessionClaims[sessionId];
      if (!claimsSupported || (claimOwner && claimOwner !== claimOwnerInstanceId)) {
        toast.error(t("resourceManagerAdoptClaimed"));
        return;
      }
      // 无主会话：先接管成当前布局的一个 tab（复用 restore 的 reattach，不新建 PTY），再聚焦。
      const saved = savedSessions.get(sessionId);
      const runtime = resolveAdoptRuntime(saved);
      if (!runtime.ok) {
        // 指纹不完整就拒绝：接管本身安全（只是 reattach），但这个 tab 之后被重建时
        // 会在本地错误目录重启。宁可不接管，也不要让 agent 在错误的仓库里干活。
        toast.error(t("resourceManagerAdoptIncompleteRuntime", { runtime: runtime.kind }));
        return;
      }
      let granted = false;
      try {
        granted = await terminalService.adoptSession(sessionId);
      } catch (error) {
        handleErrorSilent(error, "claim session for manual adoption");
      }
      if (!granted) {
        toast.error(t("resourceManagerAdoptClaimed"));
        return;
      }

      const adoptedTabId = panes.adoptSession(sessionId, {
        projectPath: saved?.projectPath ?? "",
        workspaceName: saved?.workspaceName,
        workspacePath: saved?.workspacePath,
        workspaceSnapshotId: saved?.workspaceSnapshotId,
        providerId: saved?.providerId,
        providerSelection: saved?.providerSelection,
        launchProfileId: saved?.launchProfileId,
        cliTool: saved?.cliTool as CliTool | undefined,
        resumeId: saved?.resumeId,
        customTitle: saved?.customTitle,
        ssh: runtime.ssh,
        wsl: runtime.wsl,
      });
      if (!adoptedTabId) {
        await terminalService.releaseSession(sessionId).catch((error) => {
          handleErrorSilent(error, "release failed manual adoption");
        });
        toast.error(t("resourceManagerAdoptFailed"));
        return;
      }
      panes.setSessionLeaseReadOnly(sessionId, false);
      // adoptSession 已把新 tab 落在当前布局并设为活动 tab；此时 leaf 上是
      // savedSessionId（等 TerminalView reattach 后才变 sessionId），按 id 反查不到，
      // 直接收起面板即可。
      setOpen(false);
      return;
    }
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

      <SystemResourcePopover
        headerStats={headerStats}
        tree={tree}
        groups={groups}
        collapsedGroups={collapsedGroups}
        refreshing={refreshing}
        armedSessionId={armedSessionId}
        killingSessionId={killingSessionId}
        orphansExpanded={orphansExpanded}
        orphanKillArmed={orphanKillArmed}
        killingOrphans={killingOrphans}
        onRefresh={() => void refreshResourceTree()}
        onToggleGroup={toggleGroup}
        onFocusSession={(sessionId) => void focusSession(sessionId)}
        onArmSession={setArmedSessionId}
        onKillSession={(sessionId) => void killSession(sessionId)}
        onToggleOrphans={() => setOrphansExpanded((value) => !value)}
        onArmOrphanKill={() => {
          setOrphansExpanded(true);
          setOrphanKillArmed(true);
        }}
        onKillOrphans={() => void killOrphans()}
      />
    </Popover>
  );
}
