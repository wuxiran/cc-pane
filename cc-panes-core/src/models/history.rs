use serde::{Deserialize, Serialize};

/// 文件版本信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVersion {
    /// 版本ID（时间戳）
    pub id: String,
    /// 相对路径
    pub file_path: String,
    /// SHA256 哈希
    pub hash: String,
    /// 文件大小（字节）
    pub size: u64,
    /// 创建时间（ISO8601）
    pub created_at: String,
    /// 是否为已删除文件的最后快照
    #[serde(default)]
    pub is_deleted: bool,
    /// 所属分支（空字符串表示旧数据/未知分支）
    #[serde(default)]
    pub branch: String,
}

/// 版本列表元数据（仅用于旧版 versions.json 迁移兼容）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VersionsMetadata {
    pub versions: Vec<FileVersion>,
}

/// 历史记录配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryConfig {
    pub enabled: bool,
    pub ignore_patterns: Vec<String>,
    pub max_versions_per_file: usize,
    pub max_age_days: u32,
    /// 单文件大小限制（字节），超过此大小的文件不记录历史
    #[serde(default = "default_max_file_size")]
    pub max_file_size: u64,
    /// 项目级总存储空间限制（字节）
    #[serde(default = "default_max_total_size")]
    pub max_total_size: u64,
    /// 同一文件同一分支的最小保存间隔（秒），默认 300 秒（5 分钟）
    #[serde(default = "default_min_save_interval_secs")]
    pub min_save_interval_secs: u64,
}

fn default_max_file_size() -> u64 {
    5 * 1024 * 1024 // 5MB
}

fn default_max_total_size() -> u64 {
    500 * 1024 * 1024 // 500MB
}

fn default_min_save_interval_secs() -> u64 {
    300 // 5 分钟
}

impl Default for HistoryConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            ignore_patterns: vec![
                "node_modules/**".to_string(),
                ".git/**".to_string(),
                "target/**".to_string(),
                "dist/**".to_string(),
                "build/**".to_string(),
                "*.log".to_string(),
                "*.lock".to_string(),
                ".ccpanes/**".to_string(),
            ],
            max_versions_per_file: 50,
            max_age_days: 30,
            max_file_size: default_max_file_size(),
            max_total_size: default_max_total_size(),
            min_save_interval_secs: default_min_save_interval_secs(),
        }
    }
}

/// TOML 配置文件结构
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProjectConfig {
    pub history: HistoryConfig,
}

// ============ Diff 模型 ============

/// Diff 变更类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DiffChangeType {
    Equal,
    Insert,
    Delete,
    Replace,
}

/// 行内字符级变更标记
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InlineChange {
    pub start: usize,
    pub end: usize,
    pub change_type: DiffChangeType,
}

/// Diff 中的单行信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub change_type: DiffChangeType,
    pub content: String,
    pub old_line_no: Option<usize>,
    pub new_line_no: Option<usize>,
    pub inline_changes: Option<Vec<InlineChange>>,
}

/// Diff 统计
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiffStats {
    pub additions: usize,
    pub deletions: usize,
    pub changes: usize,
}

/// Diff hunk（一段连续变更）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub old_start: usize,
    pub old_count: usize,
    pub new_start: usize,
    pub new_count: usize,
    pub lines: Vec<DiffLine>,
}

/// Diff 结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    pub hunks: Vec<DiffHunk>,
    pub stats: DiffStats,
    pub is_binary: bool,
    pub truncated: bool,
}

// ============ 标签模型 ============

/// 标签关联的文件快照引用
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelFileSnapshot {
    /// 文件相对路径
    pub file_path: String,
    /// 关联的版本 ID
    pub version_id: String,
}

/// 历史标签
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryLabel {
    /// 标签唯一 ID
    pub id: String,
    /// 标签名称
    pub name: String,
    /// 标签类型: "auto" | "manual"
    pub label_type: String,
    /// 标签来源: "git_commit" | "claude_session" | "user" | "build" | "restore" | "branch_switch"
    pub source: String,
    /// 创建时间（ISO8601）
    pub timestamp: String,
    /// 关联的文件快照列表
    pub file_snapshots: Vec<LabelFileSnapshot>,
    /// 所属分支（空字符串表示旧数据/未知分支）
    #[serde(default)]
    pub branch: String,
}

// ============ 最近更改 ============

/// 最近变更条目（跨文件）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentChange {
    pub file_path: String,
    pub version_id: String,
    pub timestamp: String,
    pub size: u64,
    pub hash: String,
    pub label_name: Option<String>,
    /// 所属分支
    #[serde(default)]
    pub branch: String,
}

/// 跨 Worktree 最近变更条目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRecentChange {
    pub worktree_path: String,
    pub worktree_branch: String,
    pub is_main: bool,
    pub change: RecentChange,
}
