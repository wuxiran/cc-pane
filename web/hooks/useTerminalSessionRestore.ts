// Terminal-sensitive 会话恢复链路（从 App.tsx 原样搬出，勿在此做行为改动）：
// - runBackgroundLayoutRestore / restoreLiveDaemonSessionsFromBackend：后台补建
//   非当前布局的终端会话，出队时重检避免重复建会话
// - useTerminalResumeIdBridge：桥接后端 history-updated 事件并带退避重试地回写
//   tab 的 agent resumeId
import { useEffect } from "react";
import { usePanesStore, useTerminalStatusStore } from "@/stores";
import { terminalService } from "@/services";
import { terminalRestoreLaunchQueue } from "@/components/panes/terminalRestoreQueue";
import { listenIfTauri } from "@/services/runtime";

// 后台逐步恢复"非当前布局"里还没有活会话的终端 tab。当前布局由其已挂载的 TerminalView 负责恢复，
// 这里只补其他布局：经限流队列逐个 createSession，再把新会话写成该 leaf 的可重连 savedSession +
// 标记 live，用户切到该布局时 TerminalView 的 deferred 重恢复会命中并 reattach（不重建、不双开）。
export async function runBackgroundLayoutRestore(): Promise<void> {
  const store = usePanesStore.getState();
  const currentLayoutId = store.currentLayoutId;
  const targets = store.getRestorableTabs().filter(
    ({ tab, layoutId }) =>
      layoutId !== currentLayoutId &&
      tab.contentType === "terminal" &&
      !!tab.projectPath &&
      !tab.sessionId,
  );
  if (targets.length === 0) return;
  console.info(`[BackgroundRestore] scheduling ${targets.length} tab(s) across other layouts`);
  for (const { tab } of targets) {
    void terminalRestoreLaunchQueue
      .run(async () => {
        // 出队时重检：已被恢复 / 该布局已变成当前(交给前台) → 跳过，避免重复建会话。
        const live = usePanesStore.getState();
        const fresh = live.getRestorableTabs().find((entry) => entry.tab.id === tab.id);
        if (!fresh || fresh.tab.sessionId || fresh.layoutId === live.currentLayoutId) {
          return null;
        }
        const sessionId = await terminalService.createSession({
          launchId: tab.projectId,
          projectPath: tab.projectPath,
          cols: 80,
          rows: 24,
          workspaceName: tab.workspaceName,
          providerId: tab.providerId,
          providerSelection: tab.providerSelection,
          launchProfileId: tab.launchProfileId,
          workspacePath: tab.workspacePath,
          workspaceSnapshotId: tab.workspaceSnapshotId,
          launchClaude: tab.launchClaude,
          cliTool: tab.cliTool,
          resumeId: tab.resumeId,
          ssh: tab.ssh,
          wsl: tab.wsl,
        });
        useTerminalStatusStore.getState().markSessionLive(sessionId);
        usePanesStore.getState().setBackgroundRestoreSession(tab.id, sessionId);
        return sessionId;
      })
      .catch((error) => {
        console.warn(`[BackgroundRestore] failed for tab ${tab.id}:`, error);
      });
  }
}

export async function restoreLiveDaemonSessionsFromBackend(): Promise<number> {
  // 用一次共享刷新预热 useTerminalStatusStore.statusMap：各 TerminalView 的
  // findLiveSavedSessionId 直接读这个缓存，避免每个 tab 各自再发 getAllStatus，
  // 否则重启时几十个 tab 并发打 IPC 会把后端拖住、导致恢复 stall。
  await useTerminalStatusStore.getState().refreshLiveStatuses();
  const statuses = Array.from(useTerminalStatusStore.getState().statusMap.values());
  return usePanesStore.getState().restoreLiveDaemonSessions(statuses);
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
