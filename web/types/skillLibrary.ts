// 资源库 · 技能的接口类型，与 docs/109「第 2 批」B 节和 Rust 端 serde(camelCase) 一一对应。

export type SkillSourceKind = "github" | "git" | "folder" | "imported" | "unknown";

/** skill.json 里记录的来源，用于检查更新和判断本地改动 */
export interface SkillProvenance {
  kind: SkillSourceKind;
  /** github: "owner/repo"；git: 克隆地址 */
  repo?: string;
  /** 分支或 tag；缺省为默认分支 */
  gitRef?: string;
  /** 技能在仓库内的目录，根目录为 "" */
  path?: string;
  /** github: 最后改动该目录的提交；git: 安装时仓库 HEAD */
  commit?: string;
  /** 安装/更新时的文件哈希 */
  treeHash?: string;
  /** folder: 链接的本机目录 */
  linkedPath?: string;
  /** imported: 原路径 */
  importedFrom?: string;
}

export type SkillEdited = "yes" | "no" | "unknown";

export interface LibrarySkill {
  id: string;
  name: string;
  description?: string;
  provenance: SkillProvenance;
  edited: SkillEdited;
  /** 上次完整抓取确认上游已删除 */
  gone: boolean;
  folderMissing: boolean;
  dirPath: string;
  installedAt: string;
}

export type SkillCheckStatus = "current" | "update" | "gone" | "unknown";

export interface SkillCheck {
  id: string;
  status: SkillCheckStatus;
  latestCommit?: string;
  compareUrl?: string;
  error?: string;
  rateLimitedUntil?: string;
}

export interface SkillLibraryContent {
  content: string;
  dirPath: string;
  files: string[];
}

export interface SkillProbeCandidate {
  path: string;
  name: string;
  description?: string;
  /** 已在资源库（同来源） */
  have: boolean;
  haveAs?: string;
  /** 将使用的 id；与其他来源重名时为 `<name>-<owner>` */
  installAs: string;
}

export interface SkillProbe {
  probeId: string;
  source: string;
  kind: SkillSourceKind;
  candidates: SkillProbeCandidate[];
  tooBig: { path: string; reason: string }[];
}

export interface SkillInstallResult {
  installed: string[];
  had: string[];
  skipped: { path: string; reason: string }[];
}

export interface SkillUpdateResult {
  updated: string[];
  keptEdited: string[];
  gone: string[];
  failed: { id: string; error: string }[];
  backupDir?: string;
}

export interface SkillRemoveResult {
  removed: string[];
  backupDir?: string;
}

export type FoundSkillOrigin = "claude" | "codex" | "agents";

export interface FoundSkill {
  /** 绝对路径 */
  key: string;
  name: string;
  description?: string;
  dirPath: string;
  origin: FoundSkillOrigin;
  isLink: boolean;
  linkTarget?: string;
  /** 资源库已有同名 */
  inLibraryAs?: string;
}

export interface SkillImportResult {
  imported: string[];
  failed: { key: string; error: string }[];
}
