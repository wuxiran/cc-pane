// 打开终端 + pendingLaunch 消费，统一处理布局落位、启动历史与 Local History 快照。
// 含启动历史记录（resume 时 touch 已有记录、否则新建）与 Local History 自动快照。
import { useCallback, useEffect } from "react";
import { usePanesStore, useDialogStore, useSettingsStore } from "@/stores";
import { historyService, localHistoryService } from "@/services";
import { resolveRuntimeKind } from "@/utils/desktopRuntime";
import { resolveWorkspaceLaunchLayout } from "@/utils/layoutWorkspace";
import { classifyTerminalLaunchPath, translateError } from "@/utils";
import { toast } from "sonner";
import type { LaunchExtras, OpenTerminalOptions } from "@/types";

/** 从 OpenTerminalOptions 收拢启动器附加参数；全部缺省时返回 undefined */
function buildLaunchExtras(opts: OpenTerminalOptions): LaunchExtras | undefined {
  const { skipMcp, appendSystemPrompt, initialPrompt, yolo, adapterOptions } = opts;
  if (
    skipMcp === undefined
    && appendSystemPrompt === undefined
    && initialPrompt === undefined
    && yolo === undefined
    && adapterOptions === undefined
  ) {
    return undefined;
  }
  return { skipMcp, appendSystemPrompt, initialPrompt, yolo, adapterOptions };
}

export function useOpenTerminal(): (opts: OpenTerminalOptions) => void {
  const openProject = usePanesStore((s) => s.openProject);
  const pendingLaunch = useDialogStore((s) => s.pendingLaunch);
  const clearPendingLaunch = useDialogStore((s) => s.clearPendingLaunch);

  // 打开终端
  const handleOpenTerminal = useCallback(
    (opts: OpenTerminalOptions) => {
      const { path, workspaceName, providerId, providerSelection, launchProfileId, workspacePath, resumeId, ssh, wsl, machineName } = opts;
      const pathError = classifyTerminalLaunchPath(opts);
      if (pathError) {
        toast.error(translateError(pathError));
        return;
      }
      // 兼容：如果有 resumeId 但没有指定 cliTool，跟随全局默认设置
      const defaultTool = useSettingsStore.getState().settings?.general.defaultCliTool ?? "claude";
      const effectiveCliTool = opts.cliTool ?? (resumeId ? defaultTool : undefined);
      const runtimeKind = resolveRuntimeKind({ ssh, wsl });
      const launchClaude = effectiveCliTool !== undefined && effectiveCliTool !== "none";
      const projectId = `proj-${crypto.randomUUID()}`;
      const launchId = `launch-${crypto.randomUUID()}`;
      const workspaceSnapshotId = opts.workspaceSnapshotId ?? `ws-snapshot-${crypto.randomUUID()}`;
      // 显式目标优先。当前普通布局未绑定时，用户刚新建/选中它就是更强的落位意图；
      // 已绑定到其他工作空间（或当前为星标）时，才按 workspaceName 自动路由。
      let targetLayoutId = opts.targetLayoutId;
      if (!targetLayoutId && workspaceName) {
        const panes = usePanesStore.getState();
        const layouts = panes.listLayouts();
        targetLayoutId = resolveWorkspaceLaunchLayout(
          layouts,
          panes.currentLayoutId,
          workspaceName,
        )?.id;
      }
      openProject({ projectId, launchId, projectPath: path, resumeId, workspaceName, providerId, providerSelection, launchProfileId, workspacePath, cliTool: effectiveCliTool, ssh, wsl, machineName, workspaceSnapshotId, targetLayoutId, launchExtras: buildLaunchExtras(opts) });
      const name = path.split(/[/\\]/).pop() || path;

      // SSH 项目：launchCwd 用 display path
      const launchCwd = ssh
        ? path  // SSH 项目的 path 已是 ssh:// display path
        : (workspacePath ?? path);

      // launch_history 记录的是一次 PTY 启动，不是 conversation。即使 resume 已有
      // 历史行，本次启动也必须用新的 leaf launch id 建新行，不能 touch 并复用旧行。
      const recordPromise = historyService.add(
        launchId,
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
      ).then(async (recordId) => {
        if (resumeId) {
          await historyService.updateSessionId(recordId, resumeId);
        }
        return recordId;
      });

      recordPromise.then((recordId) => {
        window.dispatchEvent(new CustomEvent('cc-panes:history-updated'));
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
        targetLayoutId: pendingLaunch.targetLayoutId,
        skipMcp: pendingLaunch.skipMcp,
        appendSystemPrompt: pendingLaunch.appendSystemPrompt,
        initialPrompt: pendingLaunch.initialPrompt,
        yolo: pendingLaunch.yolo,
        adapterOptions: pendingLaunch.adapterOptions,
      });
      clearPendingLaunch();
    }
  }, [pendingLaunch, clearPendingLaunch, handleOpenTerminal]);

  return handleOpenTerminal;
}
