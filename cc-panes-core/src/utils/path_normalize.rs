//! Windows `\\?\` verbatim（UNC）路径的统一去前缀入口。
//!
//! 背景见 `docs/35-unc-path-contamination.md`：`Path::canonicalize()` 在 Windows 上
//! 必然产出 `\\?\C:\...` 形式，而 `cmd.exe` 拒绝以它作为 cwd（"UNC paths are not
//! supported. Defaulting to Windows directory."），会把 CLI 启到 `C:\Windows`。
//!
//! 全仓库统一走 [`dunce`]：它只对「能安全降级成普通路径」的 verbatim 路径剥前缀，
//! 对 `\\?\UNC\server\share`、超长路径等**保持原样**——手写的
//! `strip_prefix(r"\\?\")` 在这些情况下会产出坏路径。
//!
//! 非 Windows 平台上 `dunce` 的实现即恒等函数，因此本模块全部为 no-op。

use std::path::{Path, PathBuf};

/// 剥离可安全剥离的 `\\?\` 前缀，返回 `PathBuf`。
pub fn simplify_path(path: impl AsRef<Path>) -> PathBuf {
    dunce::simplified(path.as_ref()).to_path_buf()
}

/// 字符串版本：用于已经是 `String`/`&str` 的路径（DB 列、IPC 载荷等）。
pub fn simplify_path_str(path: &str) -> String {
    dunce::simplified(Path::new(path))
        .to_string_lossy()
        .to_string()
}

/// `Option` 版本：`None` 原样透传，便于在 SQL 参数绑定处直接套用。
pub fn simplify_opt_path_str(path: Option<&str>) -> Option<String> {
    path.map(simplify_path_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_paths_are_untouched() {
        // 各平台都不该改写普通路径
        assert_eq!(
            simplify_path_str("/home/user/project"),
            "/home/user/project"
        );
    }

    #[test]
    fn option_none_passes_through() {
        assert_eq!(simplify_opt_path_str(None), None);
    }

    #[test]
    fn idempotent() {
        let once = simplify_path_str(r"\\?\C:\Users\me\proj");
        let twice = simplify_path_str(&once);
        assert_eq!(once, twice);
    }

    #[cfg(windows)]
    #[test]
    fn strips_verbatim_disk_prefix() {
        assert_eq!(
            simplify_path_str(r"\\?\C:\Users\wuxiran\.cc-panes-dev\workspaces\default"),
            r"C:\Users\wuxiran\.cc-panes-dev\workspaces\default"
        );
        assert_eq!(simplify_path_str(r"C:\Users\me"), r"C:\Users\me");
    }

    #[cfg(windows)]
    #[test]
    fn keeps_unsafe_verbatim_paths_intact() {
        // `\\?\UNC\...` 不能靠裸剥前缀降级，dunce 保持原样
        let unc = r"\\?\UNC\server\share\dir";
        assert_eq!(simplify_path_str(unc), unc);
    }

    #[cfg(not(windows))]
    #[test]
    fn is_noop_on_unix() {
        // Unix 下 `\\?\` 只是普通文件名字符，绝不能被改写
        let weird = r"/tmp/\\?\C:\weird";
        assert_eq!(simplify_path_str(weird), weird);
    }
}
