//! Git 冲突解决服务（F3.2）。
//!
//! 提供三栏冲突解决所需后端能力：列出未合并文件、读取 base/ours/theirs/工作区
//! 四个版本、写回解决结果并 `git add` 暂存。所有 git 调用走 `output_with_timeout`
//! 路径（经 `GitService::run_git*`），二进制/超大文件诚实降级（不假装可文本解决）。

use super::GitService;
use crate::models::{
    GitConflictContent, GitConflictFile, GitConflictStage, GitConflictStageKind,
    GitConflictSummary, GitConflictVersions, GitMergeState, GitResolveConflictRequest,
    GitResolveConflictResult,
};
use crate::repository::HistoryFileRepository;
use crate::utils::decode_text_lossy_gbk;
use std::collections::{BTreeSet, HashMap};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};

/// 单个 stage 文本内容的读取上限（2 MiB）。超过则降级为不可编辑。
const CONFLICT_CONTENT_LIMIT: usize = 2 * 1024 * 1024;
/// `cat-file -s` 等元数据查询的输出上限。
const CONFLICT_META_LIMIT: usize = 64 * 1024;

/// `git ls-files -u --eol` 的一行解析结果（内部表示）。
struct RawStage {
    path: String,
    stage: u8,
    blob: String,
    mode: String,
    /// git 的 eol 启发式判定为二进制（`i/-text`）。
    binary: bool,
}

impl GitService {
    /// 列出仓库（或注册子目录 scope）内的冲突总览。
    pub fn list_conflicts(&self, path: &Path) -> Result<GitConflictSummary, String> {
        let context = Self::repo_context(path)
            .map_err(|state| format!("Git repository unavailable: {state:?}"))?;
        let merge_state = Self::merge_state_at(&context.repo_root);
        let theirs_ref = Self::theirs_ref_at(&context.repo_root);
        let raw = Self::unmerged_stages(&context.repo_root, context.scope.as_deref())?;
        let files = Self::group_conflict_files(&raw, &context.repo_root);
        Ok(GitConflictSummary {
            merge_state,
            has_conflicts: !files.is_empty(),
            files,
            theirs_ref,
        })
    }

    /// 读取单个冲突文件的 base/ours/theirs/工作区四个版本。
    pub fn conflict_versions(
        &self,
        path: &Path,
        file: &str,
    ) -> Result<GitConflictVersions, String> {
        let context = Self::repo_context(path)
            .map_err(|state| format!("Git repository unavailable: {state:?}"))?;
        let rel = Path::new(file);
        Self::validate_repo_relative_path(rel)?;
        let raw = Self::unmerged_file_stages(&context.repo_root, rel)?;
        if raw.is_empty() {
            return Err(format!("File is not in a conflicted state: {file}"));
        }
        let find = |stage: u8| raw.iter().find(|item| item.stage == stage);
        let base = Self::side_content(&context.repo_root, find(1))?;
        let ours = Self::side_content(&context.repo_root, find(2))?;
        let theirs = Self::side_content(&context.repo_root, find(3))?;
        let absolute = context.repo_root.join(rel);
        let result = Self::worktree_content(&absolute);
        Ok(GitConflictVersions {
            path: file.to_string(),
            absolute_path: absolute.to_string_lossy().to_string(),
            base,
            ours,
            theirs,
            result,
        })
    }

    /// 写回解决结果并 `git add` 暂存；返回剩余未合并文件数。
    pub fn resolve_conflict(
        &self,
        request: &GitResolveConflictRequest,
    ) -> Result<GitResolveConflictResult, String> {
        let context = Self::repo_context(Path::new(&request.path))
            .map_err(|state| format!("Git repository unavailable: {state:?}"))?;
        let rel = Path::new(&request.file);
        Self::validate_repo_relative_path(rel)?;
        let git_path = request.file.replace('\\', "/");
        let staged_now = Self::unmerged_file_stages(&context.repo_root, rel)?;
        if staged_now.is_empty() {
            return Err(format!(
                "File is not in a conflicted state: {}",
                request.file
            ));
        }
        let absolute = context.repo_root.join(rel);
        if let Some(parent) = absolute.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create parent directory: {error}"))?;
        }
        fs::write(&absolute, request.content.as_bytes())
            .map_err(|error| format!("Failed to write resolved file: {error}"))?;
        let output = Self::run_git(
            &context.repo_root,
            [
                OsStr::new("--literal-pathspecs"),
                OsStr::new("add"),
                OsStr::new("--"),
                OsStr::new(&git_path),
            ],
        )?;
        if !output.status.success() {
            return Err(Self::git_failure("git add failed", &output));
        }
        let remaining = Self::unmerged_stages(&context.repo_root, None)?;
        let remaining_conflicts = remaining
            .iter()
            .map(|item| item.path.as_str())
            .collect::<BTreeSet<_>>()
            .len();
        Ok(GitResolveConflictResult {
            path: request.file.clone(),
            staged: true,
            remaining_conflicts,
        })
    }

    /// A single file must not borrow conflicts from matching files or descendants.
    fn unmerged_file_stages(root: &Path, file: &Path) -> Result<Vec<RawStage>, String> {
        let git_path = file.to_string_lossy().replace('\\', "/");
        Ok(Self::unmerged_stages(root, Some(file))?
            .into_iter()
            .filter(|stage| stage.path == git_path)
            .collect())
    }

    /// 运行 `git ls-files -u -z --eol`（可选字面量 scope 路径）并解析。
    fn unmerged_stages(root: &Path, scope: Option<&Path>) -> Result<Vec<RawStage>, String> {
        let mut args: Vec<OsString> = [
            "-c",
            "core.quotepath=false",
            "--literal-pathspecs",
            "ls-files",
            "-u",
            "-z",
            "--eol",
        ]
        .iter()
        .map(OsString::from)
        .collect();
        if let Some(scope) = scope {
            args.push(OsString::from("--"));
            args.push(scope.as_os_str().to_os_string());
        }
        let output = Self::run_git(root, args.iter().map(OsString::as_os_str))?;
        if !output.status.success() {
            return Err(Self::git_failure("git ls-files failed", &output));
        }
        Ok(Self::parse_ls_files_unmerged(&output.stdout))
    }

    /// 解析 `git ls-files -u -z --eol` 输出。
    ///
    /// 记录形如 `<mode> <sha> <stage>\t<eolinfo>\t<path>\0`。head 与 eolinfo 不含 TAB，
    /// 故按 TAB 切分后第 3 段起重新以 TAB 连接即为 path（容忍路径内含 TAB）。
    fn parse_ls_files_unmerged(bytes: &[u8]) -> Vec<RawStage> {
        let mut stages = Vec::new();
        for record in bytes.split(|byte| *byte == 0) {
            if record.is_empty() {
                continue;
            }
            let text = String::from_utf8_lossy(record);
            let mut parts = text.split('\t');
            let Some(head) = parts.next() else { continue };
            let eolinfo = parts.next().unwrap_or("");
            let path = parts.collect::<Vec<_>>().join("\t");
            if path.is_empty() {
                continue;
            }
            let mut fields = head.split_whitespace();
            let mode = fields.next().unwrap_or("").to_string();
            let blob = fields.next().unwrap_or("").to_string();
            let Some(stage) = fields.next().and_then(|value| value.parse::<u8>().ok()) else {
                continue;
            };
            stages.push(RawStage {
                path,
                stage,
                blob,
                mode,
                binary: eolinfo.contains("i/-text"),
            });
        }
        stages
    }

    /// 把扁平 stage 列表按路径聚合为 `GitConflictFile`，stage 升序，二进制取各 stage 或。
    fn group_conflict_files(raw: &[RawStage], repo_root: &Path) -> Vec<GitConflictFile> {
        let mut files: Vec<GitConflictFile> = Vec::new();
        let mut index: HashMap<String, usize> = HashMap::new();
        for stage in raw {
            let slot = *index.entry(stage.path.clone()).or_insert_with(|| {
                files.push(GitConflictFile {
                    path: stage.path.clone(),
                    absolute_path: repo_root.join(&stage.path).to_string_lossy().to_string(),
                    stages: Vec::new(),
                    is_binary: stage.binary,
                });
                files.len() - 1
            });
            if stage.binary {
                files[slot].is_binary = true;
            }
            let Some(kind) = Self::stage_kind(stage.stage) else {
                continue;
            };
            files[slot].stages.push(GitConflictStage {
                kind,
                stage: stage.stage,
                blob: stage.blob.clone(),
                mode: stage.mode.clone(),
            });
        }
        for file in &mut files {
            file.stages.sort_by_key(|item| item.stage);
        }
        files
    }

    fn stage_kind(stage: u8) -> Option<GitConflictStageKind> {
        match stage {
            1 => Some(GitConflictStageKind::Base),
            2 => Some(GitConflictStageKind::Ours),
            3 => Some(GitConflictStageKind::Theirs),
            _ => None,
        }
    }

    /// 读取某一侧（base/ours/theirs）内容；缺失侧返回默认（content=None, size=0）。
    fn side_content(root: &Path, stage: Option<&RawStage>) -> Result<GitConflictContent, String> {
        let Some(stage) = stage else {
            return Ok(GitConflictContent::default());
        };
        let size = Self::blob_size(root, &stage.blob)?;
        if stage.binary {
            return Ok(GitConflictContent {
                content: None,
                size,
                is_binary: true,
                too_large: false,
            });
        }
        if size > CONFLICT_CONTENT_LIMIT {
            return Ok(GitConflictContent {
                content: None,
                size,
                is_binary: false,
                too_large: true,
            });
        }
        let bytes = Self::read_blob(root, &stage.blob)?;
        Ok(GitConflictContent {
            content: Some(decode_text_lossy_gbk(&bytes)),
            size,
            is_binary: false,
            too_large: false,
        })
    }

    /// 读取工作区当前内容（中间栏初值，可能含冲突标记）。文件缺失返回默认。
    fn worktree_content(absolute: &Path) -> GitConflictContent {
        let Ok(bytes) = fs::read(absolute) else {
            return GitConflictContent::default();
        };
        let size = bytes.len();
        if HistoryFileRepository::is_binary(&bytes) {
            return GitConflictContent {
                content: None,
                size,
                is_binary: true,
                too_large: false,
            };
        }
        if size > CONFLICT_CONTENT_LIMIT {
            return GitConflictContent {
                content: None,
                size,
                is_binary: false,
                too_large: true,
            };
        }
        GitConflictContent {
            content: Some(decode_text_lossy_gbk(&bytes)),
            size,
            is_binary: false,
            too_large: false,
        }
    }

    fn blob_size(root: &Path, oid: &str) -> Result<usize, String> {
        let output = Self::run_git_limited(
            root,
            [OsStr::new("cat-file"), OsStr::new("-s"), OsStr::new(oid)],
            CONFLICT_META_LIMIT,
        )?;
        if !output.status.success() {
            return Err(Self::git_failure(
                "Failed to inspect conflict blob",
                &output,
            ));
        }
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse::<usize>()
            .map_err(|_| "Git returned an invalid blob size".to_string())
    }

    fn read_blob(root: &Path, oid: &str) -> Result<Vec<u8>, String> {
        let output = Self::run_git_limited(
            root,
            [OsStr::new("cat-file"), OsStr::new("blob"), OsStr::new(oid)],
            CONFLICT_CONTENT_LIMIT,
        )?;
        if !output.status.success() {
            return Err(Self::git_failure("Failed to read conflict blob", &output));
        }
        Ok(output.stdout)
    }

    /// 探测合并状态：rebase > cherry-pick/revert > merge > clean。
    fn merge_state_at(root: &Path) -> GitMergeState {
        let Ok(git_dir) = Self::absolute_git_dir(root) else {
            return GitMergeState::Clean;
        };
        if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
            return GitMergeState::Rebasing;
        }
        if git_dir.join("CHERRY_PICK_HEAD").exists() || git_dir.join("REVERT_HEAD").exists() {
            return GitMergeState::CherryPicking;
        }
        if git_dir.join("MERGE_HEAD").exists() {
            return GitMergeState::Merging;
        }
        GitMergeState::Clean
    }

    /// 正在合入一侧的引用名（仅 merge 时有）；优先 `name-rev`，回退短 SHA。
    fn theirs_ref_at(root: &Path) -> Option<String> {
        let git_dir = Self::absolute_git_dir(root).ok()?;
        if !git_dir.join("MERGE_HEAD").exists() {
            return None;
        }
        if let Ok(output) = Self::run_git(
            root,
            [
                OsStr::new("name-rev"),
                OsStr::new("--name-only"),
                OsStr::new("MERGE_HEAD"),
            ],
        ) {
            if output.status.success() {
                let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !name.is_empty() && !name.contains("undefined") {
                    return Some(name);
                }
            }
        }
        Self::run_git(
            root,
            [
                OsStr::new("rev-parse"),
                OsStr::new("--short"),
                OsStr::new("MERGE_HEAD"),
            ],
        )
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|name| !name.is_empty())
    }

    fn absolute_git_dir(root: &Path) -> Result<PathBuf, String> {
        let output = Self::run_git(
            root,
            [OsStr::new("rev-parse"), OsStr::new("--absolute-git-dir")],
        )?;
        if !output.status.success() {
            return Err(Self::git_failure("Failed to resolve git dir", &output));
        }
        Ok(PathBuf::from(
            String::from_utf8_lossy(&output.stdout).trim(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::GitService;

    /// `ls-files -u --eol -z` 解析：mode/sha/stage + eolinfo 二进制判定 + path（含 TAB 容忍）。
    #[test]
    fn parse_unmerged_extracts_stages_and_binary_flag() {
        let blob = "100644 aaa 1\ti/lf    w/lf    attr/                 \ttext.txt\0\
                    100644 bbb 2\ti/-text w/-text attr/-text            \tbin.dat\0\
                    100644 ccc 3\ti/lf    w/lf    attr/                 \tweird\tname.txt\0";
        let parsed = GitService::parse_ls_files_unmerged(blob.as_bytes());
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].path, "text.txt");
        assert_eq!(parsed[0].stage, 1);
        assert_eq!(parsed[0].blob, "aaa");
        assert_eq!(parsed[0].mode, "100644");
        assert!(!parsed[0].binary);
        assert!(parsed[1].binary, "i/-text must be flagged binary");
        assert_eq!(parsed[1].path, "bin.dat");
        // 路径内含 TAB：第 3 段起以 TAB 重连。
        assert_eq!(parsed[2].path, "weird\tname.txt");
    }

    #[test]
    fn parse_unmerged_skips_malformed_records() {
        // `concat!` 拼接避免 `\0` 紧跟数字被解析成八进制转义。
        let blob = concat!("\0\0not-a-record\0", "100644 aaa\0");
        let parsed = GitService::parse_ls_files_unmerged(blob.as_bytes());
        assert!(parsed.is_empty(), "records without stage/path are skipped");
    }

    /// add/add（无 base）：聚合后 stage 仅含 ours/theirs，升序。
    #[test]
    fn group_handles_add_add_without_base() {
        let raw = vec![
            super::RawStage {
                path: "f.txt".into(),
                stage: 2,
                blob: "o".into(),
                mode: "100644".into(),
                binary: false,
            },
            super::RawStage {
                path: "f.txt".into(),
                stage: 3,
                blob: "t".into(),
                mode: "100644".into(),
                binary: false,
            },
        ];
        let files = GitService::group_conflict_files(&raw, std::path::Path::new("/repo"));
        assert_eq!(files.len(), 1);
        let stages = &files[0].stages;
        assert_eq!(stages.len(), 2);
        assert_eq!(stages[0].stage, 2);
        assert_eq!(stages[1].stage, 3);
        assert!(!files[0].is_binary);
    }

    /// 任一 stage 二进制 → 文件标记二进制。
    #[test]
    fn group_marks_binary_if_any_stage_binary() {
        let raw = vec![
            super::RawStage {
                path: "f".into(),
                stage: 2,
                blob: "o".into(),
                mode: "100644".into(),
                binary: false,
            },
            super::RawStage {
                path: "f".into(),
                stage: 3,
                blob: "t".into(),
                mode: "100644".into(),
                binary: true,
            },
        ];
        let files = GitService::group_conflict_files(&raw, std::path::Path::new("/repo"));
        assert!(files[0].is_binary);
    }
}
