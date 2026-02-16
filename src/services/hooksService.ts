import { invoke } from "@tauri-apps/api/core";

/**
 * Hooks 服务 - 管理 Claude Code hooks 脚本
 */
export const hooksService = {
  /**
   * 检查项目是否启用了 hooks
   */
  async isEnabled(projectPath: string): Promise<boolean> {
    return invoke<boolean>("is_hooks_enabled", { projectPath });
  },

  /**
   * 启用 hooks
   */
  async enable(projectPath: string): Promise<void> {
    return invoke("enable_hooks", { projectPath });
  },

  /**
   * 禁用 hooks
   */
  async disable(projectPath: string): Promise<void> {
    return invoke("disable_hooks", { projectPath });
  },

  /**
   * 获取 workflow.md 内容
   */
  async getWorkflow(projectPath: string): Promise<string> {
    return invoke<string>("get_workflow", { projectPath });
  },

  /**
   * 保存 workflow.md 内容
   */
  async saveWorkflow(projectPath: string, content: string): Promise<void> {
    return invoke("save_workflow", { projectPath, content });
  },

  /**
   * 初始化项目的 .ccpanes 目录
   */
  async initCcpanes(projectPath: string): Promise<void> {
    return invoke("init_ccpanes", { projectPath });
  },
};
