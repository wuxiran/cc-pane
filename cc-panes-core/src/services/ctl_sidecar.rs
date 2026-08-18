use std::ffi::OsString;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};

const ENABLE_ENV: &str = "CCPANES_MCP_PROXY";
const BINARY_ENV: &str = "CC_PANES_CTL_BINARY";
/// 会话内 `CC_PANES_CTL` 注入的逃生阀。默认开启，设为 0/false/no 关闭。
const SESSION_ENV_SWITCH: &str = "CCPANES_SESSION_CTL_ENV";
/// 注入给 PTY 会话的变量名：cc-panes-ctl 的绝对路径。
pub(super) const SESSION_CTL_ENV_KEY: &str = "CC_PANES_CTL";

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

/// 往 PTY 会话环境里注入 `CC_PANES_CTL`（cc-panes-ctl 的绝对路径），让会话内的
/// 人与 AI 能直接 `"$CC_PANES_CTL" status`，无需知道安装目录。
///
/// 与 MCP 代理注入链**刻意隔离**，三点差异不要"顺手统一"：
/// 1. 不受 `CCPANES_MCP_PROXY` 门控——那是「改变所有会话 MCP 连接方式」的高影响
///    开关，与「CLI 能不能被敲到」无关；
/// 2. 找不到二进制返回 `None` 而非 `Err`——ctl 缺失绝不该阻断用户开终端；
/// 3. 只写这一个变量，**不碰 `PATH`**。Windows 上 portable-pty 的 `get_base_env()`
///    会从注册表重新拼装 system+user PATH（`cmdbuilder.rs` 的 `path` 特判），我们
///    若显式写 `PATH` 会以 `is_from_base_env: false` 的高优先级**整条覆盖**掉那份
///    更完整、更新鲜的值，用户表现为"某些命令在 CC-Panes 终端里突然找不到"且零报错。
///
/// SSH 会话不注入：PTY 里跑的是本地 ssh 客户端，路径对远端主机无意义。
pub(super) fn session_ctl_env_value(resource_dir: Option<&Path>, is_ssh: bool) -> Option<String> {
    if is_ssh || !session_env_enabled() {
        return None;
    }
    resolve_ctl_binary(resource_dir)
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
}

/// 逃生阀：默认开启，显式设成 0/false/no 才关闭。
///
/// 与 `ENABLE_ENV` 的默认值相反是**有意的**——MCP 代理默认关是因为它改变所有会话的
/// MCP 连接方式（高影响）；这里只是给会话多一个环境变量，关掉标签即消失（低影响）。
fn session_env_enabled() -> bool {
    match std::env::var(SESSION_ENV_SWITCH) {
        Ok(value) if !value.trim().is_empty() => is_truthy(&value),
        _ => true,
    }
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
    fn session_env_is_skipped_for_ssh() {
        // is_ssh 必须先于 env 判定短路：远端主机上没有这个二进制，注入等于给错路径。
        assert_eq!(session_ctl_env_value(None, true), None);
    }

    #[test]
    fn session_env_switch_defaults_on_when_unset_or_blank() {
        // 与 CCPANES_MCP_PROXY 相反：缺省/空串都算开启，只有显式 falsy 才关。
        assert!(!is_truthy("0"));
        assert!(!is_truthy("false"));
        assert!(!is_truthy("no"));
        assert!(is_truthy("1"));
    }

    #[test]
    fn exe_sibling_candidate_survives_without_resource_dir() {
        // daemon 模式下 `set_sidecar_resource_dir` 从未被调用（只有 app 调，见
        // src-tauri/src/lib.rs），而 create_session 实际跑在 daemon 进程里 ——
        // 此时 resource_dir 恒为 None，全靠 `current_exe()` 同目录这个候选兜底。
        // 它一旦被当作"冗余候选"删掉，MCP 代理与 CC_PANES_CTL 会**同时静默失效**。
        let candidates = ctl_binary_candidates(None);
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(Path::to_path_buf))
            .expect("current_exe has a parent");

        assert!(
            candidates.contains(&exe_dir.join(ctl_binary_name())),
            "exe 同目录候选丢失会让 daemon 模式静默失效: {candidates:?}"
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
