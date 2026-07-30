// Terminal-sensitive 会话恢复链路（从 App.tsx 原样搬出，勿在此做行为改动）：
// - runBackgroundLayoutRestore / restoreLiveDaemonSessionsFromBackend：后台补建
//   非当前布局的终端会话，出队时重检避免重复建会话
// - useTerminalResumeIdBridge：桥接后端 history-updated 事件并带退避重试地回写
//   tab 的 agent resumeId
import { useEffect } from "react";
import { usePanesStore, useTerminalStatusStore } from "@/stores";
import { sessionRestoreService, terminalService } from "@/services";
import type {
  SavedSession,
  TerminalAdoptionSnapshot,
  TerminalPaneLeaf,
  TerminalRestoreBlockedReason,
  TerminalSessionProvenance,
} from "@/types";
import { listenIfTauri } from "@/services/runtime";
import { collectTerminalLeaves } from "@/lib/paneSessions";
import { resolveRuntimeKind } from "@/utils/desktopRuntime";
import { projectPathsEquivalent } from "@/utils/projectIdentity";
import { writeTerminalRestoreLog as writeRestoreLog } from "@/stores/useTerminalRestoreLogStore";
export { runBackgroundLayoutRestore } from "./backgroundLayoutRestore";

export async function restoreLiveDaemonSessionsFromBackend(): Promise<number> {
  // 用一次共享刷新预热 useTerminalStatusStore.statusMap：各 TerminalView 的
  // findLiveSavedSessionId 直接读这个缓存，避免每个 tab 各自再发 getAllStatus，
  // 否则重启时几十个 tab 并发打 IPC 会把后端拖住、导致恢复 stall。
  await useTerminalStatusStore.getState().refreshLiveStatuses();
  const statuses = Array.from(useTerminalStatusStore.getState().statusMap.values());
  return usePanesStore.getState().restoreLiveDaemonSessions(statuses);
}

export interface AdoptionReport {
  /** 挂回原锚点的会话数 */
  attached: number;
  /** 活着但本实例无法安全认领的会话数（无记录 / 锚点不在 / 项目不符 / 运行时不符） */
  skipped: number;
  blocked: number;
}

export interface ReconcileTerminalSessionsOptions {
  autoAdopt: boolean;
}

interface RestorableLeaf {
  layoutId: string;
  tabId: string;
  projectPath: string;
  cliTool: string;
  runtimeKind: string;
  resumeId?: string;
  leaf: TerminalPaneLeaf;
}

function restorableLeaves(): RestorableLeaf[] {
  return usePanesStore.getState().getRestorableTabs().flatMap(({ tab, layoutId }) =>
    collectTerminalLeaves(tab.terminalRootPane).map((leaf) => ({
      layoutId,
      tabId: tab.id,
      projectPath: tab.projectPath,
      cliTool: leaf.cliTool ?? tab.cliTool ?? (leaf.launchClaude || tab.launchClaude ? "claude" : "none"),
      runtimeKind: resolveRuntimeKind({ ssh: leaf.ssh ?? tab.ssh, wsl: leaf.wsl ?? tab.wsl }),
      resumeId: leaf.resumeId ?? tab.resumeId,
      leaf,
    })),
  );
}

function setBlocked(leaf: RestorableLeaf, reason: TerminalRestoreBlockedReason): void {
  usePanesStore.getState().setTerminalRestoreBlocked(leaf.tabId, leaf.leaf.id, reason);
}

function blockPendingLeaves(reason: TerminalRestoreBlockedReason): number {
  let blocked = 0;
  for (const leaf of restorableLeaves()) {
    if (leaf.leaf.sessionId || (!leaf.leaf.restoring && !leaf.leaf.savedSessionId)) continue;
    setBlocked(leaf, reason);
    blocked += 1;
  }
  return blocked;
}

function anchorMatches(record: SavedSession, leaf: RestorableLeaf): boolean {
  return Boolean(
    record.layoutId
    && record.terminalPaneId
    && record.layoutId === leaf.layoutId
    && record.tabId === leaf.tabId
    && record.terminalPaneId === leaf.leaf.id
  );
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function identityMatches(
  record: SavedSession,
  provenance: TerminalSessionProvenance,
  leaf: RestorableLeaf,
  snapshot: TerminalAdoptionSnapshot,
): boolean {
  if (
    snapshot.daemonGeneration === undefined
    || record.daemonGeneration !== snapshot.daemonGeneration
    || provenance.daemonGeneration !== snapshot.daemonGeneration
    || !record.birthNonce
    || record.birthNonce !== provenance.birthNonce
    || provenance.sessionId !== record.sessionId
  ) return false;

  // The saved anchor is mutable when a tab moves; daemon provenance is immutable birth data.
  // Both must be complete, but requiring equality would reject legitimate cross-layout moves.
  if (
    !record.layoutId
    || !record.tabId
    || !record.terminalPaneId
    || !nonEmpty(provenance.originLayoutId)
    || !nonEmpty(provenance.originTabId)
    || !nonEmpty(provenance.originTerminalPaneId)
  ) return false;

  if (
    !record.projectPath
    || !provenance.projectPath
    || !leaf.projectPath
    || !projectPathsEquivalent(record.projectPath, provenance.projectPath)
    || !projectPathsEquivalent(record.projectPath, leaf.projectPath)
  ) return false;

  if (
    !record.runtimeKind
    || record.runtimeKind !== provenance.runtimeKind
    || record.runtimeKind !== leaf.runtimeKind
    || record.cliTool !== provenance.cliTool
    || record.cliTool !== leaf.cliTool
  ) return false;

  const resumeIds = new Set(
    [record.resumeId, provenance.resumeId, leaf.resumeId]
      .map(nonEmpty)
      .filter((value): value is string => Boolean(value)),
  );
  return resumeIds.size <= 1;
}

/**
 * 启动认领轮（docs/61 阶段 3）——本项修复的正主。
 *
 * 重启后 `restoreLiveDaemonSessions` 只能靠本 webview 自己的 `savedSessionId` 匹配，
 * 新实例手里没有上个实例生成的 id，于是把每个 tab 的会话**重建一遍**（事故根因）。
 * 这一轮改从**跨实例共享**的 `session_restore` 表反查归属，把仍活着的会话挂回原位。
 *
 * 判据严格：锚点精确 + 项目身份等价 + 运行时一致。任一不满足就保持无主，
 * 留给用户在资源管理器里手动确认——**认领错会话意味着 agent 在错误的仓库里
 * 继续对话，不可逆，比重建一条新会话严重得多**。
 *
 * 必须在 `runBackgroundLayoutRestore()` 之前完成，否则那边看到 `!tab.sessionId`
 * 照样重建。
 */
export async function reconcileTerminalSessions(
  options: ReconcileTerminalSessionsOptions,
): Promise<AdoptionReport> {
  const report: AdoptionReport = { attached: 0, skipped: 0, blocked: 0 };
  const leaves = restorableLeaves();
  for (const leaf of leaves) {
    writeRestoreLog(leaf.tabId, leaf.leaf.id, "daemon-snapshot.begin", {
      savedSessionId: leaf.leaf.savedSessionId ?? null,
    });
  }
  let snapshot: TerminalAdoptionSnapshot;
  try {
    snapshot = await terminalService.getAdoptionSnapshot();
  } catch (error) {
    for (const leaf of leaves) {
      writeRestoreLog(leaf.tabId, leaf.leaf.id, "daemon-snapshot.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    console.warn("[SessionAdopt] adoption snapshot failed:", error);
    report.blocked = blockPendingLeaves("reconciliation-failed");
    return report;
  }

  for (const leaf of leaves) {
    writeRestoreLog(leaf.tabId, leaf.leaf.id, "daemon-snapshot.end", {
      sessionCount: snapshot.sessions.length,
      claimsSupported: snapshot.claimsSupported,
      complete: snapshot.complete,
      daemonGeneration: snapshot.daemonGeneration ?? null,
    });
  }

  useTerminalStatusStore.getState().replaceLiveStatuses(snapshot.sessions);
  if (
    !snapshot.complete
    || !snapshot.claimsSupported
    || snapshot.daemonGeneration === undefined
    || !snapshot.ownerInstanceId
  ) {
    for (const leaf of leaves) {
      writeRestoreLog(leaf.tabId, leaf.leaf.id, "daemon-snapshot.blocked", {
        reason: "claims-unsupported",
      });
    }
    report.blocked = blockPendingLeaves("claims-unsupported");
    return report;
  }

  let saved: SavedSession[];
  try {
    for (const leaf of leaves) {
      writeRestoreLog(leaf.tabId, leaf.leaf.id, "saved-observations.begin");
    }
    saved = await sessionRestoreService.load();
    if (!Array.isArray(saved)) throw new Error("invalid saved session response");
  } catch (error) {
    for (const leaf of leaves) {
      writeRestoreLog(leaf.tabId, leaf.leaf.id, "saved-observations.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    console.warn("[SessionAdopt] ownership lookup failed:", error);
    report.blocked = blockPendingLeaves("reconciliation-failed");
    return report;
  }
  for (const leaf of leaves) {
    writeRestoreLog(leaf.tabId, leaf.leaf.id, "saved-observations.end", {
      count: saved.length,
    });
  }

  const liveIds = new Set(
    snapshot.sessions
      .filter((status) => status.status !== "exited")
      .map((status) => status.sessionId),
  );

  for (const leaf of leaves) {
    if (leaf.leaf.sessionId) continue;
    const candidates = saved.filter(
      (record) => liveIds.has(record.sessionId) && anchorMatches(record, leaf),
    );
    writeRestoreLog(leaf.tabId, leaf.leaf.id, "candidate.scan", {
      count: candidates.length,
      candidateSessionIds: candidates.map((candidate) => candidate.sessionId),
    });

    if (candidates.length === 0) {
      if (leaf.leaf.savedSessionId && liveIds.has(leaf.leaf.savedSessionId)) {
        writeRestoreLog(leaf.tabId, leaf.leaf.id, "candidate.blocked", {
          reason: "missing-provenance",
        });
        setBlocked(leaf, "missing-provenance");
        report.blocked += 1;
      } else {
        usePanesStore.getState().setTerminalRestoreBlocked(leaf.tabId, leaf.leaf.id, undefined);
      }
      continue;
    }
    let record: SavedSession;
    if (candidates.length > 1) {
      const savedSessionMatches = candidates.filter(
        (candidate) => candidate.sessionId === leaf.leaf.savedSessionId,
      );
      if (savedSessionMatches.length !== 1) {
        writeRestoreLog(leaf.tabId, leaf.leaf.id, "candidate.blocked", {
          reason: "ambiguous-candidates",
        });
        setBlocked(leaf, "ambiguous-candidates");
        report.blocked += 1;
        continue;
      }
      [record] = savedSessionMatches;
      writeRestoreLog(leaf.tabId, leaf.leaf.id, "candidate.selected", {
        sessionId: record.sessionId,
        source: "savedSessionId",
      });
    } else {
      [record] = candidates;
      writeRestoreLog(leaf.tabId, leaf.leaf.id, "candidate.selected", {
        sessionId: record.sessionId,
        source: "unique-anchor",
      });
    }
    const provenance = snapshot.provenance[record.sessionId];
    if (!provenance) {
      writeRestoreLog(leaf.tabId, leaf.leaf.id, "identity.blocked", {
        reason: "missing-provenance",
        sessionId: record.sessionId,
      });
      setBlocked(leaf, "missing-provenance");
      report.blocked += 1;
      continue;
    }
    if (!identityMatches(record, provenance, leaf, snapshot)) {
      writeRestoreLog(leaf.tabId, leaf.leaf.id, "identity.blocked", {
        reason: "identity-mismatch",
        sessionId: record.sessionId,
      });
      setBlocked(leaf, "identity-mismatch");
      report.blocked += 1;
      continue;
    }
    writeRestoreLog(leaf.tabId, leaf.leaf.id, "identity.accepted", {
      sessionId: record.sessionId,
    });

    const owner = snapshot.claims[record.sessionId];
    if (owner && owner !== snapshot.ownerInstanceId) {
      writeRestoreLog(leaf.tabId, leaf.leaf.id, "claim.blocked", {
        reason: "claim-conflict",
        owner,
      });
      setBlocked(leaf, "claim-conflict");
      report.blocked += 1;
      continue;
    }
    if (!owner && !options.autoAdopt) {
      writeRestoreLog(leaf.tabId, leaf.leaf.id, "claim.blocked", {
        reason: "auto-adopt-disabled",
      });
      setBlocked(leaf, "auto-adopt-disabled");
      report.blocked += 1;
      continue;
    }

    let granted = owner === snapshot.ownerInstanceId;
    if (!granted) {
      try {
        writeRestoreLog(leaf.tabId, leaf.leaf.id, "claim.begin", {
          sessionId: record.sessionId,
        });
        granted = await terminalService.adoptSession(record.sessionId);
      } catch (error) {
        writeRestoreLog(leaf.tabId, leaf.leaf.id, "claim.failed", {
          sessionId: record.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        console.warn(`[SessionAdopt] claim failed for ${record.sessionId}:`, error);
      }
    }
    if (!granted) {
      writeRestoreLog(leaf.tabId, leaf.leaf.id, "claim.blocked", {
        reason: "claim-conflict",
        sessionId: record.sessionId,
      });
      setBlocked(leaf, "claim-conflict");
      report.blocked += 1;
      continue;
    }
    writeRestoreLog(leaf.tabId, leaf.leaf.id, "claim.end", {
      sessionId: record.sessionId,
      granted: true,
    });

    writeRestoreLog(leaf.tabId, leaf.leaf.id, "attach.begin", {
      sessionId: record.sessionId,
    });
    const attached = usePanesStore.getState().attachSessionToAnchor({
      sessionId: record.sessionId,
      layoutId: record.layoutId,
      tabId: record.tabId,
      terminalPaneId: record.terminalPaneId,
      expectedProjectPath: record.projectPath,
    });
    if (!attached) {
      writeRestoreLog(leaf.tabId, leaf.leaf.id, "attach.failed", {
        sessionId: record.sessionId,
      });
      await terminalService.releaseSession(record.sessionId).catch((error) => {
        console.warn(`[SessionAdopt] failed to release unattached ${record.sessionId}:`, error);
      });
      setBlocked(leaf, "identity-mismatch");
      report.blocked += 1;
      continue;
    }
    writeRestoreLog(leaf.tabId, leaf.leaf.id, "attach.end", {
      sessionId: record.sessionId,
    });
    usePanesStore.getState().setSessionLeaseReadOnly(record.sessionId, false);
    report.attached += 1;
  }

  for (const leaf of leaves) {
    writeRestoreLog(leaf.tabId, leaf.leaf.id, "reconcile.end", { ...report });
  }

  void sessionRestoreService.prune(
    snapshot.daemonGeneration,
    snapshot.capturedAtMs,
    [...liveIds],
  ).catch((error) => console.warn("[SessionAdopt] stale row prune failed:", error));

  return report;
}

export async function adoptUnownedDaemonSessions(): Promise<AdoptionReport> {
  return reconcileTerminalSessions({ autoAdopt: true });
}

// 统一桥接后端发来的 history-updated 事件，保持现有页面订阅方式不变。
export function useTerminalResumeIdBridge(): void {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listenIfTauri<{ ptySessionId?: string; resumeSessionId?: string; resumeSource?: string }>("history-updated", (event) => {
      if (cancelled) return;
      const payload = event.payload ?? {};
      if (payload.ptySessionId && payload.resumeSessionId) {
        // 绑定事件可能早于 create_terminal 返回（tab.sessionId 尚未写入）到达，
        // 未命中 tab 时带退避重试，避免 issued/osc-title 绑定丢失
        const { ptySessionId, resumeSessionId, resumeSource } = payload;
        const applyBinding = (attempt: number) => {
          if (cancelled) return;
          const found = usePanesStore.getState().updateTabAgentResumeId(
            ptySessionId,
            resumeSessionId,
            resumeSource,
          );
          if (!found && attempt < 6) {
            setTimeout(() => applyBinding(attempt + 1), 500 * (attempt + 1));
          }
        };
        applyBinding(0);
      }
      window.dispatchEvent(new CustomEvent("cc-panes:history-updated"));
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
