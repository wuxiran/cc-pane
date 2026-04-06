//! 子进程安全封装 — 自动在 Windows 上隐藏控制台窗口

use std::ffi::OsStr;
use std::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(windows)]
fn apply_no_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
}

/// 创建不弹窗的 Command（Windows 自动设置 CREATE_NO_WINDOW）
///
/// 替代直接使用 `Command::new()`，避免遗漏 CREATE_NO_WINDOW 导致 cmd 窗口闪烁。
#[cfg(windows)]
pub fn no_window_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    apply_no_window(&mut command);
    command
}

#[cfg(not(windows))]
pub fn no_window_command(program: impl AsRef<OsStr>) -> Command {
    Command::new(program)
}

#[cfg(windows)]
fn apply_no_window_tokio(command: &mut tokio::process::Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

/// 创建不弹窗的 Tokio Command（Windows 自动设置 CREATE_NO_WINDOW）
#[cfg(windows)]
pub fn no_window_tokio_command(program: impl AsRef<OsStr>) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(program);
    apply_no_window_tokio(&mut command);
    command
}

#[cfg(not(windows))]
pub fn no_window_tokio_command(program: impl AsRef<OsStr>) -> tokio::process::Command {
    tokio::process::Command::new(program)
}
