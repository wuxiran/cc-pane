/**
 * Skills 管理端（链接启停）服务层 — 封装所有 link_* 相关的 Tauri invoke 调用
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  AddWorkspaceOutcome,
  DisableCounts,
  EnableCounts,
  LinkSnapshot,
  UpdateOutcome,
} from "@/types";

export const linkSkillService = {
  /** 全量扫描快照（rows 含每个 Agent 的 linked/copied/none 状态） */
  async snapshot(ws?: string | null): Promise<LinkSnapshot> {
    return invoke<LinkSnapshot>("link_snapshot", { ws: ws ?? null });
  },

  /** 批量启用（agent = "*" 表示全部 Agent；overwrite = 覆盖真实副本） */
  async enable(
    skills: string[],
    agent: string,
    ws?: string | null,
    overwrite?: boolean
  ): Promise<EnableCounts> {
    return invoke<EnableCounts>("link_enable", {
      skills,
      agent,
      ws: ws ?? null,
      overwrite: overwrite ?? false,
    });
  },

  /** 批量禁用（真实目录返回 protected，绝不自动删除） */
  async disable(skills: string[], agent: string, ws?: string | null): Promise<DisableCounts> {
    return invoke<DisableCounts>("link_disable", { skills, agent, ws: ws ?? null });
  },

  /** 批量远程更新：从各技能的 GitHub 来源仓库拉取最新版替换 master 原件 */
  async update(skills: string[], ws?: string | null): Promise<UpdateOutcome[]> {
    return invoke<UpdateOutcome[]>("link_update", { skills, ws: ws ?? null });
  },

  /** 切换活动工作空间 */
  async setWorkspace(name: string): Promise<void> {
    return invoke<void>("link_set_workspace", { name });
  },

  /** 添加项目工作空间 */
  async addWorkspace(path: string): Promise<AddWorkspaceOutcome> {
    return invoke<AddWorkspaceOutcome>("link_add_workspace", { path });
  },

  /** 手动标注仓库分组（repo 为空 = 清除） */
  async annotateRepo(dir: string, repo: string): Promise<void> {
    return invoke<void>("link_annotate_repo", { dir, repo });
  },
};
