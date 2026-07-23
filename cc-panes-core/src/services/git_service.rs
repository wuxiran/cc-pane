use crate::models::{GitChangeStatus, GitChangedFile, GitRepoInfo, GitRepoState};
use crate::utils::{
    normalize_project_path, output_with_timeout, output_with_timeout_limit, paths_equivalent,
    GIT_LOCAL_TIMEOUT,
};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output};

const GIT_BLOB_METADATA_LIMIT: usize = 64 * 1024;

#[derive(Default)]
pub struct GitService;

struct RepoContext {
    repo_root: PathBuf,
    scope: Option<PathBuf>,
}

impl GitService {
    pub fn new() -> Self {
        Self
    }

    pub fn discover_repo_root(path: &Path) -> Result<PathBuf, GitRepoState> {
        if !path.exists() || !path.is_dir() {
            return Err(GitRepoState::PathNotFound);
        }
        let output = output_with_timeout(
            Command::new("git")
                .args(["rev-parse", "--show-toplevel"])
                .current_dir(path),
            GIT_LOCAL_TIMEOUT,
        )
        .map_err(|error| GitRepoState::GitError {
            message: format!("Failed to execute git rev-parse: {error}"),
        })?;
        if !output.status.success() {
            return Err(GitRepoState::NotARepo);
        }
        let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if root.is_empty() {
            return Err(GitRepoState::GitError {
                message: "Git returned an empty repository root".to_string(),
            });
        }
        Ok(normalize_project_path(root))
    }

    pub fn repo_info(&self, path: &Path) -> GitRepoInfo {
        let context = match Self::repo_context(path) {
            Ok(context) => context,
            Err(state) => return GitRepoInfo::failure(state),
        };
        let branch = match Self::branch_at(&context.repo_root) {
            Ok(branch) => branch,
            Err(message) => {
                return GitRepoInfo::failure(GitRepoState::GitError { message });
            }
        };
        let files = match Self::status_at(&context) {
            Ok(files) => files,
            Err(message) => {
                return GitRepoInfo::failure(GitRepoState::GitError { message });
            }
        };
        GitRepoInfo {
            state: GitRepoState::Ok,
            repo_root: Some(context.repo_root.to_string_lossy().to_string()),
            branch,
            has_changes: Some(!files.is_empty()),
        }
    }

    pub fn get_branch_compat(&self, path: &Path) -> Result<Option<String>, String> {
        let root = match Self::discover_repo_root(path) {
            Ok(root) => root,
            Err(GitRepoState::PathNotFound | GitRepoState::NotARepo) => return Ok(None),
            Err(_) => return Err("Failed to discover Git repository".to_string()),
        };
        Self::branch_at(&root)
    }

    pub fn get_status_compat(&self, path: &Path) -> Result<Option<bool>, String> {
        let context = match Self::repo_context(path) {
            Ok(context) => context,
            Err(GitRepoState::PathNotFound | GitRepoState::NotARepo) => return Ok(None),
            Err(_) => return Err("Failed to discover Git repository".to_string()),
        };
        Self::status_at(&context).map(|files| Some(!files.is_empty()))
    }

    pub fn status_files(&self, path: &Path) -> Result<Vec<GitChangedFile>, String> {
        let context = Self::repo_context(path)
            .map_err(|state| format!("Git repository unavailable: {state:?}"))?;
        Self::status_at(&context)
    }

    pub fn get_file_statuses_compat(&self, path: &Path) -> Result<HashMap<String, String>, String> {
        let context = match Self::repo_context(path) {
            Ok(context) => context,
            Err(GitRepoState::PathNotFound | GitRepoState::NotARepo) => {
                return Ok(HashMap::new());
            }
            Err(_) => return Err("Failed to discover Git repository".to_string()),
        };
        let files = Self::status_at(&context)?;
        Ok(files
            .into_iter()
            .filter_map(|file| {
                let path = file.new_path.or(file.old_path)?;
                Some((
                    context.repo_root.join(path).to_string_lossy().to_string(),
                    file.status.legacy_name().to_string(),
                ))
            })
            .collect())
    }

    pub fn resolve_commit(&self, path: &Path, revision: &str) -> Result<String, String> {
        if revision.trim().is_empty() {
            return Err("Git revision cannot be empty".to_string());
        }
        let root = Self::discover_repo_root(path)
            .map_err(|state| format!("Git repository unavailable: {state:?}"))?;
        let revision = format!("{revision}^{{commit}}");
        let output = Self::run_git(
            &root,
            [
                OsStr::new("rev-parse"),
                OsStr::new("--verify"),
                OsStr::new("--end-of-options"),
                OsStr::new(&revision),
            ],
        )?;
        if !output.status.success() {
            return Err(Self::git_failure("Failed to resolve Git revision", &output));
        }
        let oid = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if oid.len() != 40 || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("Git returned an invalid commit object id".to_string());
        }
        Ok(oid)
    }

    pub fn validate_repo_relative_path(path: &Path) -> Result<(), String> {
        let text = path.to_string_lossy();
        let has_drive_prefix = text.as_bytes().get(1) == Some(&b':');
        if text.is_empty()
            || path.is_absolute()
            || text.starts_with('/')
            || text.starts_with('\\')
            || has_drive_prefix
            || text
                .split(['/', '\\'])
                .any(|part| part == ".." || part == ".")
            || path
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err(format!(
                "Git path must be a safe repository-relative path: {text}"
            ));
        }
        Ok(())
    }

    pub fn read_blob_at_commit(
        &self,
        path: &Path,
        revision: &str,
        relative_path: &Path,
        max_bytes: usize,
    ) -> Result<Vec<u8>, String> {
        Self::validate_repo_relative_path(relative_path)?;
        let root = Self::discover_repo_root(path)
            .map_err(|state| format!("Git repository unavailable: {state:?}"))?;
        let oid = self.resolve_commit(&root, revision)?;
        let git_path = relative_path.to_string_lossy().replace('\\', "/");
        let object = format!("{oid}:{git_path}");
        let size_output = Self::run_git_limited(
            &root,
            [
                OsStr::new("cat-file"),
                OsStr::new("-s"),
                OsStr::new(&object),
            ],
            GIT_BLOB_METADATA_LIMIT,
        )?;
        if !size_output.status.success() {
            return Err(Self::git_failure(
                "Failed to inspect Git blob",
                &size_output,
            ));
        }
        let size = String::from_utf8_lossy(&size_output.stdout)
            .trim()
            .parse::<usize>()
            .map_err(|_| "Git returned an invalid blob size".to_string())?;
        if size > max_bytes {
            return Err(format!(
                "Git blob size {size} exceeds the {max_bytes} byte limit"
            ));
        }
        let blob = Self::run_git_limited(
            &root,
            [
                OsStr::new("cat-file"),
                OsStr::new("blob"),
                OsStr::new(&object),
            ],
            max_bytes,
        )?;
        if !blob.status.success() {
            return Err(Self::git_failure("Failed to read Git blob", &blob));
        }
        Ok(blob.stdout)
    }

    fn repo_context(path: &Path) -> Result<RepoContext, GitRepoState> {
        let repo_root = Self::discover_repo_root(path)?;
        if paths_equivalent(path, &repo_root) {
            return Ok(RepoContext {
                repo_root,
                scope: None,
            });
        }

        let canonical_path = dunce::canonicalize(path).map_err(|error| GitRepoState::GitError {
            message: format!("Failed to canonicalize Git scope: {error}"),
        })?;
        let canonical_root =
            dunce::canonicalize(&repo_root).map_err(|error| GitRepoState::GitError {
                message: format!("Failed to canonicalize Git root: {error}"),
            })?;
        let scope = canonical_path
            .strip_prefix(&canonical_root)
            .map_err(|_| GitRepoState::GitError {
                message: "Registered project path escapes its Git repository".to_string(),
            })?
            .to_path_buf();
        Self::validate_repo_relative_path(&scope)
            .map_err(|message| GitRepoState::GitError { message })?;
        Ok(RepoContext {
            repo_root,
            scope: Some(scope),
        })
    }

    fn branch_at(repo_root: &Path) -> Result<Option<String>, String> {
        let output = Self::run_git(
            repo_root,
            [
                OsStr::new("rev-parse"),
                OsStr::new("--abbrev-ref"),
                OsStr::new("HEAD"),
            ],
        )?;
        if !output.status.success() {
            return Ok(None);
        }
        let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok((!branch.is_empty()).then_some(branch))
    }

    fn status_at(context: &RepoContext) -> Result<Vec<GitChangedFile>, String> {
        let mut command = Command::new("git");
        command
            .args([
                "-c",
                "core.quotepath=false",
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=normal",
                "--",
            ])
            .current_dir(&context.repo_root);
        if let Some(scope) = &context.scope {
            command.arg(scope);
        }
        let output = output_with_timeout(&mut command, GIT_LOCAL_TIMEOUT)
            .map_err(|error| format!("Failed to execute git status: {error}"))?;
        if !output.status.success() {
            return Err(Self::git_failure("git status failed", &output));
        }
        Self::parse_porcelain_v1_z(&output.stdout)
    }

    fn parse_porcelain_v1_z(bytes: &[u8]) -> Result<Vec<GitChangedFile>, String> {
        let mut result = Vec::new();
        let mut cursor = 0;
        while cursor < bytes.len() {
            let end = bytes[cursor..]
                .iter()
                .position(|byte| *byte == 0)
                .map(|offset| cursor + offset)
                .ok_or_else(|| "Malformed git status: missing NUL terminator".to_string())?;
            let entry = &bytes[cursor..end];
            cursor = end + 1;
            if entry.len() < 4 || entry[2] != b' ' {
                return Err("Malformed git status entry".to_string());
            }
            let x = entry[0];
            let y = entry[1];
            if x == b'!' && y == b'!' {
                continue;
            }
            let path = String::from_utf8_lossy(&entry[3..]).to_string();
            let status = Self::change_status(x, y);
            let (old_path, new_path) =
                if matches!(status, GitChangeStatus::Renamed | GitChangeStatus::Copied) {
                    let old_end = bytes[cursor..]
                        .iter()
                        .position(|byte| *byte == 0)
                        .map(|offset| cursor + offset)
                        .ok_or_else(|| {
                            "Malformed git rename status: missing old path".to_string()
                        })?;
                    let old = String::from_utf8_lossy(&bytes[cursor..old_end]).to_string();
                    cursor = old_end + 1;
                    (Some(old), Some(path))
                } else {
                    match status {
                        GitChangeStatus::Deleted => (Some(path), None),
                        GitChangeStatus::Added | GitChangeStatus::Untracked => (None, Some(path)),
                        _ => (Some(path.clone()), Some(path)),
                    }
                };
            result.push(GitChangedFile {
                status,
                old_path,
                new_path,
                old_mode: None,
                new_mode: None,
            });
        }
        Ok(result)
    }

    fn change_status(x: u8, y: u8) -> GitChangeStatus {
        if x == b'?' && y == b'?' {
            GitChangeStatus::Untracked
        } else if x == b'U' || y == b'U' || (x == b'A' && y == b'A') || (x == b'D' && y == b'D') {
            GitChangeStatus::Conflicted
        } else if x == b'R' || y == b'R' {
            GitChangeStatus::Renamed
        } else if x == b'C' || y == b'C' {
            GitChangeStatus::Copied
        } else if x == b'D' || y == b'D' {
            GitChangeStatus::Deleted
        } else if x == b'A' || y == b'A' {
            GitChangeStatus::Added
        } else if x == b'T' || y == b'T' {
            GitChangeStatus::TypeChanged
        } else {
            GitChangeStatus::Modified
        }
    }

    fn run_git<'a, I>(repo_root: &Path, args: I) -> Result<Output, String>
    where
        I: IntoIterator<Item = &'a OsStr>,
    {
        Self::run_git_limited(repo_root, args, crate::utils::GIT_MAX_OUTPUT_BYTES)
    }

    fn run_git_limited<'a, I>(
        repo_root: &Path,
        args: I,
        max_output_bytes: usize,
    ) -> Result<Output, String>
    where
        I: IntoIterator<Item = &'a OsStr>,
    {
        output_with_timeout_limit(
            Command::new("git").args(args).current_dir(repo_root),
            GIT_LOCAL_TIMEOUT,
            max_output_bytes,
        )
        .map_err(|error| format!("Failed to execute git command: {error}"))
    }

    fn git_failure(context: &str, output: &Output) -> String {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        if detail.is_empty() {
            context.to_string()
        } else {
            format!("{context}: {detail}")
        }
    }
}

mod c2;
