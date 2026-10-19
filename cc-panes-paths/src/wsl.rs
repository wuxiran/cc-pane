//! WSL 视角的路径：UNC 解析、盘符 ↔ `/mnt` 形式转换、会话归属比较键。

/// WSL 默认的 Windows 盘挂载根（`/etc/wsl.conf` 的 `automount.root` 未改时）。
///
/// 自定义 automount root 下，形式转换可以传入探测到的根；身份键仍按 `/mnt` 计算（已知限制）。
pub const DEFAULT_WSL_MOUNT_ROOT: &str = "/mnt";

/// 解析 WSL UNC 路径，返回 `(distro, distro 内的 POSIX 绝对路径)`。
///
/// 认 `\\wsl.localhost\`、`\\wsl$\`、`\\wsl\` 三种主机前缀（大小写不敏感），以及
/// `\\?\UNC\` verbatim 包装；分隔符 `\` 与 `/` 均可。distro 名与 POSIX 部分保持原样大小写，
/// 去掉尾分隔符；发行版根返回 `/`。非 WSL UNC 返回 `None`。
pub fn parse_wsl_unc(path: &str) -> Option<(String, String)> {
    let slashed = slashed_without_verbatim(path);
    let (distro, posix) = split_wsl_unc(&slashed)?;
    Some((distro.to_string(), posix))
}

/// 转成 WSL 内可用的 POSIX 路径（形式转换，保留大小写，不用于比较）。
///
/// - WSL UNC → distro 内的 POSIX 路径；
/// - 盘符路径 `D:\x` / `D:` → `<mount_root>/d/x` / `<mount_root>/d`；
/// - POSIX 绝对路径原样返回（去尾分隔符）；
/// - 普通网络共享、`C:relative` 这类相对形态返回 `None`。
pub fn to_wsl_posix(path: &str, mount_root: &str) -> Option<String> {
    let slashed = slashed_without_verbatim(path);
    if let Some((_, posix)) = split_wsl_unc(&slashed) {
        return Some(posix);
    }
    if let Some((drive, tail)) = split_absolute_drive(&slashed) {
        let root = mount_root.trim_end_matches('/');
        let tail = tail.trim_matches('/');
        return Some(if tail.is_empty() {
            format!("{root}/{drive}")
        } else {
            format!("{root}/{drive}/{tail}")
        });
    }
    if slashed.starts_with('/') && !slashed.starts_with("//") {
        return Some(trim_posix(&slashed).to_string());
    }
    None
}

/// distro 内的 POSIX 路径 → Windows 侧 UNC 路径，统一用 `\\wsl.localhost\` 前缀。
pub fn to_windows_unc(posix: &str, distro: &str) -> String {
    let tail = posix.trim_matches('/').replace('/', "\\");
    if tail.is_empty() {
        format!(r"\\wsl.localhost\{distro}")
    } else {
        format!(r"\\wsl.localhost\{distro}\{tail}")
    }
}

/// WSL 视角的比较键，用于会话归属匹配（rollout 里记的是 WSL 内看到的 cwd）。
///
/// - WSL UNC 剥成 distro 内的 POSIX 路径；
/// - 盘符路径转 `/mnt/<x>/...`；
/// - 凡 `/mnt/<x>/` 开头的结果**整体小写**（Windows 盘大小写不敏感）；
/// - WSL Linux 路径保持大小写；
/// - 其余（普通网络共享、`C:relative`）保守地小写并去尾分隔符。
///
/// 不带 distro：调用方需要另行比较发行版，否则两个 distro 下的同名路径会得到同一个键。
pub fn wsl_compare_key(path: &str) -> String {
    let slashed = slashed_without_verbatim(path);
    if let Some((_, posix)) = split_wsl_unc(&slashed) {
        return fold_mounted_drive(posix);
    }
    if split_absolute_drive(&slashed).is_some() {
        let posix = to_wsl_posix(&slashed, DEFAULT_WSL_MOUNT_ROOT).unwrap_or_default();
        return posix.to_lowercase();
    }
    if slashed.starts_with('/') && !slashed.starts_with("//") {
        return fold_mounted_drive(trim_posix(&slashed).to_string());
    }
    slashed.trim_end_matches('/').to_lowercase()
}

/// `/mnt/<x>` 或 `/mnt/<x>/...` 形式的 POSIX 路径返回小写盘符，其余返回 `None`。
///
/// 只认路径开头，`/home/u/mnt/a/foo` 这种中部出现的 `/mnt/` 不算。
pub fn mnt_drive_letter(posix: &str) -> Option<char> {
    let rest = posix.strip_prefix("/mnt/")?;
    let bytes = rest.as_bytes();
    let drive = *bytes.first()?;
    if !drive.is_ascii_alphabetic() {
        return None;
    }
    match bytes.get(1) {
        None | Some(b'/') => Some((drive as char).to_ascii_lowercase()),
        Some(_) => None,
    }
}

fn fold_mounted_drive(posix: String) -> String {
    if mnt_drive_letter(&posix).is_some() {
        posix.to_lowercase()
    } else {
        posix
    }
}

/// 剥 verbatim 前缀并把 `\` 统一为 `/`：`\\?\UNC\server\share` → `//server/share`，
/// `\\?\D:\x` → `D:/x`。
fn slashed_without_verbatim(path: &str) -> String {
    let slashed = path.trim().replace('\\', "/");
    if let Some(rest) = slashed.strip_prefix("//?/") {
        if rest.len() >= 4 && rest[..4].eq_ignore_ascii_case("unc/") {
            return format!("//{}", &rest[4..]);
        }
        return rest.to_string();
    }
    slashed
}

fn split_wsl_unc(slashed: &str) -> Option<(&str, String)> {
    let rest = slashed.strip_prefix("//")?;
    let (server, after_server) = rest.split_once('/')?;
    if !is_wsl_server(server) {
        return None;
    }
    let (distro, tail) = after_server.split_once('/').unwrap_or((after_server, ""));
    if distro.is_empty() {
        return None;
    }
    let tail = tail.trim_end_matches('/');
    let posix = if tail.is_empty() {
        "/".to_string()
    } else if tail.starts_with('/') {
        tail.to_string()
    } else {
        format!("/{tail}")
    };
    Some((distro, posix))
}

fn is_wsl_server(server: &str) -> bool {
    server.eq_ignore_ascii_case("wsl.localhost")
        || server.eq_ignore_ascii_case("wsl$")
        || server.eq_ignore_ascii_case("wsl")
}

/// `X:` 或 `X:/...`（盘符后紧跟分隔符或结束）返回 `(小写盘符, 盘符之后的部分)`。
fn split_absolute_drive(slashed: &str) -> Option<(char, &str)> {
    let bytes = slashed.as_bytes();
    if bytes.len() < 2 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' {
        return None;
    }
    match bytes.get(2) {
        None | Some(b'/') => Some(((bytes[0] as char).to_ascii_lowercase(), &slashed[2..])),
        Some(_) => None,
    }
}

fn trim_posix(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        "/"
    } else {
        trimmed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_project_converges_on_one_wsl_key() {
        let key = wsl_compare_key(r"D:\Foo");
        assert_eq!(key, "/mnt/d/foo");
        assert_eq!(wsl_compare_key("/mnt/d/Foo"), key);
        assert_eq!(wsl_compare_key(r"\\wsl.localhost\Ubuntu\mnt\d\foo"), key);
    }

    #[test]
    fn wsl_linux_unc_matches_rollout_cwd() {
        assert_eq!(
            wsl_compare_key(r"\\wsl.localhost\Ubuntu\home\u\x"),
            wsl_compare_key("/home/u/x")
        );
        assert_ne!(
            wsl_compare_key("/home/u/Foo"),
            wsl_compare_key("/home/u/foo")
        );
    }

    #[test]
    fn to_windows_unc_uses_wsl_localhost() {
        assert_eq!(
            to_windows_unc("/home/u/repo", "Ubuntu"),
            r"\\wsl.localhost\Ubuntu\home\u\repo"
        );
        assert_eq!(to_windows_unc("/", "Ubuntu"), r"\\wsl.localhost\Ubuntu");
        assert_eq!(to_windows_unc("", "Debian"), r"\\wsl.localhost\Debian");
    }

    #[test]
    fn to_wsl_posix_honors_custom_mount_root() {
        assert_eq!(
            to_wsl_posix(r"D:\Repo", "/win/").as_deref(),
            Some("/win/d/Repo")
        );
    }

    #[test]
    fn unc_round_trips_through_parse() {
        let unc = to_windows_unc("/home/User/Repo", "Ubuntu-24.04");
        assert_eq!(
            parse_wsl_unc(&unc),
            Some(("Ubuntu-24.04".to_string(), "/home/User/Repo".to_string()))
        );
    }

    #[test]
    fn mnt_drive_letter_only_matches_leading_mount() {
        assert_eq!(mnt_drive_letter("/mnt/d"), Some('d'));
        assert_eq!(mnt_drive_letter("/mnt/D/x"), Some('d'));
        assert_eq!(mnt_drive_letter("/mnt/data/x"), None);
        assert_eq!(mnt_drive_letter("/home/u/mnt/a/foo"), None);
    }

    #[test]
    fn parse_rejects_non_wsl_hosts_and_empty_distro() {
        assert_eq!(parse_wsl_unc(r"\\server\share\x"), None);
        assert_eq!(parse_wsl_unc(r"\\wsl.localhost\"), None);
        assert_eq!(parse_wsl_unc("/home/u"), None);
    }
}
