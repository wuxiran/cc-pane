/**
 * Skill 管理服务层 — 封装所有 Skill 相关的 Tauri invoke 调用
 */
import type { BundledSkill, DiscoveredExternalSkill, InstalledUserSkill, SkillInfo, SkillMarketEntry, SkillSummary } from "@/types";
import { apiDeleteJson, apiGet, apiJson, invokeOrApi } from "./apiClient";

export const skillService = {
  /** 列出项目的所有 Skill（摘要） */
  async listSkills(projectPath: string): Promise<SkillSummary[]> {
    return invokeOrApi<SkillSummary[]>("list_skills", { projectPath }, () =>
      apiGet<SkillSummary[]>("/api/skills", { projectPath }),
    );
  },

  /** 获取单个 Skill 的完整内容 */
  async getSkill(
    projectPath: string,
    name: string
  ): Promise<SkillInfo | null> {
    return invokeOrApi<SkillInfo | null>("get_skill", { projectPath, name }, () =>
      apiGet<SkillInfo | null>(`/api/skills/${encodeURIComponent(name)}`, { projectPath }),
    );
  },

  /** 创建或更新 Skill */
  async saveSkill(
    projectPath: string,
    name: string,
    content: string
  ): Promise<SkillInfo> {
    return invokeOrApi<SkillInfo>("save_skill", { projectPath, name, content }, () =>
      apiJson<SkillInfo>("/api/skills", "PUT", { projectPath, name, content }),
    );
  },

  /** 删除 Skill */
  async deleteSkill(projectPath: string, name: string): Promise<boolean> {
    return invokeOrApi<boolean>("delete_skill", { projectPath, name }, () =>
      apiDeleteJson<boolean>(`/api/skills?projectPath=${encodeURIComponent(projectPath)}&name=${encodeURIComponent(name)}`),
    );
  },

  /** 跨项目复制 Skill */
  async copySkill(
    sourceProject: string,
    targetProject: string,
    name: string
  ): Promise<SkillInfo> {
    return invokeOrApi<SkillInfo>("copy_skill", { sourceProject, targetProject, name }, () =>
      apiJson<SkillInfo>("/api/skills/copy", "POST", { sourceProject, targetProject, name }),
    );
  },

  /** 列出 Claude / Codex / plugin 外部 Skill */
  async listExternalSkills(source?: "claude" | "codex" | "plugin"): Promise<DiscoveredExternalSkill[]> {
    return invokeOrApi<DiscoveredExternalSkill[]>("list_external_skills", { source: source ?? null }, () =>
      apiGet<DiscoveredExternalSkill[]>("/api/external-skills", { source: source ?? null }),
    );
  },

  /** 列出官方 Skill 市场条目 */
  async listSkillMarketEntries(): Promise<SkillMarketEntry[]> {
    return invokeOrApi<SkillMarketEntry[]>("list_skill_market_entries", undefined, async () => []);
  },

  /** 列出已安装的用户级 Skill */
  async listUserSkills(): Promise<InstalledUserSkill[]> {
    return invokeOrApi<InstalledUserSkill[]>("list_user_skills", undefined, () =>
      apiGet<InstalledUserSkill[]>("/api/user-skills"),
    );
  },

  /** 从官方市场安装 Skill */
  async installMarketSkill(skillId: string): Promise<InstalledUserSkill> {
    return invokeOrApi<InstalledUserSkill>("install_market_skill", { skillId }, async () => {
      throw new Error("Skill market installation is only available in the desktop app");
    });
  },

  /** 移除用户级 Skill */
  async removeUserSkill(skillId: string): Promise<boolean> {
    return invokeOrApi<boolean>("remove_user_skill", { skillId }, () =>
      apiDeleteJson<boolean>(`/api/user-skills/${encodeURIComponent(skillId)}`),
    );
  },

  /** 列出 CC-Panes 内置注入的 skill（只读展示） */
  async listBundledSkills(): Promise<BundledSkill[]> {
    return invokeOrApi<BundledSkill[]>("list_bundled_skills", undefined, async () => []);
  },
};
