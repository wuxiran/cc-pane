use super::{resolve_base_commit, WorktreeService};
use crate::utils::{output_with_timeout, GIT_LOCAL_TIMEOUT};
use std::path::Path;
use std::process::Command;

impl WorktreeService {
    /// New-session launches preserve the selected project directory inside a repository.
    /// Check the pinned tree before creation, so a missing project cannot silently open
    /// the repository root or leave a worktree that the launch cannot use.
    pub fn prepare_session_worktree(
        &self,
        cwd: &str,
        name: &str,
        branch: &str,
        base_ref: Option<&str>,
    ) -> Result<String, String> {
        let repo = dunce::canonicalize(self.repo_root(cwd)?)
            .map_err(|error| format!("Failed to resolve repository directory: {error}"))?;
        let source = dunce::canonicalize(cwd)
            .map_err(|error| format!("Failed to resolve session directory: {error}"))?;
        if !source.is_dir() {
            return Err("Session working directory must be a directory".into());
        }
        let relative = source
            .strip_prefix(&repo)
            .map_err(|_| "Session working directory is outside the repository".to_string())?;
        let commit = resolve_base_commit(&repo, base_ref.unwrap_or("HEAD"))?;
        ensure_project_in_commit(&repo, &commit, relative)?;
        let target = self.add_worktree_from_ref(cwd, name, Some(branch), Some(&commit))?;
        let target = dunce::canonicalize(target)
            .map_err(|error| format!("Failed to resolve created worktree: {error}"))?;
        let launch_cwd = dunce::canonicalize(target.join(relative)).map_err(|error| {
            format!("Project directory is unavailable in the created worktree: {error}")
        })?;
        if !launch_cwd.is_dir() || !launch_cwd.starts_with(&target) {
            return Err("Project directory is outside the created worktree".into());
        }
        Ok(launch_cwd.to_string_lossy().into_owned())
    }
}

fn ensure_project_in_commit(repo: &Path, commit: &str, relative: &Path) -> Result<(), String> {
    if relative.as_os_str().is_empty() {
        return Ok(());
    }
    let path = relative
        .components()
        .map(|part| {
            part.as_os_str()
                .to_str()
                .ok_or("Project path is not valid UTF-8")
        })
        .collect::<Result<Vec<_>, _>>()?
        .join("/");
    let object = format!("{commit}:{path}");
    let output = output_with_timeout(
        Command::new("git")
            .args(["cat-file", "-t", &object])
            .current_dir(repo),
        GIT_LOCAL_TIMEOUT,
    )
    .map_err(|error| format!("Failed to check project in selected base: {error}"))?;
    if !output.status.success() || String::from_utf8_lossy(&output.stdout).trim() != "tree" {
        return Err(format!("Project directory '{path}' does not exist in the selected base commit; choose a base that contains this project"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(repo: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(repo)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn fixture() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]);
        std::fs::write(repo.join("root.txt"), "root").unwrap();
        git(&repo, &["add", "."]);
        git(
            &repo,
            &[
                "-c",
                "user.name=test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-m",
                "root",
            ],
        );
        git(&repo, &["branch", "before-project"]);
        std::fs::create_dir_all(repo.join("packages/app with space")).unwrap();
        std::fs::write(repo.join("packages/app with space/file.txt"), "project").unwrap();
        git(&repo, &["add", "."]);
        git(
            &repo,
            &[
                "-c",
                "user.name=test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-m",
                "project",
            ],
        );
        (dir, repo)
    }

    #[test]
    fn session_launch_preserves_nested_cwd_in_new_worktree() {
        let (_guard, repo) = fixture();
        let source = repo.join("packages/app with space");
        std::fs::write(source.join("file.txt"), "dirty original").unwrap();
        let cwd = WorktreeService::new()
            .prepare_session_worktree(
                source.to_str().unwrap(),
                "task",
                "cc/task",
                Some("refs/heads/main"),
            )
            .unwrap();
        assert!(Path::new(&cwd).ends_with("packages/app with space"));
        assert_eq!(
            std::fs::read_to_string(Path::new(&cwd).join("file.txt")).unwrap(),
            "project"
        );
        assert_eq!(
            std::fs::read_to_string(source.join("file.txt")).unwrap(),
            "dirty original"
        );
        assert_eq!(git(&repo, &["branch", "--show-current"]), "main");
    }

    #[test]
    fn missing_project_in_base_fails_before_creating_worktree() {
        let (guard, repo) = fixture();
        let source = repo.join("packages/app with space");
        let error = WorktreeService::new()
            .prepare_session_worktree(
                source.to_str().unwrap(),
                "task",
                "cc/task",
                Some("before-project"),
            )
            .unwrap_err();
        assert!(error.contains("does not exist in the selected base"));
        assert!(!guard.path().join("repo-worktrees").exists());
        assert!(git(&repo, &["branch", "--list", "cc/task"]).is_empty());
    }
}
