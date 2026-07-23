use super::{GitService, RepoContext};
use crate::models::{
    DiffResult, DiffStats, DiffTruncationReason, GitChangeStatus, GitChangedFile, GitCommit,
    GitDiffSpec, GitLogPage, GitLogQuery,
};
use crate::repository::HistoryFileRepository;
use crate::utils::decode_text_lossy_gbk;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};

const LOG_FIELD_COUNT: usize = 8;

struct DiffContent {
    bytes: Vec<u8>,
    size: u64,
    too_large: bool,
}

impl DiffContent {
    fn empty() -> Self {
        Self {
            bytes: Vec::new(),
            size: 0,
            too_large: false,
        }
    }
}

impl GitService {
    pub fn get_log(&self, path: &Path, query: &GitLogQuery) -> Result<GitLogPage, String> {
        let context = Self::repo_context(path)
            .map_err(|state| format!("Git repository unavailable: {state:?}"))?;
        let revision = if let Some(branch) = query.branch.as_deref() {
            Some(self.resolve_local_branch(&context.repo_root, branch)?)
        } else {
            Self::try_resolve_head(&context.repo_root)?
        };
        let Some(revision) = revision else {
            return Ok(GitLogPage {
                commits: Vec::new(),
                has_more: false,
                next_offset: None,
            });
        };

        let limit = query.limit.clamp(1, 200);
        let fetch_count = limit.saturating_add(1);
        let mut args = vec![
            OsString::from("-c"),
            OsString::from("core.quotepath=false"),
            OsString::from("log"),
            OsString::from("-z"),
            OsString::from(format!("--max-count={fetch_count}")),
            OsString::from(format!("--skip={}", query.offset)),
            OsString::from("--format=%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00%D%x00%P"),
            OsString::from(revision),
        ];
        if let Some(pathspec) = Self::log_pathspec(&context, query.file.as_deref())? {
            args.push(OsString::from("--"));
            args.push(pathspec.into_os_string());
        }
        let output = Self::run_git(&context.repo_root, args.iter().map(OsString::as_os_str))?;
        if !output.status.success() {
            return Err(Self::git_failure("git log failed", &output));
        }
        let mut commits = Self::parse_log_output(&output.stdout)?;
        let has_more = commits.len() > limit;
        if has_more {
            commits.truncate(limit);
        }
        let next_offset = has_more.then_some(query.offset.saturating_add(commits.len()));
        Ok(GitLogPage {
            commits,
            has_more,
            next_offset,
        })
    }

    pub fn list_local_branches(&self, path: &Path) -> Result<Vec<String>, String> {
        let root = Self::discover_repo_root(path)
            .map_err(|state| format!("Git repository unavailable: {state:?}"))?;
        let output = Self::run_git(
            &root,
            [
                OsStr::new("for-each-ref"),
                OsStr::new("--sort=refname"),
                OsStr::new("--format=%(refname:short)"),
                OsStr::new("refs/heads"),
            ],
        )?;
        if !output.status.success() {
            return Err(Self::git_failure("Failed to list local branches", &output));
        }
        let text = decode_text_lossy_gbk(&output.stdout);
        Ok(text
            .lines()
            .map(str::trim)
            .filter(|branch| !branch.is_empty())
            .map(ToOwned::to_owned)
            .collect())
    }

    pub fn list_commit_files(
        &self,
        path: &Path,
        commit: &str,
        parent_index: Option<usize>,
    ) -> Result<Vec<GitChangedFile>, String> {
        let context = Self::repo_context(path)
            .map_err(|state| format!("Git repository unavailable: {state:?}"))?;
        let commit_oid = self.resolve_commit(&context.repo_root, commit)?;
        let parents = Self::commit_parents(&context.repo_root, &commit_oid)?;

        let mut args = vec![
            OsString::from("diff-tree"),
            OsString::from("--no-commit-id"),
            OsString::from("--raw"),
            OsString::from("-r"),
            OsString::from("-z"),
            OsString::from("-M"),
        ];
        if parents.is_empty() {
            if parent_index.unwrap_or(0) != 0 {
                return Err("Root commit has no selectable parent".to_string());
            }
            args.push(OsString::from("--root"));
        } else {
            let index = parent_index.unwrap_or(0);
            let parent = parents
                .get(index)
                .ok_or_else(|| format!("Commit parent index {index} is out of range"))?;
            args.push(OsString::from(parent));
        }
        args.push(OsString::from(&commit_oid));
        if let Some(scope) = context.scope {
            args.push(OsString::from("--"));
            args.push(scope.into_os_string());
        }
        let output = Self::run_git(&context.repo_root, args.iter().map(OsString::as_os_str))?;
        if !output.status.success() {
            return Err(Self::git_failure("Failed to list commit files", &output));
        }
        Self::parse_raw_diff(&output.stdout)
    }

    pub fn get_diff(&self, path: &Path, spec: &GitDiffSpec) -> Result<DiffResult, String> {
        let context = Self::repo_context(path)
            .map_err(|state| format!("Git repository unavailable: {state:?}"))?;
        let max_bytes = HistoryFileRepository::read_project_config(path)
            .map_err(|error| format!("Failed to read Local History config: {error}"))?
            .history
            .max_file_size;

        let (old, new) = match spec {
            GitDiffSpec::WorktreeVsHead { file } => {
                Self::validate_changed_file(&context, file)?;
                let head = Self::try_resolve_head(&context.repo_root)?;
                let old = match (head.as_deref(), file.old_path.as_deref()) {
                    (Some(oid), Some(file_path)) => {
                        Self::read_path_at_commit(&context.repo_root, oid, file_path, max_bytes)?
                    }
                    _ => DiffContent::empty(),
                };
                let new = match file.new_path.as_deref() {
                    Some(file_path) => {
                        Self::read_worktree_path(&context.repo_root, file_path, max_bytes)?
                    }
                    None => DiffContent::empty(),
                };
                (old, new)
            }
            GitDiffSpec::CommitVsCommit {
                old_rev,
                new_rev,
                file,
            } => {
                Self::validate_changed_file(&context, file)?;
                let old_oid = self.resolve_commit(&context.repo_root, old_rev)?;
                let new_oid = self.resolve_commit(&context.repo_root, new_rev)?;
                (
                    Self::read_optional_commit_path(
                        &context.repo_root,
                        &old_oid,
                        file.old_path.as_deref(),
                        max_bytes,
                    )?,
                    Self::read_optional_commit_path(
                        &context.repo_root,
                        &new_oid,
                        file.new_path.as_deref(),
                        max_bytes,
                    )?,
                )
            }
            GitDiffSpec::CommitVsParent {
                commit,
                parent_index,
                file,
            } => {
                Self::validate_changed_file(&context, file)?;
                let commit_oid = self.resolve_commit(&context.repo_root, commit)?;
                let parents = Self::commit_parents(&context.repo_root, &commit_oid)?;
                let old = if parents.is_empty() {
                    if parent_index.unwrap_or(0) != 0 {
                        return Err("Root commit has no selectable parent".to_string());
                    }
                    DiffContent::empty()
                } else {
                    let index = parent_index.unwrap_or(0);
                    let parent = parents
                        .get(index)
                        .ok_or_else(|| format!("Commit parent index {index} is out of range"))?;
                    Self::read_optional_commit_path(
                        &context.repo_root,
                        parent,
                        file.old_path.as_deref(),
                        max_bytes,
                    )?
                };
                let new = Self::read_optional_commit_path(
                    &context.repo_root,
                    &commit_oid,
                    file.new_path.as_deref(),
                    max_bytes,
                )?;
                (old, new)
            }
        };
        Ok(Self::diff_contents(old, new))
    }

    pub(super) fn parse_log_output(bytes: &[u8]) -> Result<Vec<GitCommit>, String> {
        if bytes.is_empty() {
            return Ok(Vec::new());
        }
        if bytes.last() != Some(&0) {
            return Err("Malformed git log output: missing final NUL".to_string());
        }
        let fields: Vec<&[u8]> = bytes[..bytes.len() - 1].split(|byte| *byte == 0).collect();
        if !fields.len().is_multiple_of(LOG_FIELD_COUNT) {
            return Err(format!(
                "Malformed git log output: expected {LOG_FIELD_COUNT} fields per record"
            ));
        }
        fields
            .chunks_exact(LOG_FIELD_COUNT)
            .map(|record| {
                let text = |index| decode_text_lossy_gbk(record[index]);
                let hash = text(0);
                if hash.len() != 40 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                    return Err("Malformed git log output: invalid commit hash".to_string());
                }
                Ok(GitCommit {
                    hash,
                    short_hash: text(1),
                    author: text(2),
                    author_email: text(3),
                    date: text(4),
                    subject: text(5),
                    refs: text(6),
                    parents: text(7)
                        .split_ascii_whitespace()
                        .map(ToOwned::to_owned)
                        .collect(),
                })
            })
            .collect()
    }

    fn resolve_local_branch(&self, root: &Path, branch: &str) -> Result<String, String> {
        let branch = branch.trim();
        if branch.is_empty() || branch.starts_with('-') {
            return Err("Local branch cannot be empty or start with '-'".to_string());
        }
        self.resolve_commit(root, &format!("refs/heads/{branch}"))
    }

    fn try_resolve_head(root: &Path) -> Result<Option<String>, String> {
        let revision = OsStr::new("HEAD^{commit}");
        let output = Self::run_git(
            root,
            [
                OsStr::new("rev-parse"),
                OsStr::new("--verify"),
                OsStr::new("--end-of-options"),
                revision,
            ],
        )?;
        if !output.status.success() {
            return Ok(None);
        }
        let oid = decode_text_lossy_gbk(&output.stdout).trim().to_string();
        if oid.len() != 40 || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("Git returned an invalid HEAD object id".to_string());
        }
        Ok(Some(oid))
    }

    fn log_pathspec(context: &RepoContext, file: Option<&str>) -> Result<Option<PathBuf>, String> {
        if let Some(file) = file {
            let path = PathBuf::from(file);
            Self::validate_repo_relative_path(&path)?;
            Self::validate_scope(context, &path)?;
            return Ok(Some(path));
        }
        Ok(context.scope.clone())
    }

    fn validate_scope(context: &RepoContext, path: &Path) -> Result<(), String> {
        if context
            .scope
            .as_ref()
            .is_some_and(|scope| !path.starts_with(scope))
        {
            return Err("Git path is outside the registered project scope".to_string());
        }
        Ok(())
    }

    fn validate_changed_file(context: &RepoContext, file: &GitChangedFile) -> Result<(), String> {
        if file.old_path.is_none() && file.new_path.is_none() {
            return Err("Git changed file has no old or new path".to_string());
        }
        for path in [file.old_path.as_deref(), file.new_path.as_deref()]
            .into_iter()
            .flatten()
        {
            let path = Path::new(path);
            Self::validate_repo_relative_path(path)?;
            Self::validate_scope(context, path)?;
        }
        Ok(())
    }

    fn commit_parents(root: &Path, oid: &str) -> Result<Vec<String>, String> {
        let output = Self::run_git(
            root,
            [
                OsStr::new("show"),
                OsStr::new("-s"),
                OsStr::new("--format=%P"),
                OsStr::new(oid),
            ],
        )?;
        if !output.status.success() {
            return Err(Self::git_failure(
                "Failed to inspect commit parents",
                &output,
            ));
        }
        Ok(decode_text_lossy_gbk(&output.stdout)
            .split_ascii_whitespace()
            .map(ToOwned::to_owned)
            .collect())
    }

    fn parse_raw_diff(bytes: &[u8]) -> Result<Vec<GitChangedFile>, String> {
        let mut files = Vec::new();
        let mut cursor = 0;
        while cursor < bytes.len() {
            let metadata = Self::take_nul_field(bytes, &mut cursor, "raw metadata")?;
            let metadata = std::str::from_utf8(metadata)
                .map_err(|_| "Malformed git raw diff metadata".to_string())?;
            let parts: Vec<&str> = metadata.split_ascii_whitespace().collect();
            if parts.len() != 5 || !parts[0].starts_with(':') {
                return Err("Malformed git raw diff metadata".to_string());
            }
            let old_mode = parts[0].trim_start_matches(':').to_string();
            let new_mode = parts[1].to_string();
            let status_code = parts[4]
                .as_bytes()
                .first()
                .copied()
                .ok_or_else(|| "Malformed git raw diff status".to_string())?;
            let first_path =
                decode_text_lossy_gbk(Self::take_nul_field(bytes, &mut cursor, "raw path")?);
            let status = match status_code {
                b'A' => GitChangeStatus::Added,
                b'D' => GitChangeStatus::Deleted,
                b'R' => GitChangeStatus::Renamed,
                b'C' => GitChangeStatus::Copied,
                b'T' => GitChangeStatus::TypeChanged,
                b'U' => GitChangeStatus::Conflicted,
                _ => GitChangeStatus::Modified,
            };
            let (old_path, new_path) = match status {
                GitChangeStatus::Added => (None, Some(first_path)),
                GitChangeStatus::Deleted => (Some(first_path), None),
                GitChangeStatus::Renamed | GitChangeStatus::Copied => {
                    let second_path = decode_text_lossy_gbk(Self::take_nul_field(
                        bytes,
                        &mut cursor,
                        "rename path",
                    )?);
                    (Some(first_path), Some(second_path))
                }
                _ => (Some(first_path.clone()), Some(first_path)),
            };
            files.push(GitChangedFile {
                status,
                old_path,
                new_path,
                old_mode: Some(old_mode),
                new_mode: Some(new_mode),
            });
        }
        Ok(files)
    }

    fn take_nul_field<'a>(
        bytes: &'a [u8],
        cursor: &mut usize,
        field: &str,
    ) -> Result<&'a [u8], String> {
        let end = bytes[*cursor..]
            .iter()
            .position(|byte| *byte == 0)
            .map(|offset| *cursor + offset)
            .ok_or_else(|| format!("Malformed git output: missing NUL after {field}"))?;
        let value = &bytes[*cursor..end];
        *cursor = end + 1;
        Ok(value)
    }

    fn read_optional_commit_path(
        root: &Path,
        oid: &str,
        path: Option<&str>,
        max_bytes: u64,
    ) -> Result<DiffContent, String> {
        match path {
            Some(path) => Self::read_path_at_commit(root, oid, path, max_bytes),
            None => Ok(DiffContent::empty()),
        }
    }

    fn read_path_at_commit(
        root: &Path,
        oid: &str,
        path: &str,
        max_bytes: u64,
    ) -> Result<DiffContent, String> {
        let args = [
            OsStr::new("ls-tree"),
            OsStr::new("-z"),
            OsStr::new(oid),
            OsStr::new("--"),
            OsStr::new(path),
        ];
        let tree = Self::run_git(root, args)?;
        if !tree.status.success() {
            return Err(Self::git_failure("Failed to inspect Git path", &tree));
        }
        if tree.stdout.is_empty() {
            return Ok(DiffContent::empty());
        }
        let record = tree.stdout.strip_suffix(&[0]).unwrap_or(&tree.stdout);
        let tab = record
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or_else(|| "Malformed git ls-tree output".to_string())?;
        let metadata = std::str::from_utf8(&record[..tab])
            .map_err(|_| "Malformed git ls-tree metadata".to_string())?;
        let parts: Vec<&str> = metadata.split_ascii_whitespace().collect();
        if parts.len() != 3 {
            return Err("Malformed git ls-tree metadata".to_string());
        }
        let mode = parts[0];
        let object = parts[2];
        if mode == "160000" {
            let bytes = format!("Subproject commit {object}\n").into_bytes();
            let size = bytes.len() as u64;
            return Ok(DiffContent {
                bytes: if size <= max_bytes { bytes } else { Vec::new() },
                size,
                too_large: size > max_bytes,
            });
        }
        let size_output = Self::run_git(
            root,
            [OsStr::new("cat-file"), OsStr::new("-s"), OsStr::new(object)],
        )?;
        if !size_output.status.success() {
            return Err(Self::git_failure(
                "Failed to inspect Git blob",
                &size_output,
            ));
        }
        let size = decode_text_lossy_gbk(&size_output.stdout)
            .trim()
            .parse::<u64>()
            .map_err(|_| "Git returned an invalid blob size".to_string())?;
        if size > max_bytes {
            return Ok(DiffContent {
                bytes: Vec::new(),
                size,
                too_large: true,
            });
        }
        let blob = Self::run_git_limited(
            root,
            [
                OsStr::new("cat-file"),
                OsStr::new("blob"),
                OsStr::new(object),
            ],
            usize::try_from(max_bytes).unwrap_or(usize::MAX),
        )?;
        if !blob.status.success() {
            return Err(Self::git_failure("Failed to read Git blob", &blob));
        }
        Ok(DiffContent {
            bytes: blob.stdout,
            size,
            too_large: false,
        })
    }

    fn read_worktree_path(root: &Path, path: &str, max_bytes: u64) -> Result<DiffContent, String> {
        let relative = Path::new(path);
        Self::validate_repo_relative_path(relative)?;
        let full_path = root.join(relative);
        let canonical_root = dunce::canonicalize(root)
            .map_err(|error| format!("Failed to resolve Git repository root: {error}"))?;
        let parent = full_path
            .parent()
            .ok_or_else(|| format!("Worktree file has no parent directory: {path}"))?;
        let canonical_parent = dunce::canonicalize(parent)
            .map_err(|error| format!("Failed to resolve worktree file parent {path}: {error}"))?;
        if canonical_parent.strip_prefix(&canonical_root).is_err() {
            return Err(format!("Worktree file escapes the Git repository: {path}"));
        }
        let metadata = fs::symlink_metadata(&full_path)
            .map_err(|error| format!("Failed to inspect worktree file {path}: {error}"))?;
        let bytes = if metadata.file_type().is_symlink() {
            fs::read_link(&full_path)
                .map_err(|error| format!("Failed to read symlink {path}: {error}"))?
                .as_os_str()
                .as_encoded_bytes()
                .to_vec()
        } else if metadata.is_dir() {
            let output = Self::run_git(
                &full_path,
                [
                    OsStr::new("rev-parse"),
                    OsStr::new("--verify"),
                    OsStr::new("HEAD"),
                ],
            )?;
            if !output.status.success() {
                return Err(format!(
                    "Worktree path is a directory, not a submodule: {path}"
                ));
            }
            format!(
                "Subproject commit {}\n",
                decode_text_lossy_gbk(&output.stdout).trim()
            )
            .into_bytes()
        } else {
            let size = metadata.len();
            if size > max_bytes {
                return Ok(DiffContent {
                    bytes: Vec::new(),
                    size,
                    too_large: true,
                });
            }
            fs::read(&full_path)
                .map_err(|error| format!("Failed to read worktree file {path}: {error}"))?
        };
        let size = bytes.len() as u64;
        Ok(DiffContent {
            bytes: if size <= max_bytes { bytes } else { Vec::new() },
            size,
            too_large: size > max_bytes,
        })
    }

    fn diff_contents(old: DiffContent, new: DiffContent) -> DiffResult {
        if old.too_large || new.too_large {
            return DiffResult {
                hunks: Vec::new(),
                stats: DiffStats::default(),
                is_binary: false,
                truncated: true,
                truncation_reason: Some(DiffTruncationReason::FileSize),
                old_size: old.size,
                new_size: new.size,
            };
        }
        if HistoryFileRepository::is_binary(&old.bytes)
            || HistoryFileRepository::is_binary(&new.bytes)
        {
            return DiffResult {
                hunks: Vec::new(),
                stats: DiffStats::default(),
                is_binary: true,
                truncated: false,
                truncation_reason: None,
                old_size: old.size,
                new_size: new.size,
            };
        }
        let old_text = decode_text_lossy_gbk(&old.bytes);
        let new_text = decode_text_lossy_gbk(&new.bytes);
        let mut diff = HistoryFileRepository::compute_diff(&old_text, &new_text);
        diff.old_size = old.size;
        diff.new_size = new.size;
        diff
    }
}

#[cfg(test)]
mod tests {
    use super::GitService;

    #[test]
    fn malformed_fixed_width_log_record_is_rejected_as_a_whole() {
        let malformed = b"hash\0short\0author\0";
        assert!(GitService::parse_log_output(malformed).is_err());
    }
}
