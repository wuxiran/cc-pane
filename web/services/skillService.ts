/**
 * Skill 管理服务层 — 封装所有 Skill 相关的 Tauri invoke 调用
 */
import { invoke } from "@tauri-apps/api/core";
import type { SkillInfo, SkillSummary } from "@/types";

export const skillService = {
  /** 列出项目的所有 Skill（摘要） */
  async listSkills(projectPath: string): Promise<SkillSummary[]> {
    return invoke<SkillSummary[]>("list_skills", { projectPath });
  },

  /** 获取单个 Skill 的完整内容 */
  async getSkill(
    projectPath: string,
    name: string
  ): Promise<SkillInfo | null> {
    return invoke<SkillInfo | null>("get_skill", { projectPath, name });
  },

  /** 创建或更新 Skill */
  async saveSkill(
    projectPath: string,
    name: string,
    content: string
  ): Promise<SkillInfo> {
    return invoke<SkillInfo>("save_skill", { projectPath, name, content });
  },

  /** 删除 Skill */
  async deleteSkill(projectPath: string, name: string): Promise<boolean> {
    return invoke<boolean>("delete_skill", { projectPath, name });
  },

  /** 跨项目复制 Skill */
  async copySkill(
    sourceProject: string,
    targetProject: string,
    name: string
  ): Promise<SkillInfo> {
    return invoke<SkillInfo>("copy_skill", {
      sourceProject,
      targetProject,
      name,
    });
  },
};
