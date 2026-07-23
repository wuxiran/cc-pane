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
