use serde::{Deserialize, Serialize};

/// 单个 Agent 目录下技能的链接状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkState {
    /// Junction/SymbolicLink 已生效
    Linked,
    /// 独立真实目录（副本），受保护
    Copied,
    /// 未安装
    None,
}

/// 某技能在某 Agent 下的状态
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillAgentState {
    pub agent: String,
    pub state: LinkState,
}

/// 中央仓库/工作空间中的一个可管理技能（扫描行）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSkill {
    /// 技能目录名（唯一键）
    pub dir: String,
    /// SKILL.md frontmatter 里的 name（缺省为目录名）
    pub skill: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// 仓库分组（手动标注 > .skill-lock.json > （本项目）/（未分组））
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    /// 来源仓库 URL（.skill-lock.json 溯源，用于远程更新）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// 是否来自中央仓库（false = 工作空间私有技能）
    pub in_master: bool,
    /// 各 Agent 的安装状态
    pub statuses: Vec<SkillAgentState>,
}

/// Agent 目录约定（<工作空间根>/<folder>/skills）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinkAgent {
    pub name: String,
    pub folder: String,
}

/// 工作空间（path 为空 = 用户主目录）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinkWorkspace {
    pub name: String,
    #[serde(default)]
    pub path: String,
}

/// 一次扫描的完整快照
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkSnapshot {
    pub master_dir: String,
    pub master_count: usize,
    pub agents: Vec<LinkAgent>,
    pub workspaces: Vec<LinkWorkspace>,
    pub active_workspace: String,
    pub workspace_name: String,
    pub workspace_root: String,
    pub rows: Vec<ManagedSkill>,
}

/// 批量启用计数（语义与 Skills 管理端一致）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnableCounts {
    pub ok: u32,
    pub skip: u32,
    pub conflict: u32,
    pub nomaster: u32,
    pub fail: u32,
}

/// 批量禁用计数（protected = 真实目录受保护，绝不自动删除）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisableCounts {
    pub ok: u32,
    pub skip: u32,
    #[serde(rename = "protected")]
    pub protected_count: u32,
    pub fail: u32,
}

/// 单个技能的远程更新结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOutcome {
    pub dir: String,
    /// updated | unsupported | no-source | error
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// 添加工作空间的结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddWorkspaceOutcome {
    pub name: String,
    pub duplicate: bool,
}
