//! 资源库「技能」页的数据形状（docs/109 第 2 批）。字段名经 `rename_all = "camelCase"`
//! 与前端 `web/types` 一一对应，改字段要两边同步。

use serde::{Deserialize, Serialize};

/// 技能来源。未知值（旧版本或未来版本写入的 kind）一律落到 `Unknown`。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, Default)]
#[serde(rename_all = "lowercase")]
pub enum SkillSourceKind {
    Github,
    Git,
    Folder,
    Imported,
    #[default]
    #[serde(other)]
    Unknown,
}

impl SkillSourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Github => "github",
            Self::Git => "git",
            Self::Folder => "folder",
            Self::Imported => "imported",
            Self::Unknown => "unknown",
        }
    }
}

/// 技能从哪来，持久化在 `skill.json` 的 `provenance` 字段（可缺省，旧文件照常加载）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillProvenance {
    #[serde(default)]
    pub kind: SkillSourceKind,
    /// github: `owner/repo`；git: 克隆地址。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    /// 分支或 tag；缺省为默认分支。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_ref: Option<String>,
    /// 技能在仓库内的目录，根目录为 `""`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// github: 最后改动该目录的提交；git: 安装时仓库 HEAD。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    /// 安装 / 更新时的文件哈希，用于判断本地改动。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tree_hash: Option<String>,
    /// folder: 链接的本机目录（不复制，内容从这里读）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linked_path: Option<String>,
    /// imported: 原路径。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imported_from: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SkillEditedState {
    Yes,
    No,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySkill {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub provenance: SkillProvenance,
    pub edited: SkillEditedState,
    pub gone: bool,
    pub folder_missing: bool,
    pub dir_path: String,
    pub installed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillLibraryContent {
    pub content: String,
    pub dir_path: String,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SkillCheckStatus {
    Current,
    Update,
    Gone,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillCheck {
    pub id: String,
    pub status: SkillCheckStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compare_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate_limited_until: Option<String>,
}

impl SkillCheck {
    pub fn unknown(id: &str, error: impl Into<String>) -> Self {
        Self {
            id: id.to_string(),
            status: SkillCheckStatus::Unknown,
            latest_commit: None,
            compare_url: None,
            error: Some(error.into()),
            rate_limited_until: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillProbeCandidate {
    pub path: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub have: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub have_as: Option<String>,
    pub install_as: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillPathReason {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillProbe {
    pub probe_id: String,
    pub source: String,
    pub kind: SkillSourceKind,
    pub candidates: Vec<SkillProbeCandidate>,
    pub too_big: Vec<SkillPathReason>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallResult {
    pub installed: Vec<String>,
    pub had: Vec<String>,
    pub skipped: Vec<SkillPathReason>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillIdError {
    pub id: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillUpdateResult {
    pub updated: Vec<String>,
    pub kept_edited: Vec<String>,
    pub gone: Vec<String>,
    pub failed: Vec<SkillIdError>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillRemoveResult {
    pub removed: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup_dir: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FoundSkillOrigin {
    Claude,
    Codex,
    Agents,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FoundSkill {
    /// 绝对路径。
    pub key: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub dir_path: String,
    pub origin: FoundSkillOrigin,
    pub is_link: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link_target: Option<String>,
    /// 资源库已有同名。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_library_as: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillKeyError {
    pub key: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillImportResult {
    pub imported: Vec<String>,
    pub failed: Vec<SkillKeyError>,
}
