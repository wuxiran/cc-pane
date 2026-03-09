/**
 * Skill 管理状态管理
 */
import { create } from "zustand";
import { skillService } from "@/services";
import type { SkillInfo, SkillSummary } from "@/types";
import { translateError } from "@/utils";

interface SkillState {
  // ============ 状态 ============
  skills: SkillSummary[];
  projectPath: string | null;
  activeSkill: SkillInfo | null;
  loading: boolean;
  error: string | null;

  // ============ 操作 ============
  loadSkills: (projectPath: string) => Promise<void>;
  selectSkill: (projectPath: string, name: string) => Promise<void>;
  saveSkill: (
    projectPath: string,
    name: string,
    content: string
  ) => Promise<SkillInfo>;
  deleteSkill: (projectPath: string, name: string) => Promise<boolean>;
  copySkill: (
    sourceProject: string,
    targetProject: string,
    name: string
  ) => Promise<SkillInfo>;
  clearActiveSkill: () => void;
  clear: () => void;
}

export const useSkillStore = create<SkillState>((set, get) => ({
  skills: [],
  projectPath: null,
  activeSkill: null,
  loading: false,
  error: null,

  loadSkills: async (projectPath) => {
    set({ loading: true, error: null, projectPath });
    try {
      const skills = await skillService.listSkills(projectPath);
      set({ skills, loading: false });
    } catch (e) {
      set({ error: translateError(e), loading: false });
    }
  },

  selectSkill: async (projectPath, name) => {
    try {
      const skill = await skillService.getSkill(projectPath, name);
      set({ activeSkill: skill ?? null });
    } catch (e) {
      set({ error: translateError(e) });
    }
  },

  saveSkill: async (projectPath, name, content) => {
    const saved = await skillService.saveSkill(projectPath, name, content);
    // 重新加载列表
    const currentPath = get().projectPath;
    if (currentPath === projectPath) {
      const skills = await skillService.listSkills(projectPath);
      set({ skills, activeSkill: saved });
    }
    return saved;
  },

  deleteSkill: async (projectPath, name) => {
    const deleted = await skillService.deleteSkill(projectPath, name);
    if (deleted) {
      const currentPath = get().projectPath;
      if (currentPath === projectPath) {
        const skills = await skillService.listSkills(projectPath);
        const active = get().activeSkill;
        set({
          skills,
          activeSkill: active?.name === name ? null : active,
        });
      }
    }
    return deleted;
  },

  copySkill: async (sourceProject, targetProject, name) => {
    const copied = await skillService.copySkill(
      sourceProject,
      targetProject,
      name
    );
    // 如果目标是当前项目，刷新列表
    const currentPath = get().projectPath;
    if (currentPath === targetProject) {
      const skills = await skillService.listSkills(targetProject);
      set({ skills });
    }
    return copied;
  },

  clearActiveSkill: () => set({ activeSkill: null }),
  clear: () =>
    set({
      skills: [],
      projectPath: null,
      activeSkill: null,
      error: null,
    }),
}));
