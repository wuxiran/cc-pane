//! 启动前项目 hooks 同步的超时保护。
//!
//! 项目放在云盘/网络盘（Synology Drive、iCloud、NFS、`\\wsl.localhost` 等）上且对端
//! 不可达时，读写 `.claude/settings.local.json` 这类文件会无限阻塞，会话启动随之永久
//! 卡死。这里把同步放到独立线程里，最多等 [`PROJECT_HOOKS_SYNC_TIMEOUT`]；超时后放弃
//! 等待、继续启动（同步线程留在后台自行结束，不影响会话）。

use std::path::PathBuf;
use std::sync::{mpsc, Arc};
use std::time::Duration;

use super::wsl_codex::windows_path_to_wsl;
use super::TerminalService;
use crate::models::CliTool;
use crate::services::ProjectCliHooksService;
use crate::utils::error::{AppError, AppResult};

/// 启动前同步项目 hooks 的最长等待时间。
pub(super) const PROJECT_HOOKS_SYNC_TIMEOUT: Duration = Duration::from_secs(3);

/// launch trace 里 `launch.project_hooks.end` 的结果值。
pub(super) const HOOKS_OUTCOME_OK: &str = "ok";
pub(super) const HOOKS_OUTCOME_FAILED: &str = "failed";

/// 在独立线程里执行 `sync`，最多等待 `timeout`。
///
/// 超时、线程创建失败或线程无结果退出都返回 `Err`，调用方按「同步失败、继续启动」处理。
pub(super) fn run_hooks_sync_with_timeout<F>(timeout: Duration, sync: F) -> AppResult<()>
where
    F: FnOnce() -> Result<(), String> + Send + 'static,
{
    let (tx, rx) = mpsc::channel();
    std::thread::Builder::new()
        .name("cc-launch-hooks-sync".to_string())
        .spawn(move || {
            // 接收端可能已因超时被丢弃，发送失败无需处理。
            let _ = tx.send(sync());
        })
        .map_err(|e| AppError::from(format!("failed to spawn hooks sync thread: {e}")))?;
    match rx.recv_timeout(timeout) {
        Ok(result) => result.map_err(AppError::from),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(AppError::from(format!(
            "project hooks sync timed out after {}ms (project filesystem may be unresponsive, \
             e.g. cloud/network drive offline)",
            timeout.as_millis()
        ))),
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err(AppError::from("hooks sync thread exited without a result"))
        }
    }
}

impl TerminalService {
    /// 本地启动：带超时地同步项目 hooks。
    pub(super) fn sync_local_project_hooks_with_timeout(
        &self,
        state_path: &str,
        launch_path: &str,
        cli_tool_id: &str,
    ) -> AppResult<()> {
        let service = Arc::clone(&self.project_cli_hooks_service);
        let state_path = state_path.to_string();
        let launch_path = launch_path.to_string();
        let cli_tool_id = cli_tool_id.to_string();
        run_hooks_sync_with_timeout(PROJECT_HOOKS_SYNC_TIMEOUT, move || {
            service.sync_launch_hooks(&state_path, &launch_path, &cli_tool_id, None)
        })
    }

    /// WSL 启动：带超时地同步项目 hooks（目标经 `\\wsl.localhost` UNC 访问，VM 无响应时同样会阻塞）。
    ///
    /// Codex 写 WSL 专用 hooks（目标缺省为 `project_path`），其余 CLI 走通用同步（缺省为 `state_path`）。
    pub(super) fn sync_wsl_project_hooks_with_timeout(
        &self,
        cli_tool: CliTool,
        state_path: &str,
        launch_hooks_path: Option<&str>,
        project_path: &str,
    ) -> AppResult<()> {
        let wsl_hook_binary = wsl_hook_binary_path()?;
        let service = Arc::clone(&self.project_cli_hooks_service);
        let state_path = state_path.to_string();
        let cli_tool_id = cli_tool.as_id().to_string();
        let is_codex = cli_tool == CliTool::Codex;
        let target = launch_hooks_path
            .unwrap_or(if is_codex {
                project_path
            } else {
                state_path.as_str()
            })
            .to_string();
        run_hooks_sync_with_timeout(PROJECT_HOOKS_SYNC_TIMEOUT, move || {
            if is_codex {
                service.sync_wsl_codex_project_hooks(&state_path, &target, &wsl_hook_binary)
            } else {
                service.sync_launch_hooks(
                    &state_path,
                    &target,
                    &cli_tool_id,
                    Some(&wsl_hook_binary),
                )
            }
        })
    }
}

/// 把宿主侧 cli-hook 二进制路径翻译成 WSL 内可执行的路径。
fn wsl_hook_binary_path() -> AppResult<PathBuf> {
    let path = ProjectCliHooksService::get_hook_binary_path()?;
    windows_path_to_wsl(&path)
        .map(PathBuf::from)
        .ok_or_else(|| {
            AppError::from(format!(
                "Failed to translate hook binary path to WSL path: {}",
                path.display()
            ))
        })
}

/// 把同步结果映射为 launch trace 的 outcome 值。
pub(super) fn hooks_outcome(result: &AppResult<()>) -> &'static str {
    if result.is_ok() {
        HOOKS_OUTCOME_OK
    } else {
        HOOKS_OUTCOME_FAILED
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn returns_sync_result_when_fast() {
        let result = run_hooks_sync_with_timeout(Duration::from_secs(1), || Ok(()));
        assert!(result.is_ok());
        assert_eq!(hooks_outcome(&result), HOOKS_OUTCOME_OK);
    }

    #[test]
    fn propagates_sync_error() {
        let result =
            run_hooks_sync_with_timeout(Duration::from_secs(1), || Err("boom".to_string()));
        let err = result.as_ref().expect_err("sync error must propagate");
        assert_eq!(err.message(), "boom");
        assert_eq!(hooks_outcome(&result), HOOKS_OUTCOME_FAILED);
    }

    #[test]
    fn times_out_without_waiting_for_slow_sync() {
        let started = Instant::now();
        let result = run_hooks_sync_with_timeout(Duration::from_millis(50), || {
            std::thread::sleep(Duration::from_secs(5));
            Ok(())
        });
        let elapsed = started.elapsed();
        let err = result.as_ref().expect_err("slow sync must time out");
        assert!(
            err.message().contains("timed out after 50ms"),
            "{}",
            err.message()
        );
        assert_eq!(hooks_outcome(&result), HOOKS_OUTCOME_FAILED);
        assert!(
            elapsed < Duration::from_secs(2),
            "launch must not block on a hung sync (elapsed {elapsed:?})"
        );
    }

    #[test]
    fn panicking_sync_reports_disconnected() {
        let result = run_hooks_sync_with_timeout(Duration::from_secs(2), || {
            panic!("sync thread panicked");
        });
        let err = result.expect_err("panicked sync must fail");
        assert!(
            err.message().contains("without a result"),
            "{}",
            err.message()
        );
    }
}
