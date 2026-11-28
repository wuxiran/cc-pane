//! 子进程抽象：生产走本机 `gh` / `git`，测试注入假实现，单测里绝不真调 GitHub。

use std::path::Path;
use std::time::Duration;

use crate::utils::{no_window_command, output_with_timeout_limit, AppError, AppResult};

/// 要执行的程序。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliProgram {
    Gh,
    Git,
}

impl CliProgram {
    pub fn executable(self) -> &'static str {
        match self {
            CliProgram::Gh => "gh",
            CliProgram::Git => "git",
        }
    }
}

/// 一次执行的结果（非零退出码不是 Err，由调用方按 stderr 判断）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CliOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

impl CliOutput {
    /// 失败时给人看的错误文本（stderr 优先）。
    pub fn error_text(&self) -> String {
        let text = if self.stderr.trim().is_empty() {
            self.stdout.trim()
        } else {
            self.stderr.trim()
        };
        super::parse::truncate_chars(text, 1_000).0
    }
}

/// 命令执行抽象。`cwd` 必填：不给就会继承宿主进程的 cwd（dev 下是 `src-tauri/`）。
pub trait CliRunner: Send + Sync {
    /// 程序是否装在本机。
    fn is_installed(&self, program: CliProgram) -> bool;
    /// 在 `cwd` 下执行；程序起不来时返回 Err。
    fn run(&self, program: CliProgram, cwd: &Path, args: &[String]) -> AppResult<CliOutput>;
}

/// gh 网络操作（含拉日志）的超时。
const RUN_TIMEOUT: Duration = Duration::from_secs(90);
/// 单次输出上限：失败日志可能很大，解析后再截断。
const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

/// 生产实现：本机 `gh` / `git`，复用用户已有登录，不存任何 token。
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemCliRunner;

impl CliRunner for SystemCliRunner {
    fn is_installed(&self, program: CliProgram) -> bool {
        cc_cli_adapters::resolve_executable(program.executable()).is_ok()
    }

    fn run(&self, program: CliProgram, cwd: &Path, args: &[String]) -> AppResult<CliOutput> {
        let executable = cc_cli_adapters::resolve_executable(program.executable())
            .map_err(|_| AppError::from(format!("未找到 {}", program.executable())))?;
        let mut command = no_window_command(executable);
        command
            .current_dir(cwd)
            .args(args)
            // 非交互：GUI 子进程里没有终端可答提示，宁可报错。
            .env("GH_PROMPT_DISABLED", "1")
            .env("GH_NO_UPDATE_NOTIFIER", "1")
            .env("GH_SPINNER_DISABLED", "1")
            .env("NO_COLOR", "1")
            .env("CLICOLOR", "0");
        let output = output_with_timeout_limit(&mut command, RUN_TIMEOUT, MAX_OUTPUT_BYTES)
            .map_err(|error| {
                AppError::from(format!("执行 {} 失败: {error}", program.executable()))
            })?;
        Ok(CliOutput {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}
