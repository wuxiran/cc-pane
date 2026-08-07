use crate::utils::error::AppError;
use crate::utils::{simplify_path, AppResult};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

const MAX_RAW_PATH_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalLinkContext {
    pub project_path: String,
    pub runtime_kind: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalPathKind {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTerminalPathLink {
    pub canonical_path: String,
    pub kind: TerminalPathKind,
    pub runtime_kind: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminalPathScope {
    ProjectOnly,
    ExplicitAbsoluteDirectory,
}

fn coded(code: &str, message: &str) -> AppError {
    AppError::coded(code, message)
}

fn invalid_input(raw_path: &str) -> bool {
    raw_path.is_empty()
        || raw_path.len() > MAX_RAW_PATH_BYTES
        || raw_path.chars().any(|character| {
            character <= '\u{1f}'
                || character == '\u{7f}'
                || matches!(
                    character,
                    '\u{061c}'
                        | '\u{200b}'
                        | '\u{200e}'
                        | '\u{200f}'
                        | '\u{202a}'..='\u{202e}'
                        | '\u{2060}'..='\u{2069}'
                        | '\u{feff}'
                )
        })
        || has_uri_scheme(raw_path)
        || has_invalid_windows_syntax(raw_path)
}

fn has_uri_scheme(raw_path: &str) -> bool {
    if raw_path.as_bytes().get(1) == Some(&b':') && raw_path.as_bytes()[0].is_ascii_alphabetic() {
        return false;
    }
    let Some(colon) = raw_path.find(':') else {
        return false;
    };
    let scheme = &raw_path[..colon];
    !scheme.is_empty()
        && scheme.as_bytes()[0].is_ascii_alphabetic()
        && scheme
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'))
}

#[cfg(windows)]
fn has_invalid_windows_syntax(raw_path: &str) -> bool {
    let normalized = raw_path.replace('/', "\\");
    let drive_path = if let Some(verbatim_drive_path) = normalized.strip_prefix("\\\\?\\") {
        verbatim_drive_path
    } else {
        if normalized.starts_with("\\\\.\\") || normalized.starts_with("\\\\") {
            return true;
        }
        normalized.as_str()
    };
    let bytes = drive_path.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        if bytes.get(2).is_none_or(|separator| *separator != b'\\') {
            return true;
        }
        return drive_path[2..].contains(':');
    }
    if normalized.starts_with("\\\\?\\") {
        return true;
    }
    normalized.contains(':')
}

#[cfg(not(windows))]
fn has_invalid_windows_syntax(_raw_path: &str) -> bool {
    false
}

fn relative_escapes_root(path: &Path) -> bool {
    let mut depth = 0usize;
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(_) => depth += 1,
            Component::ParentDir if depth > 0 => depth -= 1,
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return true,
        }
    }
    false
}

#[cfg(windows)]
fn path_is_within(path: &Path, root: &Path) -> bool {
    fn comparable(path: &Path) -> String {
        simplify_path(path)
            .to_string_lossy()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase()
    }

    let path = comparable(path);
    let root = comparable(root);
    path == root
        || path
            .strip_prefix(&root)
            .is_some_and(|suffix| suffix.starts_with('\\'))
}

#[cfg(not(windows))]
fn path_is_within(path: &Path, root: &Path) -> bool {
    path.starts_with(root)
}

fn requested_path(root: &Path, raw_path: &str) -> AppResult<PathBuf> {
    #[cfg(windows)]
    let raw_path = raw_path.strip_prefix("\\\\?\\").unwrap_or(raw_path);
    let requested = Path::new(raw_path);
    if requested.is_absolute() {
        // 不在这里做包含性预检查：原始输入可能是 8.3 短名/大小写变体
        // （GitHub runner 的 TEMP 就是 RUNNER~1 短名形式），字符串对比必然误判。
        // 唯一的安全边界是下游 canonicalize 之后的 path_is_within 复核。
        return Ok(requested.to_path_buf());
    }
    if relative_escapes_root(requested) {
        return Err(coded(
            "TERMINAL_PATH_OUTSIDE_ROOT",
            "The terminal path is outside the session project",
        ));
    }
    Ok(root.join(requested))
}

fn resolve_terminal_path_link_with_scope(
    context: &TerminalLinkContext,
    raw_path: &str,
    scope: TerminalPathScope,
) -> AppResult<ResolvedTerminalPathLink> {
    if context.runtime_kind == "ssh" {
        return Err(coded(
            "TERMINAL_PATH_REMOTE_UNSUPPORTED",
            "Remote terminal paths are not available on the host",
        ));
    }
    if !matches!(context.runtime_kind.as_str(), "local" | "wsl") {
        return Err(coded(
            "TERMINAL_PATH_CONTEXT_UNAVAILABLE",
            "The terminal path context is unavailable",
        ));
    }
    if invalid_input(raw_path) {
        return Err(coded(
            "TERMINAL_PATH_INVALID",
            "The terminal path is invalid",
        ));
    }

    let root = std::fs::canonicalize(&context.project_path).map_err(|_| {
        coded(
            "TERMINAL_PATH_CONTEXT_UNAVAILABLE",
            "The terminal project is unavailable",
        )
    })?;
    let candidate = requested_path(&root, raw_path)?;
    let target = std::fs::canonicalize(candidate).map_err(|_| {
        coded(
            "TERMINAL_PATH_UNAVAILABLE",
            "The terminal path is unavailable",
        )
    })?;

    let metadata = std::fs::metadata(&target).map_err(|_| {
        coded(
            "TERMINAL_PATH_UNAVAILABLE",
            "The terminal path is unavailable",
        )
    })?;
    let kind = if metadata.is_file() {
        TerminalPathKind::File
    } else if metadata.is_dir() {
        TerminalPathKind::Directory
    } else {
        return Err(coded(
            "TERMINAL_PATH_TYPE_UNSUPPORTED",
            "The terminal path type is unsupported",
        ));
    };
    let explicitly_external_directory = scope == TerminalPathScope::ExplicitAbsoluteDirectory
        && Path::new(raw_path.strip_prefix("\\\\?\\").unwrap_or(raw_path)).is_absolute()
        && !path_is_within(
            Path::new(raw_path.strip_prefix("\\\\?\\").unwrap_or(raw_path)),
            &root,
        )
        && kind == TerminalPathKind::Directory;
    if !path_is_within(&target, &root) && !explicitly_external_directory {
        return Err(coded(
            "TERMINAL_PATH_OUTSIDE_ROOT",
            "The terminal path is outside the session project",
        ));
    }

    Ok(ResolvedTerminalPathLink {
        canonical_path: simplify_path(target).to_string_lossy().to_string(),
        kind,
        runtime_kind: context.runtime_kind.clone(),
    })
}

pub fn resolve_terminal_path_link(
    context: &TerminalLinkContext,
    raw_path: &str,
) -> AppResult<ResolvedTerminalPathLink> {
    resolve_terminal_path_link_with_scope(context, raw_path, TerminalPathScope::ProjectOnly)
}

pub fn resolve_terminal_path_link_for_desktop(
    context: &TerminalLinkContext,
    raw_path: &str,
) -> AppResult<ResolvedTerminalPathLink> {
    resolve_terminal_path_link_with_scope(
        context,
        raw_path,
        TerminalPathScope::ExplicitAbsoluteDirectory,
    )
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::{
        has_invalid_windows_syntax, path_is_within, resolve_terminal_path_link, TerminalLinkContext,
    };
    use std::path::Path;

    #[test]
    fn containment_rejects_sibling_prefixes_and_other_drives() {
        let root = Path::new("C:\\repo");
        assert!(path_is_within(Path::new("c:\\repo\\src\\main.rs"), root));
        assert!(!path_is_within(Path::new("C:\\repo-other\\main.rs"), root));
        assert!(!path_is_within(Path::new("D:\\repo\\main.rs"), root));
    }

    #[test]
    fn containment_supports_wsl_unc_roots_without_prefix_confusion() {
        let root = Path::new("\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo");
        assert!(path_is_within(
            Path::new("\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo\\src\\main.rs"),
            root,
        ));
        assert!(!path_is_within(
            Path::new("\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo-other\\main.rs"),
            root,
        ));
    }

    #[test]
    fn windows_syntax_allows_only_verbatim_drive_paths() {
        assert!(!has_invalid_windows_syntax(r"\\?\F:\repo\src\main.rs"));
        assert!(has_invalid_windows_syntax(r"\\?\UNC\server\share\main.rs"));
        assert!(has_invalid_windows_syntax(r"\\?\Volume{abc}\main.rs"));
        assert!(has_invalid_windows_syntax(r"\\.\C:\repo\main.rs"));
    }

    #[test]
    fn resolves_verbatim_drive_path_inside_project() {
        let root = tempfile::tempdir().expect("project root");
        let target = root.path().join("target.txt");
        std::fs::write(&target, "ok").expect("target file");
        let context = TerminalLinkContext {
            project_path: root.path().to_string_lossy().to_string(),
            runtime_kind: "local".to_string(),
        };
        let raw_path = format!(r"\\?\{}", target.display());

        let resolved = resolve_terminal_path_link(&context, &raw_path).expect("resolve path");

        assert_eq!(resolved.kind, super::TerminalPathKind::File);
    }
}
