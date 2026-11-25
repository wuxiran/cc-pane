//! ACP 官方注册表（<https://agentclientprotocol.com/get-started/registry>）浏览与安装。
//!
//! 安装 = 把注册表条目物化成 `<data>/agent-chats/engines.json` 里的一条自定义引擎：
//! - `npx` / `uvx` 分发：直接登记 `npx -y <pkg> <args>` / `uvx <pkg> <args>`，版本由注册表 pin 死；
//! - `binary` 分发：下载当前平台的归档 → 校验 sha256 → 解压到
//!   `<data>/agent-chats/registry/agents/<id>/<version>/`，登记绝对路径。
//!
//! 内置引擎已覆盖的 agent（Claude、Codex、Kiro……）标成 `builtInEngineId`，不重复安装
//! ——内置条目的启动参数是验证过的（同 T3 Code 的做法）。
//!
//! 注册表条目是第三方代码：安装前 UI 会展示仓库与许可证，这里只负责校验完整性。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::State;

use crate::utils::{AppError, AppResult};
use cc_panes_core::utils::atomic_file::write_atomic;
use cc_panes_core::utils::AppPaths;

const ACP_REGISTRY_URL: &str =
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
/// 注册表引擎 id 前缀：与内置 id、用户手写的自定义 id 隔开，卸载时只认这个前缀。
const REGISTRY_ENGINE_PREFIX: &str = "acp-registry-";

/// 注册表 id → 已内置的引擎 id。这些 agent 走内置条目，不从注册表重复装。
const BUILT_IN_ALIASES: &[(&str, &str)] = &[
    ("claude-acp", "claude"),
    ("codex-acp", "codex"),
    ("gemini", "gemini"),
    ("qwen-code", "qwen"),
    ("opencode", "opencode"),
    ("github-copilot-cli", "copilot"),
    ("cursor", "cursor"),
    ("kimi", "kimi"),
    ("pi-acp", "pi"),
    ("grok-build", "grok"),
    ("kiro", "kiro"),
    ("muse-code", "muse"),
    ("antigravity-acp", "antigravity"),
];

/// 置顶推荐：本地没有内置条目、但用户最可能要的（Antigravity 已内置为 `agy acp`）。
const FEATURED: &[&str] = &["goose", "amp-acp", "factory-droid", "cline"];

#[derive(Debug, Clone, Deserialize)]
struct Registry {
    #[serde(default)]
    agents: Vec<RegistryAgent>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
struct RegistryAgent {
    id: String,
    name: String,
    version: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    repository: Option<String>,
    #[serde(default)]
    website: Option<String>,
    #[serde(default)]
    license: Option<String>,
    #[serde(default)]
    icon: Option<String>,
    #[serde(default)]
    distribution: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Deserialize)]
struct PackageDistribution {
    package: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
struct BinaryTarget {
    archive: String,
    cmd: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistryAgentInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub repository: Option<String>,
    pub website: Option<String>,
    pub license: Option<String>,
    pub icon_url: Option<String>,
    /// 当前平台可用的分发方式（npx / uvx / binary）；None = 本机装不了。
    pub distribution: Option<String>,
    /// 已被内置引擎覆盖时给出内置 id，UI 显示「内置」而非「安装」。
    pub built_in_engine_id: Option<String>,
    /// 已从注册表安装时的版本。
    pub installed_version: Option<String>,
    pub featured: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistryListing {
    pub agents: Vec<AcpRegistryAgentInfo>,
    /// 拉取失败、退回本地缓存时为 true（UI 提示「离线数据」）。
    pub from_cache: bool,
}

fn registry_dir(app_paths: &AppPaths) -> PathBuf {
    app_paths.data_dir().join("agent-chats").join("registry")
}

fn engines_json_path(app_paths: &AppPaths) -> PathBuf {
    app_paths
        .data_dir()
        .join("agent-chats")
        .join("engines.json")
}

pub fn registry_engine_id(agent_id: &str) -> String {
    format!("{REGISTRY_ENGINE_PREFIX}{agent_id}")
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// 注册表平台键（registry.json `distribution.binary` 的 key）。
fn platform_key() -> Option<&'static str> {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "linux" => "linux",
        "windows" => "windows",
        _ => return None,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "aarch64",
        "x86_64" => "x86_64",
        _ => return None,
    };
    Some(match (os, arch) {
        ("darwin", "aarch64") => "darwin-aarch64",
        ("darwin", _) => "darwin-x86_64",
        ("linux", "aarch64") => "linux-aarch64",
        ("linux", _) => "linux-x86_64",
        ("windows", "aarch64") => "windows-aarch64",
        _ => "windows-x86_64",
    })
}

/// 选当前平台可用的分发方式：包管理器优先（无需下载、升级跟着 pin 走），二进制兜底。
fn pick_distribution(agent: &RegistryAgent) -> Option<&'static str> {
    if agent.distribution.contains_key("npx") {
        return Some("npx");
    }
    if agent.distribution.contains_key("uvx") {
        return Some("uvx");
    }
    let key = platform_key()?;
    agent
        .distribution
        .get("binary")
        .and_then(|binary| binary.get(key))
        .map(|_| "binary")
}

async fn fetch_registry(app_paths: &AppPaths) -> (Option<Registry>, bool) {
    let cache_path = registry_dir(app_paths).join("registry.json");
    let fetched = async {
        let response = http_client()
            .get(ACP_REGISTRY_URL)
            .timeout(Duration::from_secs(20))
            .send()
            .await?
            .error_for_status()?;
        response.bytes().await
    }
    .await;
    match fetched {
        Ok(bytes) => match serde_json::from_slice::<Registry>(&bytes) {
            Ok(registry) => {
                if let Err(error) = write_atomic(&cache_path, &bytes) {
                    tracing::warn!(error = %error, "failed to cache ACP registry");
                }
                return (Some(registry), false);
            }
            Err(error) => tracing::warn!(error = %error, "ACP registry payload is not valid JSON"),
        },
        Err(error) => {
            tracing::warn!(error = %error, "failed to fetch ACP registry; falling back to cache")
        }
    }
    let cached = std::fs::read(&cache_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Registry>(&bytes).ok());
    (cached, true)
}

fn read_engines_json(app_paths: &AppPaths) -> AppResult<Vec<Value>> {
    let path = engines_json_path(app_paths);
    match std::fs::read_to_string(&path) {
        Ok(raw) if raw.trim().is_empty() => Ok(Vec::new()),
        Ok(raw) => serde_json::from_str::<Vec<Value>>(&raw).map_err(|error| {
            // 用户手写坏了的 engines.json 不能被我们覆盖掉——报错让用户先修。
            AppError::coded(
                "ACP_ENGINES_JSON_INVALID",
                format!("{} is not a valid JSON array: {error}", path.display()),
            )
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(AppError::from(error.to_string())),
    }
}

fn write_engines_json(app_paths: &AppPaths, engines: &[Value]) -> AppResult<()> {
    let body =
        serde_json::to_vec_pretty(engines).map_err(|error| AppError::from(error.to_string()))?;
    write_atomic(&engines_json_path(app_paths), body)
        .map_err(|error| AppError::from(error.to_string()))
}

fn installed_versions(app_paths: &AppPaths) -> BTreeMap<String, String> {
    read_engines_json(app_paths)
        .unwrap_or_default()
        .iter()
        .filter_map(|engine| {
            let registry_id = engine.get("registryId")?.as_str()?.to_string();
            let version = engine.get("registryVersion")?.as_str()?.to_string();
            Some((registry_id, version))
        })
        .collect()
}

#[tauri::command]
pub async fn list_acp_registry_agents(
    app_paths: State<'_, Arc<AppPaths>>,
) -> AppResult<AcpRegistryListing> {
    let app_paths = app_paths.inner().clone();
    let (registry, from_cache) = fetch_registry(&app_paths).await;
    let Some(registry) = registry else {
        return Err(AppError::coded(
            "ACP_REGISTRY_UNAVAILABLE",
            "ACP registry could not be fetched and no cached copy exists",
        ));
    };
    let installed = installed_versions(&app_paths);
    let mut agents: Vec<AcpRegistryAgentInfo> = registry
        .agents
        .iter()
        .map(|agent| AcpRegistryAgentInfo {
            built_in_engine_id: BUILT_IN_ALIASES
                .iter()
                .find(|(registry_id, _)| *registry_id == agent.id)
                .map(|(_, engine_id)| engine_id.to_string()),
            installed_version: installed.get(&agent.id).cloned(),
            distribution: pick_distribution(agent).map(str::to_string),
            featured: FEATURED.contains(&agent.id.as_str()),
            id: agent.id.clone(),
            name: agent.name.clone(),
            version: agent.version.clone(),
            description: agent.description.clone(),
            repository: agent.repository.clone(),
            website: agent.website.clone(),
            license: agent.license.clone(),
            icon_url: agent.icon.clone(),
        })
        .collect();
    // 推荐 → 可装 → 其余；组内按名字。内置的沉底（它们已经在引擎列表里了）。
    agents.sort_by_key(|agent| {
        (
            agent.built_in_engine_id.is_some(),
            !agent.featured,
            agent.distribution.is_none(),
            agent.name.to_lowercase(),
        )
    });
    Ok(AcpRegistryListing { agents, from_cache })
}

fn verify_sha256(bytes: &[u8], expected: Option<&str>) -> AppResult<()> {
    let Some(expected) = expected.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    let actual = hex_lower(&Sha256::digest(bytes));
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(AppError::coded(
            "ACP_REGISTRY_CHECKSUM_MISMATCH",
            format!("sha256 mismatch: expected {expected}, got {actual}"),
        ))
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 归档类型按魔数判（Muse 的下载 URL 是查询串，没有扩展名可看）。
fn archive_kind(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x1f, 0x8b]) {
        "tar.gz"
    } else if bytes.starts_with(b"BZh") {
        "tar.bz2"
    } else if bytes.starts_with(b"PK\x03\x04") {
        "zip"
    } else if bytes.starts_with(&[0xfd, b'7', b'z', b'X', b'Z', 0x00]) {
        "tar.xz"
    } else {
        "raw"
    }
}

/// 解压交给系统 `tar`（bsdtar/GNU tar 都认 gz/bz2/xz；macOS、Windows 10+ 的 bsdtar 也认 zip），
/// Linux GNU tar 解不了 zip 时退回 `unzip`。不引入额外的解压 crate。
fn extract_archive(archive: &Path, kind: &str, target: &Path) -> AppResult<()> {
    let run = |program: &str, args: &[&std::ffi::OsStr]| -> bool {
        cc_panes_core::utils::no_window_command(program)
            .args(args)
            .status()
            .is_ok_and(|status| status.success())
    };
    let archive_os = archive.as_os_str();
    let target_os = target.as_os_str();
    let ok = run(
        "tar",
        &["-xf".as_ref(), archive_os, "-C".as_ref(), target_os],
    ) || (kind == "zip"
        && run(
            "unzip",
            &[
                "-q".as_ref(),
                "-o".as_ref(),
                archive_os,
                "-d".as_ref(),
                target_os,
            ],
        ));
    if ok {
        Ok(())
    } else {
        Err(AppError::coded(
            "ACP_REGISTRY_EXTRACT_FAILED",
            format!("failed to extract {} ({kind})", archive.display()),
        ))
    }
}

#[cfg(unix)]
fn make_executable(path: &Path) -> AppResult<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = std::fs::metadata(path)
        .map_err(|error| AppError::from(error.to_string()))?
        .permissions();
    permissions.set_mode(permissions.mode() | 0o755);
    std::fs::set_permissions(path, permissions).map_err(|error| AppError::from(error.to_string()))
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> AppResult<()> {
    Ok(())
}

/// 二进制分发：下载 → 校验 → 解压（或裸二进制直接落盘）→ 返回可执行文件绝对路径。
async fn install_binary(
    app_paths: &AppPaths,
    agent: &RegistryAgent,
    target: &BinaryTarget,
) -> AppResult<PathBuf> {
    let response = http_client()
        .get(&target.archive)
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|error| AppError::coded("ACP_REGISTRY_DOWNLOAD_FAILED", error.to_string()))?;
    let bytes = response
        .bytes()
        .await
        .map_err(|error| AppError::coded("ACP_REGISTRY_DOWNLOAD_FAILED", error.to_string()))?;
    verify_sha256(&bytes, target.sha256.as_deref())?;

    let install_dir = registry_dir(app_paths)
        .join("agents")
        .join(&agent.id)
        .join(&agent.version);
    let staging = install_dir.with_extension("staging");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|error| AppError::from(error.to_string()))?;

    let kind = archive_kind(&bytes);
    let cmd_relative = target.cmd.trim_start_matches("./");
    if kind == "raw" {
        let binary_path = staging.join(cmd_relative);
        if let Some(parent) = binary_path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| AppError::from(error.to_string()))?;
        }
        std::fs::write(&binary_path, &bytes).map_err(|error| AppError::from(error.to_string()))?;
    } else {
        let archive_path = staging.join(format!("download.{kind}"));
        std::fs::write(&archive_path, &bytes).map_err(|error| AppError::from(error.to_string()))?;
        let extract = {
            let archive_path = archive_path.clone();
            let staging = staging.clone();
            tauri::async_runtime::spawn_blocking(move || {
                extract_archive(&archive_path, kind, &staging)
            })
        };
        extract
            .await
            .map_err(|error| AppError::from(error.to_string()))??;
        let _ = std::fs::remove_file(&archive_path);
    }

    let staged_binary = staging.join(cmd_relative);
    if !staged_binary.is_file() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(AppError::coded(
            "ACP_REGISTRY_BINARY_MISSING",
            format!("archive did not contain {}", target.cmd),
        ));
    }
    make_executable(&staged_binary)?;

    // 原子换位：先清旧目录再把 staging 改名过去，避免装到一半的目录被当成可用。
    let _ = std::fs::remove_dir_all(&install_dir);
    std::fs::rename(&staging, &install_dir).map_err(|error| AppError::from(error.to_string()))?;
    Ok(install_dir.join(cmd_relative))
}

#[tauri::command]
pub async fn install_acp_registry_agent(
    app_paths: State<'_, Arc<AppPaths>>,
    agent_id: String,
) -> AppResult<String> {
    let app_paths = app_paths.inner().clone();
    let (registry, _) = fetch_registry(&app_paths).await;
    let registry = registry.ok_or_else(|| {
        AppError::coded("ACP_REGISTRY_UNAVAILABLE", "ACP registry is unavailable")
    })?;
    let agent = registry
        .agents
        .into_iter()
        .find(|agent| agent.id == agent_id)
        .ok_or_else(|| {
            AppError::coded(
                "ACP_REGISTRY_UNKNOWN_AGENT",
                format!("Unknown agent: {agent_id}"),
            )
        })?;
    if let Some((_, engine_id)) = BUILT_IN_ALIASES.iter().find(|(id, _)| *id == agent.id) {
        return Err(AppError::coded(
            "ACP_REGISTRY_BUILT_IN",
            format!("{} is already a built-in engine ({engine_id})", agent.name),
        ));
    }
    let distribution = pick_distribution(&agent).ok_or_else(|| {
        AppError::coded(
            "ACP_REGISTRY_UNSUPPORTED_PLATFORM",
            format!("{} has no distribution for this platform", agent.name),
        )
    })?;

    let (executable, args, env, requirement) = match distribution {
        "npx" | "uvx" => {
            let dist: PackageDistribution =
                serde_json::from_value(agent.distribution[distribution].clone())
                    .map_err(|error| AppError::from(error.to_string()))?;
            let mut args = Vec::new();
            if distribution == "npx" {
                args.push("-y".to_string());
            }
            args.push(dist.package.clone());
            args.extend(dist.args);
            let requirement = if distribution == "npx" {
                "npm (npx)"
            } else {
                "uv (uvx)"
            };
            (
                distribution.to_string(),
                args,
                dist.env,
                format!("{requirement} · ACP Registry {}", agent.version),
            )
        }
        _ => {
            let key = platform_key().unwrap_or_default();
            let target: BinaryTarget =
                serde_json::from_value(agent.distribution["binary"][key].clone())
                    .map_err(|error| AppError::from(error.to_string()))?;
            let path = install_binary(&app_paths, &agent, &target).await?;
            (
                path.to_string_lossy().into_owned(),
                target.args,
                target.env,
                format!("ACP Registry {} (downloaded binary)", agent.version),
            )
        }
    };

    let engine_id = registry_engine_id(&agent.id);
    let entry = serde_json::json!({
        "id": engine_id,
        "label": agent.name,
        "executable": executable,
        "args": args,
        "env": env,
        "requirement": requirement,
        "registryId": agent.id,
        "registryVersion": agent.version,
    });
    let mut engines = read_engines_json(&app_paths)?;
    engines.retain(|engine| engine.get("id").and_then(Value::as_str) != Some(engine_id.as_str()));
    engines.push(entry);
    write_engines_json(&app_paths, &engines)?;
    Ok(engine_id)
}

#[tauri::command]
pub async fn uninstall_acp_registry_agent(
    app_paths: State<'_, Arc<AppPaths>>,
    agent_id: String,
) -> AppResult<()> {
    let app_paths = app_paths.inner().clone();
    let engine_id = registry_engine_id(&agent_id);
    let mut engines = read_engines_json(&app_paths)?;
    let before = engines.len();
    engines.retain(|engine| engine.get("id").and_then(Value::as_str) != Some(engine_id.as_str()));
    if engines.len() != before {
        write_engines_json(&app_paths, &engines)?;
    }
    // agent_id 来自注册表（不含路径分隔符），仍然防一手路径穿越。
    if !agent_id.is_empty() && !agent_id.contains(['/', '\\']) && agent_id != ".." {
        let _ = std::fs::remove_dir_all(registry_dir(&app_paths).join("agents").join(&agent_id));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(distribution: Value) -> RegistryAgent {
        serde_json::from_value(serde_json::json!({
            "id": "demo",
            "name": "Demo",
            "version": "1.0.0",
            "distribution": distribution,
        }))
        .unwrap()
    }

    #[test]
    fn package_managers_win_over_binaries() {
        let picked = pick_distribution(&agent(serde_json::json!({
            "binary": {"darwin-aarch64": {"archive": "x", "cmd": "./x"}},
            "uvx": {"package": "demo"},
            "npx": {"package": "demo"},
        })));
        assert_eq!(picked, Some("npx"));
    }

    #[test]
    fn binary_without_this_platform_is_unavailable() {
        let picked = pick_distribution(&agent(serde_json::json!({
            "binary": {"plan9-mips": {"archive": "x", "cmd": "./x"}},
        })));
        assert_eq!(picked, None);
    }

    #[test]
    fn archive_kind_is_sniffed_from_magic_bytes() {
        assert_eq!(archive_kind(&[0x1f, 0x8b, 0]), "tar.gz");
        assert_eq!(archive_kind(b"BZh91AY"), "tar.bz2");
        assert_eq!(archive_kind(b"PK\x03\x04rest"), "zip");
        assert_eq!(archive_kind(b"\xcf\xfa\xed\xfe"), "raw");
    }

    #[test]
    fn checksum_mismatch_is_rejected_and_missing_checksum_is_allowed() {
        let digest = hex_lower(&Sha256::digest(b"hello"));
        assert!(verify_sha256(b"hello", Some(&digest)).is_ok());
        assert!(verify_sha256(b"hello", Some(&digest.to_uppercase())).is_ok());
        assert!(verify_sha256(b"hello", None).is_ok());
        assert!(verify_sha256(b"tampered", Some(&digest)).is_err());
    }

    #[test]
    fn built_in_aliases_point_at_real_engines() {
        // 内置别名必须指向真实存在的内置 id，否则注册表里会把它标成「内置」却选不到。
        let built_in: Vec<&str> = super::super::acp_chat_commands::built_in_engine_ids().collect();
        for (_, engine_id) in BUILT_IN_ALIASES {
            assert!(
                built_in.contains(engine_id),
                "{engine_id} is not a built-in ACP engine"
            );
        }
    }
}
