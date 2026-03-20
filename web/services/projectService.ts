import { invoke } from "@tauri-apps/api/core";
import type { Project } from "@/types";

/**
 * 项目服务 - 封装与后端的 API 调用
 */
export const projectService = {
  /**
   * 获取所有项目列表
   */
  async list(): Promise<Project[]> {
    return invoke<Project[]>("list_projects");
  },

  /**
   * 添加新项目
   */
  async add(path: string): Promise<Project> {
    const project = await invoke<Project>("add_project", { path });
    // 初始化 Local History
    try {
      await invoke("init_project_history", { projectPath: path });
    } catch (e) {
      console.warn("Failed to init project history:", e);
    }
    return project;
  },

  /**
   * 删除项目
   */
  async remove(id: string): Promise<void> {
    return invoke("remove_project", { id });
  },

  /**
   * 获取单个项目
   */
  async get(id: string): Promise<Project | null> {
    return invoke<Project | null>("get_project", { id });
  },

  /**
   * 更新项目名称
   */
  async updateName(id: string, name: string): Promise<void> {
    return invoke("update_project_name", { id, name });
  },

  /**
   * 更新项目别名
   */
  async updateAlias(id: string, alias: string | null): Promise<void> {
    return invoke("update_project_alias", { id, alias });
  },
};
