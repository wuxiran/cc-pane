use super::WorktreeService;
use crate::utils::{output_with_timeout, GIT_LOCAL_TIMEOUT};
use std::{
    fs,
    path::{Component, Path},
    process::Command,
};

impl WorktreeService {
    /// Fork the current checkout, including tracked edits and non-ignored new files.
    /// The source checkout and its index are never modified.
    pub fn fork_chat_worktree(&self, cwd: &str) -> Result<String, String> {
        let root = self.repo_root(cwd)?;
        let root = dunce::canonicalize(root).map_err(|e| e.to_string())?;
        let cwd = dunce::canonicalize(cwd).map_err(|e| e.to_string())?;
        let relative_cwd = cwd.strip_prefix(&root).map_err(|e| e.to_string())?;
        let patch = git(
            &root,
            &[
                "diff",
                "--binary",
                "--no-ext-diff",
                "--no-textconv",
                "HEAD",
                "--",
            ],
        )?;
        let untracked = git(&root, &["ls-files", "--others", "--exclude-standard", "-z"])?;
        let paths = std::str::from_utf8(&untracked)
            .map_err(|_| "Non-UTF-8 untracked path")?
            .split('\0')
            .filter(|p| !p.is_empty())
            .collect::<Vec<_>>();
        let name = format!("chat-{}", uuid::Uuid::new_v4());
        let branch = format!("fork/{name}");
        let target = self.add_worktree(
            root.to_str().ok_or("Non-UTF-8 repository path")?,
            &name,
            Some(&branch),
        )?;
        let result = copy_checkout(&root, Path::new(&target), &patch, &paths).and_then(|_| {
            let destination = Path::new(&target).join(relative_cwd);
            if !destination.is_dir() {
                return Err("Fork working directory was not copied".into());
            }
            Ok(destination.to_string_lossy().into_owned())
        });
        if result.is_err() {
            // This checkout was just created by us and no session has been launched.
            let cleanup = git(&root, &["worktree", "remove", "--force", "--", &target]);
            if cleanup.is_ok() {
                git(&root, &["branch", "-D", "--", &branch]).map_err(|error| {
                    format!("Fork failed and branch {branch} could not be removed: {error}")
                })?;
            }
            if let Err(error) = cleanup {
                return Err(format!(
                    "{}; could not remove failed fork at {target}: {error}",
                    result.unwrap_err()
                ));
            }
        }
        result
    }
}

fn git(root: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let output = output_with_timeout(
        Command::new("git").args(args).current_dir(root),
        GIT_LOCAL_TIMEOUT,
    )
    .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().into());
    }
    Ok(output.stdout)
}

fn copy_checkout(
    root: &Path,
    target: &Path,
    patch: &[u8],
    untracked: &[&str],
) -> Result<(), String> {
    if !patch.is_empty() {
        let patch_file = target.join(format!(".ccpanes-fork-{}.patch", uuid::Uuid::new_v4()));
        fs::write(&patch_file, patch).map_err(|e| e.to_string())?;
        let applied = git(
            target,
            &[
                "apply",
                "--binary",
                "--",
                patch_file.to_str().ok_or("Non-UTF-8 patch path")?,
            ],
        );
        fs::remove_file(&patch_file).map_err(|e| format!("Failed to remove fork patch: {e}"))?;
        applied?;
    }
    for relative in untracked {
        let path = Path::new(relative);
        if path
            .components()
            .any(|p| !matches!(p, Component::Normal(_)))
        {
            return Err("Invalid untracked path".into());
        }
        let source = root.join(path);
        let destination = target.join(path);
        let metadata = fs::symlink_metadata(&source).map_err(|e| e.to_string())?;
        if !metadata.is_file() {
            return Err(format!(
                "Cannot copy non-regular untracked file: {relative}"
            ));
        }
        let mut parent = target.to_path_buf();
        for part in path.parent().into_iter().flat_map(Path::components) {
            parent.push(part);
            if fs::symlink_metadata(&parent).is_ok_and(|m| m.file_type().is_symlink()) {
                return Err(format!(
                    "Fork destination contains a symbolic link: {relative}"
                ));
            }
            fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
        }
        if fs::symlink_metadata(&destination).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(format!("Fork destination is a symbolic link: {relative}"));
        }
        fs::copy(source, destination).map_err(|e| e.to_string())?;
    }
    Ok(())
}
