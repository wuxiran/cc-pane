import { invoke } from "@tauri-apps/api/core";
import type { ProjectCliHookGroupStatus } from "@/types";

/**
 * 项目级 CLI hooks 服务 - 管理不同 CLI 工具的项目 hooks
 */
export const projectCliHooksService = {
  async getStatus(projectPath: string): Promise<ProjectCliHookGroupStatus[]> {
    return invoke<ProjectCliHookGroupStatus[]>("get_project_cli_hooks", { projectPath });
  },

  async setHookEnabled(
    projectPath: string,
    cliTool: string,
    hookName: string,
    enabled: boolean,
  ): Promise<void> {
    return invoke("set_project_cli_hook_enabled", {
      projectPath,
      cliTool,
      hookName,
      enabled,
    });
  },
};
