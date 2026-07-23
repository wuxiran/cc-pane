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
