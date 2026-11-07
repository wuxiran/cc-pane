//! 资源库访问上游的唯一出口。抽成 trait 是为了测试不联网（见 `tests.rs` 的假实现）。

use crate::services::skill_repo_fetcher::{RemoteError, RepoListing, RepoRef, SkillRepoFetcher};
use crate::utils::no_window_tokio_command;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

pub type RemoteFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, RemoteError>> + Send + 'a>>;

const GIT_CLONE_TIMEOUT: Duration = Duration::from_secs(120);
const GIT_LS_REMOTE_TIMEOUT: Duration = Duration::from_secs(30);
const GIT_LOCAL_TIMEOUT: Duration = Duration::from_secs(15);

pub trait SkillRemote: Send + Sync {
    /// 完整列出仓库文件（GitHub tree API，失败时退到 jsDelivr 镜像）。
    fn github_list<'a>(
        &'a self,
        repo: &'a RepoRef,
        git_ref: Option<&'a str>,
    ) -> RemoteFuture<'a, RepoListing>;

    fn github_fetch<'a>(
        &'a self,
        repo: &'a RepoRef,
        listing: &'a RepoListing,
        path: &'a str,
    ) -> RemoteFuture<'a, Vec<u8>>;

    /// 最后改动 `path` 的提交（`GET /repos/{o}/{r}/commits?path=&sha=&per_page=1`）。
    fn github_latest_commit<'a>(
        &'a self,
        repo: &'a RepoRef,
        path: &'a str,
        git_ref: Option<&'a str>,
    ) -> RemoteFuture<'a, Option<String>>;

    /// `git ls-remote`：`git_ref` 缺省为 HEAD，返回提交 sha。
    fn git_ls_remote<'a>(
        &'a self,
        url: &'a str,
        git_ref: Option<&'a str>,
    ) -> RemoteFuture<'a, String>;

    /// `git clone --depth 1` 到 `dest`（不存在的目录），返回 HEAD sha。
    fn git_clone<'a>(
        &'a self,
        url: &'a str,
        git_ref: Option<&'a str>,
        dest: &'a Path,
    ) -> RemoteFuture<'a, String>;
}

/// 真实实现：GitHub 走 `SkillRepoFetcher`，其他 git 走用户本机的 `git`。
pub struct DefaultSkillRemote {
    fetcher: Arc<SkillRepoFetcher>,
}

impl DefaultSkillRemote {
    pub fn new(fetcher: Arc<SkillRepoFetcher>) -> Self {
        Self { fetcher }
    }
}

impl SkillRemote for DefaultSkillRemote {
    fn github_list<'a>(
        &'a self,
        repo: &'a RepoRef,
        git_ref: Option<&'a str>,
    ) -> RemoteFuture<'a, RepoListing> {
        Box::pin(async move {
            self.fetcher
                .list_files(repo, git_ref)
                .await
                .map_err(RemoteError::from)
        })
    }

    fn github_fetch<'a>(
        &'a self,
        repo: &'a RepoRef,
        listing: &'a RepoListing,
        path: &'a str,
    ) -> RemoteFuture<'a, Vec<u8>> {
        Box::pin(async move {
            self.fetcher
                .fetch_bytes(repo, listing, path)
                .await
                .map_err(RemoteError::from)
        })
    }

    fn github_latest_commit<'a>(
        &'a self,
        repo: &'a RepoRef,
        path: &'a str,
        git_ref: Option<&'a str>,
    ) -> RemoteFuture<'a, Option<String>> {
        Box::pin(self.fetcher.latest_commit(repo, path, git_ref))
    }

    fn git_ls_remote<'a>(
        &'a self,
        url: &'a str,
        git_ref: Option<&'a str>,
    ) -> RemoteFuture<'a, String> {
        Box::pin(async move {
            let pattern = git_ref.unwrap_or("HEAD");
            let output = run_git(
                &["ls-remote", "--", url, pattern],
                None,
                GIT_LS_REMOTE_TIMEOUT,
            )
            .await?;
            parse_ls_remote(&output)
                .ok_or_else(|| RemoteError::Failed(format!("Ref '{}' was not found", pattern)))
        })
    }

    fn git_clone<'a>(
        &'a self,
        url: &'a str,
        git_ref: Option<&'a str>,
        dest: &'a Path,
    ) -> RemoteFuture<'a, String> {
        Box::pin(async move {
            let dest_str = dest.to_string_lossy().to_string();
            let branch_arg = git_ref.map(|value| format!("--branch={}", value));
            let mut args = vec!["clone", "--depth", "1", "--no-tags", "--single-branch"];
            if let Some(branch) = branch_arg.as_deref() {
                args.push(branch);
            }
            args.extend(["--", url, dest_str.as_str()]);
            run_git(&args, None, GIT_CLONE_TIMEOUT).await?;
            let head = run_git(&["rev-parse", "HEAD"], Some(dest), GIT_LOCAL_TIMEOUT).await?;
            Ok(head.trim().to_string())
        })
    }
}

/// 优先取剥离后的 tag（`^{}`），否则取第一行。
pub(crate) fn parse_ls_remote(output: &str) -> Option<String> {
    let rows: Vec<(&str, &str)> = output
        .lines()
        .filter_map(|line| line.split_once('\t'))
        .map(|(sha, name)| (sha.trim(), name.trim()))
        .filter(|(sha, _)| !sha.is_empty())
        .collect();
    rows.iter()
        .find(|(_, name)| name.ends_with("^{}"))
        .or_else(|| rows.first())
        .map(|(sha, _)| sha.to_string())
}

/// 跑一次 git。用户输入只作为 `--` 之后的位置参数出现；交互式认证全部关掉，
/// 私有仓库没有凭据时直接失败而不是卡在密码提示。
async fn run_git(
    args: &[&str],
    cwd: Option<&Path>,
    timeout: Duration,
) -> Result<String, RemoteError> {
    let mut command = no_window_tokio_command("git");
    command
        .args(["-c", "protocol.ext.allow=never"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if std::env::var_os("GIT_SSH_COMMAND").is_none() {
        command.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    }
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let output = tokio::time::timeout(timeout, command.output())
        .await
        .map_err(|_| RemoteError::Failed(format!("git {} timed out", args[0])))?
        .map_err(|error| RemoteError::Failed(format!("Failed to run git: {}", error)))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.lines().next_back().unwrap_or("").trim().to_string();
        return Err(RemoteError::Failed(format!(
            "git {} failed: {}",
            args[0],
            if detail.is_empty() {
                output.status.to_string()
            } else {
                detail
            }
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ls_remote_prefers_peeled_tag() {
        let output = "aaa\trefs/tags/v1\nbbb\trefs/tags/v1^{}\n";
        assert_eq!(parse_ls_remote(output).as_deref(), Some("bbb"));
        assert_eq!(parse_ls_remote("ccc\tHEAD\n").as_deref(), Some("ccc"));
        assert_eq!(parse_ls_remote(""), None);
    }
}
