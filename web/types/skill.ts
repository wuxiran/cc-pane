/** Skill 完整信息 */
export interface SkillInfo {
  name: string;
  content: string;
  filePath: string;
}

/** Skill 摘要（列表展示用） */
export interface SkillSummary {
  name: string;
  preview: string;
  filePath: string;
}

/** 市场条目来源：自维护清单 / anthropics 官方仓库自动发现 / skills.sh 搜索 */
export type SkillMarketSource = "curated" | "anthropics" | "skills-sh";

export interface SkillMarketEntry {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  tags: string[];
  version: string;
  license?: string | null;
  homepageUrl?: string | null;
  /** 单文件技能：SKILL.md 直链（需配 sha256） */
  contentUrl?: string | null;
  sha256?: string | null;
  recommended: boolean;
  source: SkillMarketSource | string;
  /** 目录型技能：GitHub owner/repo */
  repo?: string | null;
  /** 目录型技能：仓库内文件夹（搜索结果只带 leaf，安装时解析） */
  path?: string | null;
  gitRef?: string | null;
  featured: boolean;
  installs?: number | null;
}

export interface InstalledUserSkill {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  tags: string[];
  version: string;
  license?: string | null;
  homepageUrl?: string | null;
  sourceUrl?: string | null;
  contentSha256: string;
  installedAt: string;
  filePath?: string | null;
}

export type ExternalSkillSource =
  | { kind: "claude" }
  | { kind: "codex" }
  | { kind: "plugin"; pluginId: string };

export interface DiscoveredExternalSkill {
  id: string;
  name: string;
  description?: string | null;
  source: ExternalSkillSource;
  path: string;
  contentSha256: string;
  installedAt?: string | null;
}

/** A CLI-native or session-level transport for portable CC-Panes Skills. */
export type SkillDeliveryMode = "nativeCommand" | "nativeSkill" | "piSkill" | "sessionPrompt";

export interface BundledSkillDelivery {
  portable: boolean;
  modes: SkillDeliveryMode[];
  requiresCcpanesMcp: boolean;
}

/** CC-Panes 自带、启动时注入到各 CLI 全局目录的内置 skill（只读展示） */
export interface BundledSkill {
  name: string;
  description?: string | null;
  delivery?: BundledSkillDelivery;
}
