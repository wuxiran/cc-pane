// 主窗口一侧：新开一个普通 shell 标签并提交命令（登录账号的登录命令）。
//
// 设置页开在主窗口里时直接调；开在独立设置窗口时，那边的 store 与主窗口不相通，
// 由设置窗口发 `runTerminalCommand` 动作过来，在这里执行（见 useSettingsWindowBridge）。
import i18n from "@/i18n";
import { useDialogStore, useWorkspacesStore } from "@/stores";
import { toastErr, toastInfo } from "@/lib/feedback";
import { translateError } from "@/utils";
import { resolveDefaultAgentCwd } from "@/components/home/agentPromptLaunch";
import { runCommandInNewTerminal } from "@/components/home/installTerminal";

export function defaultTerminalCwd(): string | null {
  const { workspaces, expandedWorkspaceId, expandedProjectId } = useWorkspacesStore.getState();
  return resolveDefaultAgentCwd(workspaces, expandedWorkspaceId, expandedProjectId) ?? null;
}

/** 返回是否已提交。开不了终端时把命令复制到剪贴板并提示（在主窗口里提示）。 */
export async function runCommandInMainWindowTerminal(command: string): Promise<boolean> {
  const cwd = defaultTerminalCwd();
  if (cwd) {
    try {
      const result = await runCommandInNewTerminal(
        () => useDialogStore.getState().setPendingLaunch({ path: cwd, providerId: "", cliTool: "none" }),
        command,
      );
      if (result === "sent") return true;
    } catch (error) {
      toastErr(translateError(error));
    }
  }
  await navigator.clipboard?.writeText(command).catch(() => undefined);
  toastInfo(i18n.t("providers:providerAccounts.login.copied"), { duration: 8_000 });
  return false;
}
