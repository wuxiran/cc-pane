// 打开终端 + pendingLaunch 消费（从 App.tsx 原样搬出，勿在此做行为改动）。
// 含启动历史记录（resume 时 touch 已有记录、否则新建）与 Local History 自动快照。
import { useCallback, useEffect } from "react";
import { usePanesStore, useDialogStore, useSettingsStore } from "@/stores";
import { historyService, localHistoryService } from "@/services";
import { resolveRuntimeKind } from "@/utils/desktopRuntime";
import type { OpenTerminalOptions } from "@/types";

export function useOpenTerminal(): (opts: OpenTerminalOptions) => void {
  const openProject = usePanesStore((s) => s.openProject);
  const pendingLaunch = useDialogStore((s) => s.pendingLaunch);
  const clearPendingLaunch = useDialogStore((s) => s.clearPendingLaunch);

  // 打开终端
  const handleOpenTerminal = useCallback(
    (opts: OpenTerminalOptions) => {
      const { path, workspaceName, providerId, providerSelection, launchProfileId, workspacePath, resumeId, ssh, wsl, machineName } = opts;
      // 兼容：如果有 resumeId 但没有指定 cliTool，跟随全局默认设置
      const defaultTool = useSettingsStore.getState().settings?.general.defaultCliTool ?? "claude";
      const effectiveCliTool = opts.cliTool ?? (resumeId ? defaultTool : undefined);
      const runtimeKind = resolveRuntimeKind({ ssh, wsl });
      const launchClaude = effectiveCliTool !== undefined && effectiveCliTool !== "none";
      const projectId = `proj-${crypto.randomUUID()}`;
      const workspaceSnapshotId = opts.workspaceSnapshotId ?? `ws-snapshot-${crypto.randomUUID()}`;
      openProject({ projectId, projectPath: path, resumeId, workspaceName, providerId, providerSelection, launchProfileId, workspacePath, cliTool: effectiveCliTool, ssh, wsl, machineName, workspaceSnapshotId });
      const name = path.split(/[/\\]/).pop() || path;

      // SSH 项目：launchCwd 用 display path
      const launchCwd = ssh
        ? path  // SSH 项目的 path 已是 ssh:// display path
        : (workspacePath ?? path);

      const recordPromise = resumeId
        ? historyService.touchBySessionId(resumeId).then((existingId) => {
            if (existingId !== null) {
              window.dispatchEvent(new CustomEvent('cc-panes:history-updated'));
              return existingId;
            }
            // 回退：无已有记录时创建新记录
            return historyService.add(
              projectId,
              name,
              path,
              effectiveCliTool ?? "none",
              runtimeKind,
              wsl?.distro,
              workspaceName,
              workspacePath,
              launchCwd,
              providerId,
              providerSelection,
              workspaceSnapshotId,
              launchProfileId,
            ).then((newId) => {
              historyService.updateSessionId(newId, resumeId).then(() => {
                window.dispatchEvent(new CustomEvent('cc-panes:history-updated'));
              }).catch(console.error);
              return newId;
            });
          })
        : historyService.add(
            projectId,
            name,
            path,
            effectiveCliTool ?? "none",
            runtimeKind,
            wsl?.distro,
            workspaceName,
            workspacePath,
            launchCwd,
            providerId,
            providerSelection,
            workspaceSnapshotId,
            launchProfileId,
          );

      recordPromise.then((recordId) => {
        if (!resumeId) {
          window.dispatchEvent(new CustomEvent('cc-panes:history-updated'));
        }
        void recordId;
      }).catch(console.error);

      localHistoryService.initProjectHistory(path).catch(console.error);
      // CC 启动时自动创建项目快照，方便后续项目级恢复
      if (launchClaude || resumeId) {
        localHistoryService.createAutoLabel(
          workspacePath || path,
          `CC Session: ${new Date().toLocaleString()}`,
          "claude_session"
        ).catch(console.error);
      }
    },
    [openProject]
  );

  // 监听 pendingLaunch（从 Settings Provider 启动）
  useEffect(() => {
    if (pendingLaunch) {
      const defaultTool = useSettingsStore.getState().settings?.general.defaultCliTool ?? "claude";
      handleOpenTerminal({
        path: pendingLaunch.path,
        workspaceName: pendingLaunch.workspaceName,
        providerId: pendingLaunch.providerId,
        providerSelection: pendingLaunch.providerSelection,
        launchProfileId: pendingLaunch.launchProfileId,
        workspacePath: pendingLaunch.workspacePath,
        ssh: pendingLaunch.ssh,
        wsl: pendingLaunch.wsl,
        machineName: pendingLaunch.machineName,
        cliTool: pendingLaunch.cliTool ?? defaultTool,
      });
      clearPendingLaunch();
    }
  }, [pendingLaunch, clearPendingLaunch, handleOpenTerminal]);

  return handleOpenTerminal;
}
