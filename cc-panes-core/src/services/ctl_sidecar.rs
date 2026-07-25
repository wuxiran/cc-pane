use std::ffi::OsString;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};

const ENABLE_ENV: &str = "CCPANES_MCP_PROXY";
const BINARY_ENV: &str = "CC_PANES_CTL_BINARY";

pub(super) fn inject_mcp_proxy_options(
    options: &mut std::collections::HashMap<String, serde_json::Value>,
    resource_dir: Option<&Path>,
) -> Result<Option<PathBuf>> {
    if !enabled_from_env() {
        return Ok(None);
    }

    let binary = resolve_ctl_binary(resource_dir)?;
    options.insert("mcpProxyEnabled".to_string(), serde_json::json!(true));
    options.insert(
        "mcpProxyCommand".to_string(),
        serde_json::json!(binary.to_string_lossy()),
    );
    Ok(Some(binary))
}

fn enabled_from_env() -> bool {
    std::env::var(ENABLE_ENV)
        .ok()
        .is_some_and(|value| is_truthy(&value))
}

fn is_truthy(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes"
    )
}

fn resolve_ctl_binary(resource_dir: Option<&Path>) -> Result<PathBuf> {
    let explicit = std::env::var_os(BINARY_ENV).filter(|value| !value.is_empty());
    resolve_ctl_binary_from(explicit, ctl_binary_candidates(resource_dir))
}

fn resolve_ctl_binary_from(
    explicit: Option<OsString>,
    candidates: impl IntoIterator<Item = PathBuf>,
) -> Result<PathBuf> {
    if let Some(explicit) = explicit {
        let path = PathBuf::from(explicit);
        if !path.is_absolute() {
            return Err(anyhow!(
                "{BINARY_ENV} 必须是绝对路径，当前值为 {}",
                path.display()
            ));
        }
        return existing_absolute_path(&path).ok_or_else(|| {
            anyhow!(
                "{BINARY_ENV} 指向的 cc-panes-ctl 不存在或不可解析：{}",
                path.display()
            )
        });
    }

    for candidate in candidates {
        if let Some(path) = existing_absolute_path(&candidate) {
            return Ok(path);
        }
    }

    Err(anyhow!(
        "已通过 {ENABLE_ENV} 启用 MCP 代理，但找不到 cc-panes-ctl；请先运行构建/复制脚本，或用 {BINARY_ENV} 指定绝对路径"
    ))
}

fn existing_absolute_path(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() || !path.is_file() {
        return None;
    }
    dunce::canonicalize(path).ok()
}

fn ctl_binary_candidates(resource_dir: Option<&Path>) -> Vec<PathBuf> {
    let name = ctl_binary_name();
    let mut candidates = Vec::new();

    if let Some(resource_dir) = resource_dir {
        candidates.push(resource_dir.join("binaries").join(name));
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            candidates.push(exe_dir.join("binaries").join(name));
            candidates.push(exe_dir.join(name));
            if exe_dir.file_name().is_some_and(|part| part == "deps") {
                if let Some(profile_dir) = exe_dir.parent() {
                    candidates.push(profile_dir.join(name));
                }
            }

            #[cfg(target_os = "macos")]
            if let Some(contents_dir) = exe_dir.parent() {
                candidates.push(contents_dir.join("Resources").join("binaries").join(name));
            }
        }
    }

    let workspace_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")));
    candidates.push(workspace_root.join("src-tauri").join("binaries").join(name));
    candidates
}

fn ctl_binary_name() -> &'static str {
    if cfg!(windows) {
        "cc-panes-ctl.exe"
    } else {
        "cc-panes-ctl"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_switch_is_opt_in() {
        assert!(is_truthy("1"));
        assert!(is_truthy(" TRUE "));
        assert!(is_truthy("yes"));
        assert!(!is_truthy("0"));
        assert!(!is_truthy("false"));
        assert!(!is_truthy(""));
    }

    #[test]
    fn explicit_binary_must_be_absolute() {
        let error = resolve_ctl_binary_from(Some(OsString::from("cc-panes-ctl")), []).unwrap_err();
        assert!(error.to_string().contains("必须是绝对路径"));
    }

    #[test]
    fn resolver_returns_canonical_absolute_candidate() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join(ctl_binary_name());
        std::fs::write(&binary, "test").unwrap();

        let resolved = resolve_ctl_binary_from(None, [binary.clone()]).unwrap();

        assert!(resolved.is_absolute());
        assert_eq!(resolved, dunce::canonicalize(binary).unwrap());
    }

    #[test]
    fn packaged_resource_candidate_has_priority() {
        let resource_dir = Path::new("/opt/cc-panes");
        let candidates = ctl_binary_candidates(Some(resource_dir));

        assert_eq!(
            candidates.first(),
            Some(&resource_dir.join("binaries").join(ctl_binary_name()))
        );
    }

    #[test]
    fn missing_binary_has_actionable_error() {
        let dir = tempfile::tempdir().unwrap();
        let error =
            resolve_ctl_binary_from(None, [dir.path().join(ctl_binary_name())]).unwrap_err();
        let message = error.to_string();
        assert!(message.contains(ENABLE_ENV));
        assert!(message.contains(BINARY_ENV));
    }
}
