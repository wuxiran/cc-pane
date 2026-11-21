// 在应用内新开一个终端执行命令（安装 / 升级 Agent 共用的行为）：
// 终端开在默认 Agent 目录里；没能自动提交就把命令复制到剪贴板并提示。
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useWorkspacesStore } from "@/stores";
import { toastErr, toastInfo } from "@/lib/feedback";
import type { OpenTerminalOptions } from "@/types";
import { currentInstallPlatform, terminalRunCommand } from "./agentCatalog";
import { resolveDefaultAgentCwd } from "./agentPromptLaunch";
import { runCommandInNewTerminal } from "./installTerminal";

export function useRunAgentCommand(onOpenTerminal: (opts: OpenTerminalOptions) => void) {
  const { t } = useTranslation("home");
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const expandedWorkspaceId = useWorkspacesStore((s) => s.expandedWorkspaceId);
  const expandedProjectId = useWorkspacesStore((s) => s.expandedProjectId);
  const terminalCwd = resolveDefaultAgentCwd(workspaces, expandedWorkspaceId, expandedProjectId);

  return useCallback(
    async (command: string) => {
      if (!terminalCwd) return;
      const platform = currentInstallPlatform();
      try {
        const result = await runCommandInNewTerminal(
          () => onOpenTerminal({ path: terminalCwd }),
          terminalRunCommand(command, platform),
        );
        if (result === "no-terminal") {
          await navigator.clipboard?.writeText(command).catch(() => undefined);
          toastInfo(t("install.runFallbackToast"));
        }
      } catch (error) {
        toastErr(t("install.runFailed", { error: String(error) }));
      }
    },
    [onOpenTerminal, t, terminalCwd],
  );
}
