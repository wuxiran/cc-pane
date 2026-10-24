use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum GitRepoState {
    Ok,
    PathNotFound,
    NotARepo,
    GitError { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoInfo {
    #[serde(flatten)]
    pub state: GitRepoState,
    pub repo_root: Option<String>,
    pub branch: Option<String>,
    pub has_changes: Option<bool>,
}

impl GitRepoInfo {
    pub fn failure(state: GitRepoState) -> Self {
        Self {
            state,
            repo_root: None,
            branch: None,
            has_changes: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GitChangeStatus {
    Modified,
    Added,
    Deleted,
    Untracked,
    Renamed,
    Copied,
    TypeChanged,
    Conflicted,
}

impl GitChangeStatus {
    pub fn legacy_name(self) -> &'static str {
        match self {
            Self::Modified => "modified",
            Self::Added => "added",
            Self::Deleted => "deleted",
            Self::Untracked => "untracked",
            Self::Renamed => "renamed",
            Self::Copied => "copied",
            Self::TypeChanged => "modified",
            Self::Conflicted => "modified",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitChangedFile {
    pub status: GitChangeStatus,
    pub old_path: Option<String>,
    pub new_path: Option<String>,
    #[serde(default)]
    pub old_mode: Option<String>,
    #[serde(default)]
    pub new_mode: Option<String>,
}

/// Immutable comparison endpoints for a branch review. Uncommitted files are
/// deliberately excluded and remain available through the working-tree scope.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchReview {
    pub base_commit: String,
    pub head_commit: String,
    pub files: Vec<GitChangedFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub author_email: String,
    pub date: String,
    pub subject: String,
    pub refs: String,
    pub parents: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitLogQuery {
    #[serde(default = "default_log_limit")]
    pub limit: usize,
    #[serde(default)]
    pub offset: usize,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub file: Option<String>,
}

const fn default_log_limit() -> usize {
    50
}

impl Default for GitLogQuery {
    fn default() -> Self {
        Self {
            limit: default_log_limit(),
            offset: 0,
            branch: None,
            file: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitLogPage {
    pub commits: Vec<GitCommit>,
    pub has_more: bool,
    pub next_offset: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum GitDiffSpec {
    WorktreeVsHead {
        file: GitChangedFile,
    },
    CommitVsCommit {
        old_rev: String,
        new_rev: String,
        file: GitChangedFile,
    },
    CommitVsParent {
        commit: String,
        #[serde(default)]
        parent_index: Option<usize>,
        file: GitChangedFile,
    },
}

/// 合并/变基进行中时，仓库的合并状态。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GitMergeState {
    /// 干净的仓库（没有进行中的合并/变基）。
    Clean,
    /// `git merge` 进行中（`MERGE_HEAD` 存在），可能伴随冲突。
    Merging,
    /// `git rebase` 进行中（`.git/rebase-merge` 或 `.git/rebase-apply` 存在）。
    Rebasing,
    /// cherry-pick / revert 进行中。
    CherryPicking,
}

/// 冲突文件在 git index 中的 stage 语义。
///
/// stage 1 = base（共同祖先），stage 2 = ours（HEAD 一侧），stage 3 = theirs（被合入一侧）。
/// add/add 冲突没有 base；delete/modify 冲突可能缺少 ours 或 theirs。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GitConflictStageKind {
    Base,
    Ours,
    Theirs,
}

/// 冲突文件的某个 stage（blob 版本）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitConflictStage {
    pub kind: GitConflictStageKind,
    /// git index stage 编号：1=base、2=ours、3=theirs。
    pub stage: u8,
    /// blob 对象 id。
    pub blob: String,
    /// 文件模式，如 "100644"。
    pub mode: String,
}

/// 一个处于未合并（unmerged）状态的文件。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitConflictFile {
    /// 相对仓库根的路径（git 风格正斜杠）。
    pub path: String,
    /// 工作区绝对路径（由仓库根拼接，便于前端直接展示/编辑）。
    pub absolute_path: String,
    /// 该文件在 index 中存在的 stage（已按 stage 升序）。
    pub stages: Vec<GitConflictStage>,
    /// 是否为二进制（内容冲突无法在文本编辑器里解决，只能整侧选用）。
    pub is_binary: bool,
}

/// 仓库当前的冲突总览。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitConflictSummary {
    /// 合并状态（是否正处于 merge/rebase/cherry-pick）。
    pub merge_state: GitMergeState,
    /// 是否存在未解决冲突（index 有 unmerged 项）。
    pub has_conflicts: bool,
    /// 未合并文件清单。
    pub files: Vec<GitConflictFile>,
    /// 正在合入的一侧的引用（`MERGE_HEAD` 等），便于 UI 标注 "theirs" 来自哪里。
    pub theirs_ref: Option<String>,
}

/// 单个 stage 的文本内容（可能因二进制/过大而不可用）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitConflictContent {
    /// 文本内容；`None` 表示该侧缺失、为二进制或超出大小上限。
    pub content: Option<String>,
    /// 内容字节数（原始 blob 大小）。
    pub size: usize,
    /// 是否为二进制。
    pub is_binary: bool,
    /// 是否因超过大小上限被降级为不可编辑（`content` 为 `None`）。
    pub too_large: bool,
}

/// 三栏冲突对比/编辑所需的全部版本。
///
/// `base` 在 add/add 冲突时缺失；`ours`/`theirs` 在 delete/modify 冲突时可能缺失。
/// `result` 是工作区当前内容（可能仍含冲突标记），作为中间可编辑栏的初值。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitConflictVersions {
    /// 相对仓库根的路径。
    pub path: String,
    /// 工作区绝对路径。
    pub absolute_path: String,
    /// 共同祖先（stage 1）。
    pub base: GitConflictContent,
    /// HEAD 一侧（stage 2）。
    pub ours: GitConflictContent,
    /// 被合入一侧（stage 3）。
    pub theirs: GitConflictContent,
    /// 工作区当前内容（中间栏初值，可能含 `<<<<<<<` 冲突标记）。
    pub result: GitConflictContent,
}

/// 解决一个冲突文件的请求。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitResolveConflictRequest {
    /// 项目路径或仓库根。
    pub path: String,
    /// 要解决的相对路径（必须仍在 unmerged 集合内，且做路径穿越校验）。
    pub file: String,
    /// 要写回工作区的最终内容（中间栏编辑结果）。
    pub content: String,
}

/// 解决冲突后的结果。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitResolveConflictResult {
    /// 被写回并暂存的文件相对路径。
    pub path: String,
    /// 是否已 `git add` 成功（暂存解决结果）。
    pub staged: bool,
    /// 仓库剩余未合并文件数（0 表示全部冲突已解决）。
    pub remaining_conflicts: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_info_flattens_state_and_git_error_message() {
        let info = GitRepoInfo::failure(GitRepoState::GitError {
            message: "broken index".to_string(),
        });
        let value = serde_json::to_value(info).unwrap();
        assert_eq!(value["state"], "gitError");
        assert_eq!(value["message"], "broken index");
        assert!(value.get("repoRoot").is_some());
    }
}
