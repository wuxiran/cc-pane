/**
 * Skill 管理服务层 — 封装所有 Skill 相关的 Tauri invoke 调用
 */
import type {
  BundledSkill,
  DiscoveredExternalSkill,
  InstalledUserSkill,
  ProjectSkill,
  ProjectSkillContent,
  ProjectSkillImportSource,
  ProjectSkillRoot,
  SkillImportTarget,
  SkillInfo,
  SkillMarketEntry,
  SkillSummary,
} from "@/types";
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

  /** 列出市场目录（自维护清单 + 自动发现的上游仓库）；refresh 跳过一天期的发现缓存 */
  async listSkillMarketEntries(refresh = false): Promise<SkillMarketEntry[]> {
    return invokeOrApi<SkillMarketEntry[]>("list_skill_market_entries", { refresh }, async () => []);
  },

  /** 目录本地过滤 + skills.sh 联网搜索 */
  async searchSkillMarket(query: string): Promise<SkillMarketEntry[]> {
    return invokeOrApi<SkillMarketEntry[]>("search_skill_market", { query }, async () => []);
  },

  /** 为缺描述的条目（搜索结果）补全描述与仓库内路径 */
  async describeSkillMarketEntry(entry: SkillMarketEntry): Promise<SkillMarketEntry> {
    return invokeOrApi<SkillMarketEntry>("describe_skill_market_entry", { entry }, async () => entry);
  },

  /**
   * 安装一条市场条目。不传 workspaceName 装到用户级 ~/.cc-panes/skills/user/<id>；
   * 传了则直接落到该工作空间的技能目录（workspace-first）。
   */
  async installSkillMarketEntry(entry: SkillMarketEntry, workspaceName?: string | null): Promise<InstalledUserSkill> {
    return invokeOrApi<InstalledUserSkill>(
      "install_skill_market_entry",
      { entry, workspaceName: workspaceName ?? null },
      async () => {
        throw new Error("Skill market installation is only available in the desktop app");
      },
    );
  },

  /** 市场分类 id 列表（与后端 CATEGORY_IDS 同步） */
  async listSkillMarketCategories(): Promise<string[]> {
    return invokeOrApi<string[]>("list_skill_market_categories", undefined, async () => []);
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

  // ============ 项目级 Agent Skills（目录型，跨 CLI 根目录） ============

  async listProjectSkillRoots(): Promise<ProjectSkillRoot[]> {
    return invokeOrApi<ProjectSkillRoot[]>("list_project_skill_roots", undefined, async () => []);
  },

  async listProjectSkills(projectPath: string): Promise<ProjectSkill[]> {
    return invokeOrApi<ProjectSkill[]>("list_project_skills", { projectPath }, async () => []);
  },

  async readProjectSkill(projectPath: string, root: string, relDir: string): Promise<ProjectSkillContent | null> {
    return invokeOrApi<ProjectSkillContent | null>(
      "read_project_skill",
      { projectPath, root, relDir },
      async () => null,
    );
  },

  async saveProjectSkill(projectPath: string, root: string, name: string, content: string): Promise<ProjectSkill> {
    return invokeOrApi<ProjectSkill>("save_project_skill", { projectPath, root, name, content }, async () => {
      throw new Error("Project skills are only editable in the desktop app");
    });
  },

  async deleteProjectSkill(projectPath: string, root: string, relDir: string): Promise<boolean> {
    return invokeOrApi<boolean>("delete_project_skill", { projectPath, root, relDir }, async () => false);
  },

  async moveProjectSkill(projectPath: string, root: string, relDir: string, toRoot: string): Promise<ProjectSkill> {
    return invokeOrApi<ProjectSkill>("move_project_skill", { projectPath, root, relDir, toRoot }, async () => {
      throw new Error("Project skills are only editable in the desktop app");
    });
  },

  // ============ 工作空间级 Agent Skills（<workspace>/skills，按会话挂载） ============

  async listWorkspaceSkills(workspaceName: string): Promise<ProjectSkill[]> {
    return invokeOrApi<ProjectSkill[]>("list_workspace_skills", { workspaceName }, async () => []);
  },

  async readWorkspaceSkill(workspaceName: string, relDir: string): Promise<ProjectSkillContent | null> {
    return invokeOrApi<ProjectSkillContent | null>("read_workspace_skill", { workspaceName, relDir }, async () => null);
  },

  async saveWorkspaceSkill(workspaceName: string, name: string, content: string): Promise<ProjectSkill> {
    return invokeOrApi<ProjectSkill>("save_workspace_skill", { workspaceName, name, content }, async () => {
      throw new Error("Workspace skills are only editable in the desktop app");
    });
  },

  async deleteWorkspaceSkill(workspaceName: string, relDir: string): Promise<boolean> {
    return invokeOrApi<boolean>("delete_workspace_skill", { workspaceName, relDir }, async () => false);
  },

  /** 任意来源 → 项目根目录或工作空间 */
  async importSkill(
    target: SkillImportTarget,
    source: ProjectSkillImportSource,
    options?: { name?: string; overwrite?: boolean },
  ): Promise<ProjectSkill> {
    return invokeOrApi<ProjectSkill>(
      "import_skill",
      { target, source, name: options?.name ?? null, overwrite: options?.overwrite ?? false },
      async () => {
        throw new Error("Skill import is only available in the desktop app");
      },
    );
  },

  /** 把已装用户技能 / 外部 CLI 技能 / 其他项目技能 / 市场条目导入到项目某个根目录 */
  async importProjectSkill(
    projectPath: string,
    root: string,
    source: ProjectSkillImportSource,
    options?: { name?: string; overwrite?: boolean },
  ): Promise<ProjectSkill> {
    return invokeOrApi<ProjectSkill>(
      "import_project_skill",
      { projectPath, root, source, name: options?.name ?? null, overwrite: options?.overwrite ?? false },
      async () => {
        throw new Error("Project skills are only editable in the desktop app");
      },
    );
  },
};
