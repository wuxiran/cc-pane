/** 单个 Agent 目录下技能的链接状态 */
export type LinkState = "linked" | "copied" | "none";

/** Agent 目录约定（<工作空间根>/<folder>/skills） */
export interface LinkAgent {
  name: string;
  folder: string;
}

/** 工作空间（path 为空 = 用户主目录） */
export interface LinkWorkspace {
  name: string;
  path: string;
}

/** 某技能在某 Agent 下的状态 */
export interface SkillAgentState {
  agent: string;
  state: LinkState;
}

/** 扫描行：中央仓库/工作空间中的一个可管理技能 */
export interface ManagedSkill {
  dir: string;
  skill: string;
  description?: string | null;
  repo?: string | null;
  url?: string | null;
  inMaster: boolean;
  statuses: SkillAgentState[];
}

/** 全量扫描快照 */
export interface LinkSnapshot {
  masterDir: string;
  masterCount: number;
  agents: LinkAgent[];
  workspaces: LinkWorkspace[];
  activeWorkspace: string;
  workspaceName: string;
  workspaceRoot: string;
  rows: ManagedSkill[];
}

/** 批量启用计数 */
export interface EnableCounts {
  ok: number;
  skip: number;
  conflict: number;
  nomaster: number;
  fail: number;
}

/** 批量禁用计数 */
export interface DisableCounts {
  ok: number;
  skip: number;
  protected: number;
  fail: number;
}

/** 单个技能的远程更新结果 */
export interface UpdateOutcome {
  dir: string;
  status: "updated" | "unsupported" | "no-source" | "error";
  detail?: string | null;
}

/** 添加工作空间的结果 */
export interface AddWorkspaceOutcome {
  name: string;
  duplicate: boolean;
}
