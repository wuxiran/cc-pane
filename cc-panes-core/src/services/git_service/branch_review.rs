use super::GitService;
use crate::models::GitBranchReview;
use std::ffi::{OsStr, OsString};
use std::path::Path;

impl GitService {
    /// Resolve both revisions once so later per-file reads use the same commits,
    /// even if a branch moves while the user is inspecting the review.
    pub fn branch_review(&self, path: &Path, base_ref: &str) -> Result<GitBranchReview, String> {
        if base_ref.len() > 1024 || base_ref.trim().is_empty() {
            return Err("A valid comparison branch or commit is required".into());
        }
        let context = Self::repo_context(path)
            .map_err(|state| format!("Git repository unavailable: {state:?}"))?;
        let head_commit = self.resolve_commit(&context.repo_root, "HEAD")?;
        let base_tip = self.resolve_commit(&context.repo_root, base_ref)?;
        let base_commit = Self::review_merge_base(&context.repo_root, &base_tip, &head_commit)?;
        let mut args: Vec<OsString> = [
            "--literal-pathspecs",
            "diff-tree",
            "--no-commit-id",
            "--raw",
            "-r",
            "-z",
            "-M",
        ]
        .into_iter()
        .map(OsString::from)
        .collect();
        args.extend([
            OsString::from(&base_commit),
            OsString::from(&head_commit),
            OsString::from("--"),
        ]);
        if let Some(scope) = context.scope {
            args.push(scope.into_os_string());
        }
        let output = Self::run_git(&context.repo_root, args.iter().map(OsString::as_os_str))?;
        if !output.status.success() {
            return Err(Self::git_failure("Failed to list branch changes", &output));
        }
        Ok(GitBranchReview {
            base_commit,
            head_commit,
            files: Self::parse_raw_diff(&output.stdout)?,
        })
    }

    fn review_merge_base(root: &Path, base: &str, head: &str) -> Result<String, String> {
        let output = Self::run_git(root, ["merge-base", "--all", base, head].map(OsStr::new))?;
        if !output.status.success() {
            return Err(Self::git_failure(
                "The selected branches have no common ancestor",
                &output,
            ));
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let bases: Vec<_> = text.split_whitespace().collect();
        if bases.len() != 1 {
            return Err("The selected branches have multiple merge bases; select an explicit common ancestor".into());
        }
        let oid = bases[0];
        if oid.len() != 40 || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("Git returned an invalid merge-base object id".into());
        }
        Ok(oid.to_string())
    }
}
