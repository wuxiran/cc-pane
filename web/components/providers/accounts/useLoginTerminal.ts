// 「登录」：取后端给的登录命令，在应用内新开一个终端标签执行；开不了就复制到剪贴板并提示。
//
// 打开终端走 pendingLaunch 全局通道（由 App 级唯一的 useOpenTerminal 消费，这里不能挂
// useOpenTerminal），等 shell 起来后提交命令的套路与「安装 Agent」相同（runCommandInNewTerminal）。
// 本机桌面主窗口直接开；独立的设置窗口和主窗口 store 不相通，发 `runTerminalCommand` 动作让主窗口开；
// Web 壳的终端不在本机，只复制命令。
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useDialogStore, useWorkspacesStore } from "@/stores";
import { loginAccountService } from "@/services/loginAccountService";
import { isTauriRuntime } from "@/services/runtime";
import { isSettingsWindow, sendActionToMainWindow } from "@/services/settingsWindowService";
import { toastErr, toastInfo, toastOk, toastWarn } from "@/lib/feedback";
import { translateError } from "@/utils";
import { currentInstallPlatform } from "@/components/home/agentCatalog";
import { resolveDefaultAgentCwd } from "@/components/home/agentPromptLaunch";
import { runCommandInNewTerminal } from "@/components/home/installTerminal";
import type { LoginAccountCliTool } from "@/types/provider";
import { loginCommandLine, loginTerminalCommand, type LoginShell } from "./loginCommandLine";

export type LoginRunResult = "sent" | "copied" | "failed";

function currentShell(): LoginShell {
  return currentInstallPlatform() === "windows" ? "windows" : "posix";
}

export function canOpenLocalTerminal(): boolean {
  return isTauriRuntime() && !isSettingsWindow();
}

export function useLoginTerminal() {
  const { t } = useTranslation("providers");
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const expandedWorkspaceId = useWorkspacesStore((s) => s.expandedWorkspaceId);
  const expandedProjectId = useWorkspacesStore((s) => s.expandedProjectId);
  const cwd = resolveDefaultAgentCwd(workspaces, expandedWorkspaceId, expandedProjectId);

  return useCallback(async (
    providerId: string,
    accountId: string,
    cliTool: LoginAccountCliTool,
  ): Promise<LoginRunResult> => {
    let command;
    try {
      command = await loginAccountService.getLoginCommand(providerId, accountId, cliTool);
    } catch (error) {
      toastErr(translateError(error));
      return "failed";
    }
    if (!command.executableFound) {
      toastWarn(t("providerAccounts.login.executableMissing", { command: command.command }));
    }
    const shell = currentShell();
    let sent = false;
    if (isTauriRuntime() && isSettingsWindow()) {
      // 独立设置窗口开不了主窗口的标签：交给主窗口开（开不了时主窗口那边复制并提示）。
      try {
        await sendActionToMainWindow({ type: "runTerminalCommand", command: loginTerminalCommand(command, shell) });
        if (command.interactive) toastInfo(t("providerAccounts.login.interactiveHint"), { duration: 10_000 });
        toastOk(t("providerAccounts.login.opened"));
        return "sent";
      } catch {
        // 主窗口收不到：退回复制
      }
    } else if (canOpenLocalTerminal() && cwd) {
      try {
        const result = await runCommandInNewTerminal(
          () => useDialogStore.getState().setPendingLaunch({ path: cwd, providerId: "", cliTool: "none" }),
          loginTerminalCommand(command, shell),
        );
        sent = result === "sent";
      } catch (error) {
        toastErr(translateError(error));
      }
    }
    if (command.interactive) {
      toastInfo(t("providerAccounts.login.interactiveHint"), { duration: 10_000 });
    }
    if (sent) {
      toastOk(t("providerAccounts.login.opened"));
      return "sent";
    }
    await navigator.clipboard?.writeText(loginCommandLine(command, shell)).catch(() => undefined);
    toastInfo(t("providerAccounts.login.copied"), { duration: 8_000 });
    return "copied";
  }, [cwd, t]);
}
