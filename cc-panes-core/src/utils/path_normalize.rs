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

/// 归一化同一宿主上的项目路径，同时保留原路径所用的分隔符风格。
///
/// Windows 盘符路径会剥离安全的 verbatim 前缀、统一为大写盘符并去掉非根路径的
/// 尾分隔符。普通 UNC、WSL Linux 路径和 Unix 路径不会做大小写折叠。
pub fn normalize_project_path(path: impl AsRef<Path>) -> PathBuf {
    let simplified = simplify_path(path);
    let mut value = strip_verbatim_disk_prefix(&simplified.to_string_lossy()).to_string();

    if is_drive_path(&value) {
        value.replace_range(0..1, &value[..1].to_ascii_uppercase());
    }
    trim_trailing_separators(&mut value);

    PathBuf::from(value)
}

/// 判断两个项目路径是否等价。
///
/// 仅盘符路径和同一 WSL distro 下的 `/mnt/<drive>` 部分按 Windows 语义忽略
/// ASCII 大小写。普通 UNC 与 WSL Linux 文件系统路径保持大小写敏感；这里也不做
/// `/mnt/d`、`D:\\`、WSL UNC 之间的跨形式身份映射。
pub fn paths_equivalent(a: impl AsRef<Path>, b: impl AsRef<Path>) -> bool {
    let a = comparison_path(a.as_ref());
    let b = comparison_path(b.as_ref());

    if is_drive_path(&a) && is_drive_path(&b) {
        return a.eq_ignore_ascii_case(&b);
    }

    match (wsl_mounted_drive_parts(&a), wsl_mounted_drive_parts(&b)) {
        (Some((a_prefix, a_windows)), Some((b_prefix, b_windows))) => {
            a_prefix == b_prefix && a_windows.eq_ignore_ascii_case(b_windows)
        }
        _ => a == b,
    }
}

fn strip_verbatim_disk_prefix(value: &str) -> &str {
    let Some(rest) = value
        .strip_prefix(r"\\?\")
        .or_else(|| value.strip_prefix("//?/"))
    else {
        return value;
    };
    if is_drive_path(rest) {
        rest
    } else {
        value
    }
}

fn is_drive_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn is_separator(byte: u8) -> bool {
    byte == b'/' || byte == b'\\'
}

fn is_share_root(value: &str) -> bool {
    let normalized = value.replace('\\', "/");
    if !normalized.starts_with("//") || normalized.starts_with("//?/") {
        return false;
    }
    normalized
        .trim_end_matches('/')
        .trim_start_matches("//")
        .split('/')
        .count()
        == 2
}

fn trim_trailing_separators(value: &mut String) {
    if value.is_empty() || is_share_root(value) {
        return;
    }

    let min_len = if value.starts_with('/') || value.starts_with('\\') {
        1
    } else if is_drive_path(value) && value.as_bytes().get(2).is_some_and(|b| is_separator(*b)) {
        3
    } else {
        0
    };

    while value.len() > min_len && value.as_bytes().last().is_some_and(|b| is_separator(*b)) {
        value.pop();
    }
}

fn comparison_path(path: &Path) -> String {
    let simplified = simplify_path(path);
    let mut value = strip_verbatim_disk_prefix(&simplified.to_string_lossy()).replace('\\', "/");
    trim_trailing_separators(&mut value);
    value
}

fn wsl_mounted_drive_parts(value: &str) -> Option<(&str, &str)> {
    let without_unc = value.strip_prefix("//")?;
    let components: Vec<&str> = without_unc.split('/').collect();
    let server = *components.first()?;
    if server != "wsl.localhost" && server != "wsl$" {
        return None;
    }
    let distro = *components.get(1)?;
    let mnt = *components.get(2)?;
    let drive = *components.get(3)?;
    if mnt != "mnt"
        || drive.len() != 1
        || !drive
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic)
    {
        return None;
    }

    let prefix_len = 2 + server.len() + 1 + distro.len() + 1 + mnt.len() + 1;
    Some((&value[..prefix_len], &value[prefix_len..]))
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

    #[test]
    fn normalize_project_path_uppercases_drive_and_trims_separator() {
        assert_eq!(
            normalize_project_path(r"d:\Users\me\proj\\"),
            PathBuf::from(r"D:\Users\me\proj")
        );
        assert_eq!(
            normalize_project_path("d:/Users/me/proj/"),
            PathBuf::from("D:/Users/me/proj")
        );
    }

    #[test]
    fn normalize_project_path_preserves_roots() {
        assert_eq!(normalize_project_path(r"c:\"), PathBuf::from(r"C:\"));
        assert_eq!(normalize_project_path("/"), PathBuf::from("/"));
        assert_eq!(
            normalize_project_path(r"\\server\share\"),
            PathBuf::from(r"\\server\share\")
        );
    }

    #[test]
    fn normalize_project_path_is_idempotent_and_keeps_unix_case() {
        let unix = PathBuf::from("/home/User/Project");
        assert_eq!(normalize_project_path(&unix), unix);

        let once = normalize_project_path(r"d:\Users\me\proj\\");
        assert_eq!(normalize_project_path(&once), once);
    }

    #[test]
    fn drive_paths_are_equivalent_ignoring_case_and_separator_style() {
        assert!(paths_equivalent(r"d:\Users\Me\proj\", "D:/users/me/PROJ"));
        assert!(paths_equivalent(
            r"\\?\d:\Users\Me\proj",
            "D:/users/me/PROJ/"
        ));
        assert!(!paths_equivalent(r"D:\proj", r"E:\proj"));
        assert!(!paths_equivalent("C:", "C:/"));
    }

    #[test]
    fn ordinary_unc_paths_remain_case_sensitive() {
        assert!(paths_equivalent(
            r"\\server\share\Folder\",
            "//server/share/Folder"
        ));
        assert!(!paths_equivalent(
            r"\\server\share\Folder",
            r"\\server\share\folder"
        ));
        assert!(paths_equivalent(
            r"\\?\UNC\server\share\Folder\",
            r"\\?\UNC\server\share\Folder"
        ));
        assert!(!paths_equivalent(
            r"\\?\UNC\server\share\Folder",
            r"\\?\UNC\server\share\folder"
        ));
    }

    #[test]
    fn wsl_linux_paths_are_case_and_distro_sensitive() {
        assert!(!paths_equivalent(
            r"\\wsl.localhost\Ubuntu\home\User\proj",
            r"\\wsl.localhost\Ubuntu\home\user\proj"
        ));
        assert!(!paths_equivalent(
            r"\\wsl.localhost\Ubuntu\home\user\proj",
            r"\\wsl.localhost\ubuntu\home\user\proj"
        ));
    }

    #[test]
    fn wsl_mounted_drive_paths_only_fold_the_windows_portion() {
        assert!(paths_equivalent(
            r"\\wsl.localhost\Ubuntu\mnt\d\Users\Me\proj\",
            r"\\wsl.localhost\Ubuntu\mnt\D\users\me\PROJ"
        ));
        assert!(!paths_equivalent(
            r"\\wsl.localhost\Ubuntu\mnt\d\Users\Me\proj",
            r"\\wsl.localhost\ubuntu\mnt\d\Users\Me\proj"
        ));
        assert!(!paths_equivalent(
            r"\\wsl$\Ubuntu\mnt\d\Users\Me\proj",
            r"\\wsl.localhost\Ubuntu\mnt\d\Users\Me\proj"
        ));
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
