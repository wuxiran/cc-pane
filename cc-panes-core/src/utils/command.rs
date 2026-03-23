//! 子进程安全封装 — 自动在 Windows 上隐藏控制台窗口

use std::process::Command;

/// 创建不弹窗的 Command（Windows 自动设置 CREATE_NO_WINDOW）
///
/// 替代直接使用 `Command::new()`，避免遗漏 CREATE_NO_WINDOW 导致 cmd 窗口闪烁。
pub fn no_window_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}
