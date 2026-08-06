// 布局快照持久化 + 跨端布局同步（从 App.tsx 原样搬出，勿在此做行为改动）。
// 两个 hook 共享模块级状态（lastSeenLayoutSnapshotSavedAt / suppressLayoutSnapshotSaveUntil），
// 必须保持模块级单例，不要把它们改成 hook 内部 state。
import { useEffect, useRef, useState } from "react";
import { usePanesStore, useSettingsStore, useWorkspacesStore } from "@/stores";
import { collectSnapshotSessionIds, finalizeSnapshotWouldKill } from "@/stores/snapshotSessionDiff";
import { sessionRestoreService, layoutSnapshotService, terminalService } from "@/services";
import { getCurrentWindowIfTauri, isTauriRuntime } from "@/services/runtime";
import { waitForDesktopRuntime, resolveRuntimeKind } from "@/utils/desktopRuntime";
import { collectTerminalLeaves } from "@/lib/paneSessions";
import {
  reconcileTerminalSessions,
  runBackgroundLayoutRestore,
} from "@/hooks/useTerminalSessionRestore";
import {
  beginTerminalRestoreBarrier,
  finishTerminalRestoreBarrier,
  waitForTerminalRestoreBarrier,
} from "@/services/terminalRestoreBarrier";
import type { LayoutSnapshotPayload, SavedSession, Workspace } from "@/types";

let lastSeenLayoutSnapshotSavedAt = "";
let suppressLayoutSnapshotSaveUntil = 0;
// daemon 默认写租约是 30 秒。应用崩溃后立即重启时，首轮会看见上一进程的有效租约；
// 屏障先阻止重复建 PTY，再在租约自然过期后补一次自动认领。
const STARTUP_ADOPTION_RETRY_MS = 31_000;

function currentLayoutProfileId(): string {
  return "default";
}

function layoutSnapshotSource(): string {
  return isTauriRuntime() ? "desktop" : "web";
}

function layoutWorkspaceMeta(): Pick<Workspace, "id" | "name"> | null {
  const workspace = useWorkspacesStore.getState().selectedWorkspace();
  return workspace ? { id: workspace.id, name: workspace.alias || workspace.name } : null;
}

function currentLayoutSnapshotPayload(): LayoutSnapshotPayload {
  return usePanesStore.getState().exportLayoutSnapshotPayload();
}

async function saveSharedLayoutSnapshot(): Promise<void> {
  const workspace = layoutWorkspaceMeta();
  const savedAt = new Date().toISOString();
  await layoutSnapshotService.save({
    profileId: currentLayoutProfileId(),
    workspaceId: workspace?.id ?? null,
    workspaceName: workspace?.name ?? null,
    payload: currentLayoutSnapshotPayload(),
    savedAt,
    source: layoutSnapshotSource(),
  });
  lastSeenLayoutSnapshotSavedAt = savedAt;
}

async function applySharedLayoutSnapshot(): Promise<boolean> {
  const snapshot = await layoutSnapshotService.load(currentLayoutProfileId());
  if (!snapshot?.payload) return false;
  if (snapshot.savedAt && snapshot.savedAt <= lastSeenLayoutSnapshotSavedAt) return false;
  suppressLayoutSnapshotSaveUntil = Date.now() + 1_500;
  const applied = usePanesStore.getState().applyLayoutSnapshotPayload(snapshot.payload);
  if (applied) {
    lastSeenLayoutSnapshotSavedAt = snapshot.savedAt;
  }
  return applied;
}

/**
 * 收集可恢复会话。docs/61 阶段 1 的三项修正都落在这里：
 *
 * 1. **逐 leaf 一行**：终端 tab 可含多个分屏 leaf，各自持有独立 PTY。以前每 tab 只存
 *    一行，恢复时只能挂到活动 leaf，会把会话接到错误的分屏格子。
 * 2. **禁掉 tab.id 冒充 sessionId**：旧的 `tab.sessionId || tab.savedSessionId || tab.id`
 *    会把 tab id 写进 session_id 列，污染这张表作为归属权威源的资格。没有真实 PTY id
 *    的 leaf 直接跳过——它本来就没有会话可恢复。
 * 3. **完整运行时指纹**：补 wsl（distro/remotePath）与 machineName，否则接管后的重建
 *    会落到本地错误目录。
 */
export function collectRestorableSessions(): SavedSession[] {
  const tabs = usePanesStore.getState().getRestorableTabs();
  const now = new Date().toISOString();
  const sessions: SavedSession[] = [];
  const observerInstanceId = terminalService.getCachedDaemonClientInfo()?.instanceId;

  for (const { tab, paneId, layoutId } of tabs) {
    if (tab.contentType !== "terminal" || !tab.projectPath) continue;

    for (const leaf of collectTerminalLeaves(tab.terminalRootPane)) {
      // 只认真实 PTY session id；rehydrate 后 live id 会被搬进 savedSessionId。
      const sessionId = leaf.sessionId || leaf.savedSessionId;
      if (!sessionId) continue;

      const ssh = leaf.ssh ?? tab.ssh;
      const wsl = leaf.wsl ?? tab.wsl;
      sessions.push({
        workspaceSnapshotId: leaf.workspaceSnapshotId ?? tab.workspaceSnapshotId,
        sessionId,
        tabId: tab.id,
        paneId,
        terminalPaneId: leaf.id,
        layoutId,
        projectPath: tab.projectPath,
        workspaceName: leaf.workspaceName ?? tab.workspaceName,
        workspacePath: leaf.workspacePath ?? tab.workspacePath,
        providerId: leaf.providerId ?? tab.providerId,
        providerSelection: leaf.providerSelection ?? tab.providerSelection,
        launchProfileId: leaf.launchProfileId ?? tab.launchProfileId,
        cliTool: leaf.cliTool || tab.cliTool || (tab.launchClaude ? "claude" : "none"),
        runtimeKind: resolveRuntimeKind({ ssh, wsl }),
        resumeId: leaf.resumeId ?? tab.resumeId,
        sshConfig: ssh ? JSON.stringify(ssh) : undefined,
        wslConfig: wsl ? JSON.stringify(wsl) : undefined,
        machineName: leaf.machineName ?? tab.machineName,
        observerInstanceId,
        customTitle: tab.title,
        createdAt: now,
        savedAt: now,
        hasOutput: false,
      });
    }
  }

  return sessions;
}

/**
 * Complete one generation-consistent reconciliation before AppShell mounts. The barrier is also
 * awaited inside terminalService.createSession, covering launches triggered by global listeners.
 */
export function useStartupTerminalRestoreBarrier(): boolean {
  const [ready, setReady] = useState(false);
  const activated = useRef(false);
  if (!activated.current) {
    beginTerminalRestoreBarrier();
    activated.current = true;
  }

  useEffect(() => {
    let cancelled = false;
    let adoptionRetryTimer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      try {
        const runtimeReady = await waitForDesktopRuntime();
        if (isTauriRuntime() && !runtimeReady) return;
        if (!useSettingsStore.getState().settings) {
          await useSettingsStore.getState().loadSettings();
        }
        if (cancelled) return;
        await applySharedLayoutSnapshot().catch((error) => {
          console.warn("[LayoutSnapshot] Failed to apply before terminal reconciliation:", error);
          return false;
        });
        const autoAdopt = Boolean(
          useSettingsStore.getState().settings?.terminal.autoAdoptDaemonSessions,
        );
        const report = await reconcileTerminalSessions({ autoAdopt });
        if (autoAdopt && report.blocked > 0 && !cancelled) {
          adoptionRetryTimer = setTimeout(() => {
            if (cancelled) return;
            void reconcileTerminalSessions({ autoAdopt: true })
              .then(() => runBackgroundLayoutRestore())
              .catch((error) => {
                console.warn("[SessionRestore] Delayed adoption retry failed:", error);
              });
          }, STARTUP_ADOPTION_RETRY_MS);
        }
      } catch (error) {
        console.warn("[SessionRestore] Startup reconciliation failed closed:", error);
      } finally {
        finishTerminalRestoreBarrier();
        if (!cancelled) {
          setReady(true);
          setTimeout(() => void runBackgroundLayoutRestore(), 0);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (adoptionRetryTimer) clearTimeout(adoptionRetryTimer);
    };
  }, []);

  return ready;
}

export function useSessionLayoutPersistence(): void {
  useEffect(() => {
    let cancelled = false;
    let unlistenClose: (() => void) | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;

    waitForDesktopRuntime().then(async (ready) => {
      if (cancelled) return;
      if (isTauriRuntime() && !ready) return;

      const currentWindow = getCurrentWindowIfTauri();
      if (currentWindow) {
        const unlisten = await currentWindow.onCloseRequested(async () => {
          try {
            const sessions = collectRestorableSessions();
            if (sessions.length > 0) {
              await sessionRestoreService.save(sessions);
              await saveSharedLayoutSnapshot();
              console.info(`[SessionRestore] Saved ${sessions.length} sessions on close`);
            }
          } catch (err) {
            console.error("[SessionRestore] Failed to save sessions on close:", err);
          }
        });
        // await 期间可能已卸载：立即释放，避免监听器泄漏
        if (cancelled) {
          unlisten();
          return;
        }
        unlistenClose = unlisten;
      }

      if (cancelled) return;
      timer = setInterval(async () => {
        try {
          const sessions = collectRestorableSessions();
          if (sessions.length > 0) {
            await sessionRestoreService.save(sessions);
          }
          await saveSharedLayoutSnapshot();
        } catch { /* silent */ }
      }, 60_000);
    });

    return () => {
      cancelled = true;
      unlistenClose?.();
      if (timer) clearInterval(timer);
    };
  }, []);
}

export function useSharedLayoutSnapshotSync(): void {
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleSave = () => {
      if (cancelled) return;
      if (Date.now() < suppressLayoutSnapshotSaveUntil) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (Date.now() < suppressLayoutSnapshotSaveUntil) return;
        saveSharedLayoutSnapshot().catch((error) => {
          console.warn("[LayoutSnapshot] Failed to save shared layout:", error);
        });
      }, 800);
    };

    window.addEventListener("cc-panes:terminal-layout-changed", scheduleSave);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("cc-panes:terminal-layout-changed", scheduleSave);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let layoutPoll: ReturnType<typeof setInterval> | undefined;
    waitForDesktopRuntime().then(async (ready) => {
      if (cancelled || (isTauriRuntime() && !ready)) return;
      await waitForTerminalRestoreBarrier();
      if (cancelled) return;
      layoutPoll = setInterval(() => {
        applySharedLayoutSnapshot().then((applied) => {
          if (!applied) return;
          return reconcileTerminalSessions({
            autoAdopt: Boolean(
              useSettingsStore.getState().settings?.terminal.autoAdoptDaemonSessions,
            ),
          })
            .then(() => runBackgroundLayoutRestore())
            .then(async () => {
              // 杀决策后置（补账2）：收养已 settle，按当前树引用 + 后端活会话
              // 复核 apply 时登记的候选杀集。仍只打日志——开闸等观察期零误报，
              // 但从此观察到的 would-kill 就是复核后的最终口径。
              const state = usePanesStore.getState();
              const treeRefs = new Set(collectSnapshotSessionIds(state));
              let live = new Set<string>();
              try {
                const statuses = await terminalService.getAllStatus();
                live = new Set(statuses.map((s) => s.sessionId));
              } catch {
                // 后端不可达：保护集退化为仅树引用（宁可少报也不误报杀活）
              }
              finalizeSnapshotWouldKill(treeRefs, live);
            });
        }).catch((error) => {
          console.warn("[LayoutSnapshot] Failed to poll shared layout:", error);
        });
      }, 5_000);
    });
    return () => {
      cancelled = true;
      if (layoutPoll) clearInterval(layoutPoll);
    };
  }, []);
}
