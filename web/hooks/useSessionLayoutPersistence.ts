// 布局快照持久化 + 跨端布局同步（从 App.tsx 原样搬出，勿在此做行为改动）。
// 两个 hook 共享模块级状态（lastSeenLayoutSnapshotSavedAt / suppressLayoutSnapshotSaveUntil），
// 必须保持模块级单例，不要把它们改成 hook 内部 state。
import { useEffect } from "react";
import { usePanesStore, useWorkspacesStore } from "@/stores";
import { sessionRestoreService, layoutSnapshotService } from "@/services";
import { getCurrentWindowIfTauri, isTauriRuntime } from "@/services/runtime";
import { waitForDesktopRuntime, resolveRuntimeKind } from "@/utils/desktopRuntime";
import {
  restoreLiveDaemonSessionsFromBackend,
  runBackgroundLayoutRestore,
} from "@/hooks/useTerminalSessionRestore";
import type { LayoutSnapshotPayload, SavedSession, Workspace } from "@/types";

let lastSeenLayoutSnapshotSavedAt = "";
let suppressLayoutSnapshotSaveUntil = 0;

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

function collectRestorableSessions(): SavedSession[] {
  const tabs = usePanesStore.getState().getRestorableTabs();
  const now = new Date().toISOString();
  return tabs
    .filter(({ tab }) => tab.contentType === "terminal" && tab.projectPath)
    .map(({ tab, paneId }) => ({
      workspaceSnapshotId: tab.workspaceSnapshotId,
      sessionId: tab.sessionId || tab.savedSessionId || tab.id,
      tabId: tab.id,
      paneId,
      projectPath: tab.projectPath,
      workspaceName: tab.workspaceName,
      workspacePath: tab.workspacePath,
      providerId: tab.providerId,
      providerSelection: tab.providerSelection,
      launchProfileId: tab.launchProfileId,
      cliTool: tab.cliTool || (tab.launchClaude ? "claude" : "none"),
      runtimeKind: resolveRuntimeKind({ ssh: tab.ssh, wsl: tab.wsl }),
      resumeId: tab.resumeId,
      sshConfig: tab.ssh ? JSON.stringify(tab.ssh) : undefined,
      customTitle: tab.title,
      createdAt: now,
      savedAt: now,
      hasOutput: false,
    }));
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
      await applySharedLayoutSnapshot().catch((error) => {
        console.warn("[LayoutSnapshot] Failed to apply shared layout:", error);
        return false;
      });
      if (cancelled) return;
      layoutPoll = setInterval(() => {
        applySharedLayoutSnapshot().then((applied) => {
          if (!applied) return;
          return restoreLiveDaemonSessionsFromBackend();
        }).catch((error) => {
          console.warn("[LayoutSnapshot] Failed to poll shared layout:", error);
        });
      }, 5_000);
      restoreLiveDaemonSessionsFromBackend()
        .then((restored) => {
          if (cancelled) return;
          if (restored > 0) {
            console.info(`[SessionRestore] Reattached ${restored} live daemon session(s)`);
          }
        })
        .catch((error) => {
          console.warn("[SessionRestore] Failed to restore live daemon sessions:", error);
        });
      // 当前布局恢复发起后，稍等再后台逐步恢复其他布局（活跃布局优先，共享队列自然排在其后）。
      setTimeout(() => {
        if (cancelled) return;
        void runBackgroundLayoutRestore();
      }, 3_000);
    });
    return () => {
      cancelled = true;
      if (layoutPoll) clearInterval(layoutPoll);
    };
  }, []);
}
