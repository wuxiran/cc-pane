#![cfg_attr(not(windows), allow(dead_code))]

#[cfg(windows)]
use super::cached_which;
use super::TerminalService;
use crate::models::{CliTool, WslLaunchInfo};
#[cfg(windows)]
use crate::services::default_skill_service::{BUNDLED_NAMESPACE, VERSION_FILE_NAME};
use anyhow::{anyhow, Result};
use std::collections::HashMap;
#[cfg(windows)]
use std::path::Path;
use std::path::PathBuf;
#[cfg(windows)]
use tracing::{info, warn};

/// 探活结果缓存 TTL：宿主网络拓扑短期内稳定，5 分钟内复用结果，
/// 避免每次 create_session 都冷跑一次 wsl.exe（daemon 模式下这是 2s 超时的主要推手）。
#[cfg(windows)]
const WSL_HOST_PROBE_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(300);
#[cfg(windows)]
static WSL_HOST_PROBE_CACHE: std::sync::OnceLock<WslHostProbeCache> = std::sync::OnceLock::new();

/// WSL→Windows 宿主探活结果缓存（进程级）。key 带 port 是因为 orchestrator
/// 端口随宿主 app 重启变化，而 daemon 进程存活期可能跨越宿主重启。
/// 只缓存探活**成功**的结果；失败/回退不缓存，下次仍会重试。
pub(super) struct WslHostProbeCache {
    entries: std::sync::Mutex<HashMap<(String, u16), (String, std::time::Instant)>>,
}

impl WslHostProbeCache {
    pub(super) fn new() -> Self {
        Self {
            entries: std::sync::Mutex::new(HashMap::new()),
        }
    }

    pub(super) fn get_or_probe(
        &self,
        distro: &str,
        port: u16,
        ttl: std::time::Duration,
        probe: impl FnOnce() -> Option<String>,
    ) -> Option<String> {
        let key = (distro.to_string(), port);
        if let Ok(entries) = self.entries.lock() {
            if let Some((host, at)) = entries.get(&key) {
                if at.elapsed() < ttl {
                    return Some(host.clone());
                }
            }
        }
        let host = probe()?;
        if let Ok(mut entries) = self.entries.lock() {
            entries.insert(key, (host.clone(), std::time::Instant::now()));
        }
        Some(host)
    }
}

pub(super) const WSL_BASH_EVAL_FLAG: &str = "-lic";
#[cfg(windows)]
pub(super) const WSL_BASH_LOGIN_FLAG: &str = "-l";
pub(super) const WSL_PROXY_ENV_KEYS: [&str; 8] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
];

#[derive(Debug, Clone)]
pub(super) struct ResolvedWslLaunch {
    pub(super) wsl_path: PathBuf,
    pub(super) distro: String,
    pub(super) remote_path: String,
    pub(super) workspace_remote_path: Option<String>,
    pub(super) windows_host: Option<String>,
}

fn is_wsl_proxy_env_key(key: &str) -> bool {
    WSL_PROXY_ENV_KEYS
        .iter()
        .any(|candidate| key.eq_ignore_ascii_case(candidate))
}

pub(super) fn strip_wsl_proxy_env_vars(env_vars: &mut HashMap<String, String>) {
    env_vars.retain(|key, _| !is_wsl_proxy_env_key(key));
}

pub(super) fn build_wsl_mcp_url(windows_host: &str, port: &str, token: &str) -> String {
    format!("http://{}:{}/mcp?token={}", windows_host, port, token)
}

/// WSL 内跑的探活脚本：收集候选宿主地址，逐个对 orchestrator `/api/health` 发最小 HTTP
/// 请求，命中本 orchestrator 独有的 `{"status":"ok"}` 就 echo 该 host 并退出。
/// `$1` = 端口。全程带 `timeout 1` 逐候选兜底，缺 bash/timeout 则整体失败（调用方回退）。
fn wsl_host_probe_script() -> &'static str {
    r#"port="$1"
gw=$(ip route show default 2>/dev/null | awk '/default/ {print $3; exit}')
ns=$(awk '/^nameserver/ {print $2}' /etc/resolv.conf 2>/dev/null)
for h in 127.0.0.1 $gw $ns; do
  [ -n "$h" ] || continue
  resp=$(timeout 1 bash -c "exec 3<>/dev/tcp/$h/$port && printf 'GET /api/health HTTP/1.0\r\nConnection: close\r\n\r\n' >&3 && head -c 256 <&3" 2>/dev/null)
  case "$resp" in *'"status"'*) printf '%s' "$h"; exit 0;; esac
done
exit 1
"#
}

/// 把探活脚本 base64 编码后包进一条 `bash -c` 参数，彻底避开 wsl.exe→bash 的引号地狱。
/// 结果形如 `echo <base64> | base64 -d | bash -s <port>`，只含字母数字/`+//=`/管道/空格。
#[cfg(windows)]
fn wsl_host_probe_bash_arg(port: u16) -> String {
    use base64::Engine as _;
    let encoded = base64::engine::general_purpose::STANDARD.encode(wsl_host_probe_script());
    format!("echo {encoded} | base64 -d | bash -s {port}")
}

#[cfg(windows)]
fn probe_reachable_wsl_windows_host(
    wsl_path: &std::path::Path,
    distro: &str,
    port: u16,
) -> Option<String> {
    let arg = wsl_host_probe_bash_arg(port);
    let output = crate::utils::no_window_command(wsl_path)
        .args(["-d", distro, "bash", "-c", &arg])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let host = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

#[cfg(windows)]
fn rewrite_local_mcp_url_for_wsl(url: &str, windows_host: &str) -> String {
    for prefix in ["http://127.0.0.1:", "http://localhost:", "http://[::1]:"] {
        if let Some(rest) = url.strip_prefix(prefix) {
            return format!("http://{}:{}", windows_host, rest);
        }
    }
    url.to_string()
}

fn shell_escape_posix(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn sanitize_wsl_script_component(value: &str) -> String {
    let sanitized = value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .collect::<String>();
    if sanitized.is_empty() {
        "session".to_string()
    } else {
        sanitized
    }
}

fn render_wsl_launch_script(commands: &[String]) -> String {
    let mut script = String::from("#!/usr/bin/env bash\nset -e\n");
    for command in commands {
        script.push_str(command);
        script.push('\n');
    }
    script
}

#[cfg(windows)]
fn push_wsl_env_exports(remote_parts: &mut Vec<String>, env_vars: &HashMap<String, String>) {
    let mut keys = env_vars.keys().collect::<Vec<_>>();
    keys.sort();
    for key in keys {
        if TerminalService::is_valid_env_key(key) {
            if let Some(value) = env_vars.get(key) {
                remote_parts.push(format!(
                    "export {}={}",
                    key,
                    TerminalService::shell_escape(value)
                ));
            }
        } else {
            warn!("Skipping WSL env var with invalid key: {}", key);
        }
    }
}

#[cfg(windows)]
fn push_wsl_ccpanes_env_exports(
    remote_parts: &mut Vec<String>,
    env_vars: &HashMap<String, String>,
) {
    let mut keys = env_vars
        .keys()
        .filter(|key| key.starts_with("CC_PANES_"))
        .collect::<Vec<_>>();
    keys.sort();
    for key in keys {
        if TerminalService::is_valid_env_key(key) {
            if let Some(value) = env_vars.get(key) {
                remote_parts.push(format!(
                    "export {}={}",
                    key,
                    TerminalService::shell_escape(value)
                ));
            }
        }
    }
}

#[cfg(windows)]
fn collect_wsl_claude_source_files(source_dir: &Path) -> Result<Vec<String>> {
    let version_path = source_dir.join(VERSION_FILE_NAME);
    if !version_path.is_file() {
        return Err(anyhow!(
            "Bundled Claude command source is missing version stamp: {}",
            version_path.display()
        ));
    }

    let mut files = Vec::new();
    for entry in std::fs::read_dir(source_dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("md") {
            if let Some(file_name) = path.file_name().and_then(|name| name.to_str()) {
                files.push(file_name.to_string());
            }
        }
    }

    files.sort();
    if files.is_empty() {
        return Err(anyhow!(
            "Bundled Claude command source is empty: {}",
            source_dir.display()
        ));
    }

    Ok(files)
}

#[cfg(windows)]
fn collect_wsl_codex_source_dirs(source_root: &Path) -> Result<Vec<String>> {
    let version_path = source_root.join(VERSION_FILE_NAME);
    if !version_path.is_file() {
        return Err(anyhow!(
            "Bundled Codex skill source is missing version stamp: {}",
            version_path.display()
        ));
    }

    let prefix = format!("{}-", BUNDLED_NAMESPACE);
    let mut dirs = Vec::new();
    for entry in std::fs::read_dir(source_root)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let Some(dir_name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !dir_name.starts_with(&prefix) || !path.join("SKILL.md").is_file() {
            continue;
        }
        dirs.push(dir_name.to_string());
    }

    dirs.sort();
    if dirs.is_empty() {
        return Err(anyhow!(
            "Bundled Codex skill source is empty: {}",
            source_root.display()
        ));
    }

    Ok(dirs)
}

#[cfg(windows)]
fn build_wsl_claude_skill_sync_prelude(
    source_wsl_path: &str,
    file_names: &[String],
) -> Vec<String> {
    let mut commands = vec![
        format!(
            "CCPANES_WSL_CLAUDE_SRC={}",
            shell_escape_posix(source_wsl_path)
        ),
        format!(
            "CCPANES_WSL_CLAUDE_DST=\"$HOME/.claude/commands/{}\"",
            BUNDLED_NAMESPACE
        ),
        format!(
            "CCPANES_WSL_DEFAULT_SKILLS_VERSION_FILE={}",
            shell_escape_posix(VERSION_FILE_NAME)
        ),
        "CCPANES_WSL_NEEDS_SYNC=0".to_string(),
        "if [ ! -f \"$CCPANES_WSL_CLAUDE_DST/$CCPANES_WSL_DEFAULT_SKILLS_VERSION_FILE\" ]; then CCPANES_WSL_NEEDS_SYNC=1; fi".to_string(),
        "if [ \"$CCPANES_WSL_NEEDS_SYNC\" -eq 0 ] && [ \"$(cat \"$CCPANES_WSL_CLAUDE_SRC/$CCPANES_WSL_DEFAULT_SKILLS_VERSION_FILE\")\" != \"$(cat \"$CCPANES_WSL_CLAUDE_DST/$CCPANES_WSL_DEFAULT_SKILLS_VERSION_FILE\")\" ]; then CCPANES_WSL_NEEDS_SYNC=1; fi".to_string(),
    ];

    for file_name in file_names {
        commands.push(format!(
            "if [ \"$CCPANES_WSL_NEEDS_SYNC\" -eq 0 ] && [ ! -f \"$CCPANES_WSL_CLAUDE_DST/{}\" ]; then CCPANES_WSL_NEEDS_SYNC=1; fi",
            file_name
        ));
    }

    commands.push(
        "if [ \"$CCPANES_WSL_NEEDS_SYNC\" -eq 1 ]; then mkdir -p \"$CCPANES_WSL_CLAUDE_DST\"; fi"
            .to_string(),
    );
    commands.push("if [ \"$CCPANES_WSL_NEEDS_SYNC\" -eq 1 ]; then find \"$CCPANES_WSL_CLAUDE_DST\" -maxdepth 1 -type f -name '*.md' -delete; fi".to_string());
    for file_name in file_names {
        commands.push(format!(
            "if [ \"$CCPANES_WSL_NEEDS_SYNC\" -eq 1 ]; then cp \"$CCPANES_WSL_CLAUDE_SRC/{}\" \"$CCPANES_WSL_CLAUDE_DST/{}\"; fi",
            file_name, file_name
        ));
    }
    commands.push("if [ \"$CCPANES_WSL_NEEDS_SYNC\" -eq 1 ]; then cp \"$CCPANES_WSL_CLAUDE_SRC/$CCPANES_WSL_DEFAULT_SKILLS_VERSION_FILE\" \"$CCPANES_WSL_CLAUDE_DST/$CCPANES_WSL_DEFAULT_SKILLS_VERSION_FILE\"; fi".to_string());

    commands
}

#[cfg(windows)]
fn build_wsl_codex_skill_sync_prelude(source_wsl_path: &str, dir_names: &[String]) -> Vec<String> {
    let mut commands = vec![
        format!(
            "CCPANES_WSL_CODEX_SRC={}",
            shell_escape_posix(source_wsl_path)
        ),
        "CCPANES_WSL_CODEX_DST=\"${CODEX_HOME:-$HOME/.codex}/skills\"".to_string(),
        format!(
            "CCPANES_WSL_DEFAULT_SKILLS_VERSION_FILE={}",
            shell_escape_posix(VERSION_FILE_NAME)
        ),
        "CCPANES_WSL_NEEDS_SYNC=0".to_string(),
        "if [ ! -f \"$CCPANES_WSL_CODEX_DST/$CCPANES_WSL_DEFAULT_SKILLS_VERSION_FILE\" ]; then CCPANES_WSL_NEEDS_SYNC=1; fi".to_string(),
        "if [ \"$CCPANES_WSL_NEEDS_SYNC\" -eq 0 ] && [ \"$(cat \"$CCPANES_WSL_CODEX_SRC/$CCPANES_WSL_DEFAULT_SKILLS_VERSION_FILE\")\" != \"$(cat \"$CCPANES_WSL_CODEX_DST/$CCPANES_WSL_DEFAULT_SKILLS_VERSION_FILE\")\" ]; then CCPANES_WSL_NEEDS_SYNC=1; fi".to_string(),
    ];

    for dir_name in dir_names {
        commands.push(format!(
            "if [ \"$CCPANES_WSL_NEEDS_SYNC\" -eq 0 ] && [ ! -f \"$CCPANES_WSL_CODEX_DST/{}/SKILL.md\" ]; then CCPANES_WSL_NEEDS_SYNC=1; fi",
            dir_name
        ));
    }

    commands.push(
        "if [ \"$CCPANES_WSL_NEEDS_SYNC\" -eq 1 ]; then mkdir -p \"$CCPANES_WSL_CODEX_DST\"; fi"
            .to_string(),
    );
    // 去隔离后 $CCPANES_WSL_CODEX_DST 指向真实 ~/.codex/skills，绝不能像旧隔离目录那样
    // `find ... -name 'ccpanes-*' -exec rm -rf` 批量删 —— 会误删用户自建的同前缀 skill。
    // 改为只 upsert 内置 skill（下方 mkdir+cp 覆盖各 SKILL.md）；残留的旧内置目录无害。
    for dir_name in dir_names {
        commands.push(format!(
            "if [ \"$CCPANES_WSL_NEEDS_SYNC\" -eq 1 ]; then mkdir -p \"$CCPANES_WSL_CODEX_DST/{}\"; fi",
            dir_name
        ));
        commands.push(format!(
            "if [ \"$CCPANES_WSL_NEEDS_SYNC\" -eq 1 ]; then cp \"$CCPANES_WSL_CODEX_SRC/{}/SKILL.md\" \"$CCPANES_WSL_CODEX_DST/{}/SKILL.md\"; fi",
            dir_name, dir_name
        ));
    }
    commands.push("if [ \"$CCPANES_WSL_NEEDS_SYNC\" -eq 1 ]; then cp \"$CCPANES_WSL_CODEX_SRC/$CCPANES_WSL_DEFAULT_SKILLS_VERSION_FILE\" \"$CCPANES_WSL_CODEX_DST/$CCPANES_WSL_DEFAULT_SKILLS_VERSION_FILE\"; fi".to_string());

    commands
}

fn sanitize_wsl_claude_session_id(session_id: &str) -> String {
    session_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-')
        .collect()
}

/// 会话结束（自然退出 / kill）时删除该会话的临时 MCP 配置文件。
/// 本地启动写 `mcp-<id>.json`（cc-cli-adapters/claude.rs），WSL 启动写
/// `wsl-claude-mcp-<id>.json`（本文件），两者都只在 CLI 启动时读取一次，
/// 会话结束后即为垃圾。尽力而为：删除失败不影响会话清理主流程。
pub(super) fn cleanup_session_mcp_configs(data_dir: &std::path::Path, session_id: &str) {
    let sanitized = sanitize_wsl_claude_session_id(session_id);
    if sanitized.is_empty() {
        return;
    }
    for file_name in [
        format!("mcp-{}.json", sanitized),
        format!("wsl-claude-mcp-{}.json", sanitized),
    ] {
        let path = data_dir.join(file_name);
        if path.exists() {
            if let Err(e) = std::fs::remove_file(&path) {
                tracing::warn!(
                    session_id = %session_id,
                    path = %path.display(),
                    error = %e,
                    "Failed to remove per-session MCP config"
                );
            }
        }
    }
}

fn append_codex_resume_args(
    codex_args: &mut Vec<String>,
    resume_id: Option<&str>,
    initial_prompt: Option<&str>,
) {
    if let Some(resume_id) = resume_id {
        codex_args.push("resume".to_string());
        codex_args.push(resume_id.to_string());
    }

    if let Some(initial_prompt) = initial_prompt {
        codex_args.push(initial_prompt.to_string());
    }
}

fn push_codex_developer_instructions_arg(
    codex_args: &mut Vec<String>,
    append_system_prompt: Option<&str>,
) {
    let Some(prompt) = append_system_prompt
        .map(str::trim)
        .filter(|prompt| !prompt.is_empty())
    else {
        return;
    };

    codex_args.push("-c".to_string());
    codex_args.push(format!(
        "developer_instructions={}",
        format_toml_value_for_cli(&toml::Value::String(prompt.to_string()))
    ));
}

fn push_codex_yolo_mode_arg(codex_args: &mut Vec<String>) {
    codex_args.push("--dangerously-bypass-approvals-and-sandbox".to_string());
}

/// 生成 WSL Codex 的 MCP 禁用前导脚本（**不再隔离 CODEX_HOME**）。
///
/// 去隔离后 Codex 直接使用真实 `~/.codex`，`codex resume <id>` 能命中真实历史、
/// ccswitch 换 provider 后历史不丢。原先靠"复制+sanitize config 到隔离 home"实现的
/// 「关闭用户全局未列出的 MCP」改为 per-launch `-c mcp_servers.<name>.enabled=false`：
///
/// - 关哪些必须知道真实 config 里有哪些 server，而真实 config 在 WSL 内 —— 实测
///   `codex -c mcp_servers.X.enabled=false` 逐个禁用有效，整表 `mcp_servers={}` 无效，
///   故保留一小段最小 shell：grep 出 `[mcp_servers.NAME]` 顶层段名，对不在 allowed
///   集合里的 NAME 追加 `-c mcp_servers.NAME.enabled=false` 到 `$CCPANES_CODEX_MCP_DISABLE`，
///   在 codex 调用处展开。allowed 名单由 Rust 侧传入（已转义）。
/// - plugins 是 stable feature（默认开），用 `--disable plugins` 顶层 flag 关闭（见 build）；
///   marketplaces 非 config section、实测用户 config 无此段，无需处理。
fn push_wsl_codex_mcp_isolation_prelude(
    remote_parts: &mut Vec<String>,
    disable_unlisted_mcp_servers: bool,
    allowed_mcp_server_ids: &[String],
) {
    // 始终初始化，确保 codex 调用处展开 $CCPANES_CODEX_MCP_DISABLE 时变量已绑定。
    remote_parts.push("CCPANES_CODEX_MCP_DISABLE=\"\"".to_string());

    if !disable_unlisted_mcp_servers {
        return;
    }

    // allowed 集合：每行一个名字（含 ccpanes/shared 由调用方负责加入），供 grep -Fxq 精确匹配。
    let mut allowed = allowed_mcp_server_ids.to_vec();
    allowed.push("ccpanes".to_string());
    let allowed_lines = allowed.join("\n");

    // 枚举真实 ~/.codex/config.toml 的 [mcp_servers.NAME]（仅顶层段，排除 .env/.args 子表），
    // 对不在 allowed 里的 NAME 追加 -c 禁用。CCPANES_CODEX_REAL_HOME 尊重用户 CODEX_HOME。
    remote_parts.push("CCPANES_CODEX_REAL_HOME=\"${CODEX_HOME:-$HOME/.codex}\"".to_string());
    remote_parts.push(format!(
        "CCPANES_CODEX_ALLOWED={}",
        shell_escape_posix(&allowed_lines)
    ));
    remote_parts.push(
        r#"if [ -f "$CCPANES_CODEX_REAL_HOME/config.toml" ]; then
  for CCPANES_MCP_NAME in $(grep -oE '^\[mcp_servers\.[^].]+\]' "$CCPANES_CODEX_REAL_HOME/config.toml" | sed -E 's/^\[mcp_servers\.([^].]+)\]$/\1/' | sort -u); do
    if ! printf '%s\n' "$CCPANES_CODEX_ALLOWED" | grep -Fxq "$CCPANES_MCP_NAME"; then
      CCPANES_CODEX_MCP_DISABLE="$CCPANES_CODEX_MCP_DISABLE -c mcp_servers.$CCPANES_MCP_NAME.enabled=false"
    fi
  done
fi"#
        .to_string(),
    );
}

fn is_wsl_home_path(path: &str) -> bool {
    matches!(path.trim(), "~" | "~/")
}

#[cfg(windows)]
pub(super) fn windows_path_to_wsl(path: &std::path::Path) -> Option<String> {
    let normalized = path.to_string_lossy().replace('\\', "/");
    let normalized = normalized.strip_prefix("//?/").unwrap_or(&normalized);
    let bytes = normalized.as_bytes();
    if normalized.len() < 3 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' {
        return None;
    }

    let mut suffix = normalized[2..].trim_start_matches('/').to_string();
    if suffix.is_empty() {
        return Some(format!("/mnt/{}", (bytes[0] as char).to_ascii_lowercase()));
    }

    suffix = suffix.replace('\\', "/");
    Some(format!(
        "/mnt/{}/{}",
        (bytes[0] as char).to_ascii_lowercase(),
        suffix
    ))
}

#[cfg(not(windows))]
pub(super) fn windows_path_to_wsl(_path: &std::path::Path) -> Option<String> {
    None
}

fn is_simple_toml_key_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

fn format_toml_key_segment_for_cli(segment: &str) -> String {
    if is_simple_toml_key_segment(segment) {
        segment.to_string()
    } else {
        serde_json::to_string(segment).unwrap_or_else(|_| {
            format!("\"{}\"", segment.replace('\\', "\\\\").replace('"', "\\\""))
        })
    }
}

pub(super) fn format_toml_value_for_cli(value: &toml::Value) -> String {
    match value {
        toml::Value::String(text) => serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into()),
        toml::Value::Integer(number) => number.to_string(),
        toml::Value::Float(number) => number.to_string(),
        toml::Value::Boolean(flag) => flag.to_string(),
        toml::Value::Datetime(datetime) => datetime.to_string(),
        toml::Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(format_toml_value_for_cli)
                .collect::<Vec<_>>()
                .join(", ")
        ),
        toml::Value::Table(table) => {
            let mut entries = table
                .iter()
                .map(|(key, value)| {
                    format!(
                        "{} = {}",
                        format_toml_key_segment_for_cli(key),
                        format_toml_value_for_cli(value)
                    )
                })
                .collect::<Vec<_>>();
            entries.sort();
            format!("{{ {} }}", entries.join(", "))
        }
    }
}

impl TerminalService {
    #[cfg(windows)]
    fn write_wsl_launch_script(
        &self,
        session_id: &str,
        label: &str,
        commands: &[String],
    ) -> Result<String> {
        let script_dir = self.app_paths.data_dir().join("wsl-launch");
        std::fs::create_dir_all(&script_dir)?;

        let file_name = format!(
            "{}-{}.sh",
            sanitize_wsl_script_component(label),
            sanitize_wsl_script_component(session_id)
        );
        let script_path = script_dir.join(file_name);
        std::fs::write(&script_path, render_wsl_launch_script(commands))?;

        windows_path_to_wsl(&script_path).ok_or_else(|| {
            anyhow!(
                "Failed to translate WSL launch script path to WSL path: {}",
                script_path.display()
            )
        })
    }

    #[cfg(windows)]
    fn build_wsl_script_command(
        &self,
        wsl: &ResolvedWslLaunch,
        session_id: &str,
        label: &str,
        commands: Vec<String>,
    ) -> Result<(String, Vec<String>)> {
        let script_path = self.write_wsl_launch_script(session_id, label, &commands)?;
        let args = vec![
            "-d".to_string(),
            wsl.distro.clone(),
            "--".to_string(),
            "bash".to_string(),
            WSL_BASH_LOGIN_FLAG.to_string(),
            script_path,
        ];
        Ok((wsl.wsl_path.to_string_lossy().into_owned(), args))
    }

    #[cfg(windows)]
    fn build_wsl_claude_skill_sync_commands(&self) -> Result<Vec<String>> {
        let source_dir = dirs::home_dir()
            .ok_or_else(|| anyhow!("Failed to resolve Windows home directory"))?
            .join(".claude")
            .join("commands")
            .join(BUNDLED_NAMESPACE);
        let source_wsl_path = windows_path_to_wsl(&source_dir).ok_or_else(|| {
            anyhow!(
                "Failed to translate Claude bundled skill path to WSL path: {}",
                source_dir.display()
            )
        })?;
        let file_names = collect_wsl_claude_source_files(&source_dir)?;
        Ok(build_wsl_claude_skill_sync_prelude(
            &source_wsl_path,
            &file_names,
        ))
    }

    #[cfg(windows)]
    fn build_wsl_codex_skill_sync_commands(&self) -> Result<Vec<String>> {
        let source_root = dirs::home_dir()
            .ok_or_else(|| anyhow!("Failed to resolve Windows home directory"))?
            .join(".codex")
            .join("skills");
        let source_wsl_path = windows_path_to_wsl(&source_root).ok_or_else(|| {
            anyhow!(
                "Failed to translate Codex bundled skill path to WSL path: {}",
                source_root.display()
            )
        })?;
        let dir_names = collect_wsl_codex_source_dirs(&source_root)?;
        Ok(build_wsl_codex_skill_sync_prelude(
            &source_wsl_path,
            &dir_names,
        ))
    }

    #[cfg(windows)]
    pub(super) fn resolve_reachable_wsl_windows_host(
        &self,
        wsl_path: &std::path::Path,
        distro: &str,
        port: u16,
    ) -> Result<String> {
        // 从 **WSL 内部** 探活候选宿主地址，选第一个能连到 orchestrator `/api/health` 的：
        //   1. 127.0.0.1 —— mirrored 网络下 WSL 回环直达宿主
        //   2. 默认网关（`ip route show default`）—— NAT 下即 Windows 宿主的 vEthernet(WSL) IP
        //   3. `/etc/resolv.conf` 的 nameserver —— NAT 下通常也是宿主 IP
        // 必须从 WSL 侧探（而非 Windows 侧），才能真正区分 mirrored / NAT。
        // 探不到（无 bash/timeout 等）则回退 127.0.0.1，保持 mirrored 旧行为、NAT 不更坏。
        // 成功结果按 (distro, port) 缓存 5 分钟，回退值不缓存。
        let cached = WSL_HOST_PROBE_CACHE
            .get_or_init(WslHostProbeCache::new)
            .get_or_probe(distro, port, WSL_HOST_PROBE_CACHE_TTL, || {
                probe_reachable_wsl_windows_host(wsl_path, distro, port)
            });
        match cached {
            Some(host) => {
                info!(distro = %distro, port = %port, host = %host, "resolved reachable WSL→Windows host for MCP");
                Ok(host)
            }
            None => {
                warn!(
                    distro = %distro,
                    port = %port,
                    "could not probe a reachable WSL→Windows host; falling back to 127.0.0.1 (works only under mirrored networking)"
                );
                Ok("127.0.0.1".to_string())
            }
        }
    }

    #[cfg(not(windows))]
    pub(super) fn resolve_reachable_wsl_windows_host(
        &self,
        _wsl_path: &std::path::Path,
        _distro: &str,
        _port: u16,
    ) -> Result<String> {
        Err(anyhow!("WSL launch is only supported on Windows"))
    }

    #[cfg(windows)]
    pub(super) fn resolve_wsl_launch(
        &self,
        wsl: &WslLaunchInfo,
        _session_id: &str,
    ) -> Result<ResolvedWslLaunch> {
        let remote_path = wsl.remote_path.trim();
        if remote_path.is_empty() {
            return Err(anyhow!("WSL remote path cannot be empty"));
        }
        let workspace_remote_path = wsl
            .workspace_remote_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);

        let distro = wsl
            .distro
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .or(crate::services::wsl_discovery_service::resolve_default_distro()?)
            .ok_or_else(|| anyhow!("No default WSL distro found"))?;

        let wsl_path = cached_which("wsl.exe")
            .or_else(|_| cached_which("wsl"))
            .map_err(|_| anyhow!("wsl.exe not found in PATH"))?;

        Ok(ResolvedWslLaunch {
            wsl_path,
            distro,
            remote_path: remote_path.to_string(),
            workspace_remote_path,
            windows_host: None,
        })
    }

    #[cfg(not(windows))]
    pub(super) fn resolve_wsl_launch(
        &self,
        _wsl: &WslLaunchInfo,
        _session_id: &str,
    ) -> Result<ResolvedWslLaunch> {
        Err(anyhow!("WSL launch is only supported on Windows"))
    }

    #[cfg(windows)]
    pub(super) fn ensure_wsl_codex_mcp_registered(
        &self,
        session_id: &str,
        wsl: &ResolvedWslLaunch,
        env_vars: &HashMap<String, String>,
        skip_mcp: bool,
    ) -> Result<()> {
        if skip_mcp {
            info!(
                session_id = %session_id,
                distro = %wsl.distro,
                "create_session: skip_mcp=true, skipping WSL Codex MCP injection"
            );
            return Ok(());
        }

        let (Some(port), Some(_token), Some(windows_host)) = (
            env_vars.get("CC_PANES_API_PORT"),
            env_vars.get("CC_PANES_API_TOKEN"),
            wsl.windows_host.as_deref(),
        ) else {
            warn!(
                session_id = %session_id,
                distro = %wsl.distro,
                has_port = env_vars.contains_key("CC_PANES_API_PORT"),
                has_token = env_vars.contains_key("CC_PANES_API_TOKEN"),
                has_windows_host = wsl.windows_host.is_some(),
                "create_session: missing WSL Codex MCP context, session will start without ccpanes MCP injection"
            );
            return Ok(());
        };

        info!(
            session_id = %session_id,
            distro = %wsl.distro,
            port = %port,
            windows_host = %windows_host,
            "create_session: WSL Codex will inject ccpanes MCP via CLI config"
        );

        Ok(())
    }

    #[cfg(not(windows))]
    pub(super) fn ensure_wsl_codex_mcp_registered(
        &self,
        _session_id: &str,
        _wsl: &ResolvedWslLaunch,
        _env_vars: &HashMap<String, String>,
        _skip_mcp: bool,
    ) -> Result<()> {
        Ok(())
    }

    #[cfg(windows)]
    pub(super) fn build_wsl_shell_command(
        &self,
        wsl: &ResolvedWslLaunch,
    ) -> Result<(String, Vec<String>)> {
        let mut remote_parts = Vec::new();
        if !is_wsl_home_path(&wsl.remote_path) {
            remote_parts.push(format!("cd {}", Self::shell_escape(&wsl.remote_path)));
        }
        remote_parts.push("exec $SHELL -l".to_string());

        let args = vec![
            "-d".to_string(),
            wsl.distro.clone(),
            "--".to_string(),
            "bash".to_string(),
            WSL_BASH_EVAL_FLAG.to_string(),
            remote_parts.join(" && "),
        ];

        Ok((wsl.wsl_path.to_string_lossy().into_owned(), args))
    }

    #[cfg(not(windows))]
    pub(super) fn build_wsl_shell_command(
        &self,
        _wsl: &ResolvedWslLaunch,
    ) -> Result<(String, Vec<String>)> {
        unreachable!("WSL launch is only supported on Windows")
    }

    #[cfg(windows)]
    #[allow(clippy::too_many_arguments)]
    pub(super) fn build_wsl_supported_cli_command(
        &self,
        wsl: &ResolvedWslLaunch,
        cli_tool: CliTool,
        session_id: &str,
        env_vars: &HashMap<String, String>,
        provider_env: &HashMap<String, String>,
        resume_id: Option<&str>,
        issued_session_id: Option<&str>,
        append_system_prompt: Option<&str>,
        initial_prompt: Option<&str>,
        skip_mcp: bool,
        yolo_mode: bool,
    ) -> Result<(String, Vec<String>)> {
        let command = match cli_tool {
            CliTool::Claude => "claude",
            CliTool::Gemini => "gemini",
            CliTool::Kimi => "kimi",
            CliTool::Glm => "crush",
            CliTool::Opencode => "opencode",
            CliTool::Cursor => "cursor-agent",
            CliTool::Grok => "grok",
            other => {
                return Err(anyhow!(
                    "WSL generic launch does not support CLI tool {:?}",
                    other
                ));
            }
        };

        let mut remote_parts = Vec::new();
        push_wsl_env_exports(&mut remote_parts, provider_env);
        push_wsl_ccpanes_env_exports(&mut remote_parts, env_vars);
        if cli_tool == CliTool::Claude {
            match self.build_wsl_claude_skill_sync_commands() {
                Ok(mut commands) => remote_parts.append(&mut commands),
                Err(error) => warn!(
                    distro = %wsl.distro,
                    error = %error,
                    "build_wsl_supported_cli_command: failed to prepare bundled Claude skill sync; continuing without sync"
                ),
            }
        }
        let workspace_remote_path = wsl
            .workspace_remote_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let launch_cwd = workspace_remote_path.unwrap_or(wsl.remote_path.as_str());
        if !is_wsl_home_path(launch_cwd) {
            remote_parts.push(format!("cd {}", Self::shell_escape(launch_cwd)));
        }

        let mut cli_args = Vec::new();
        if cli_tool == CliTool::Claude {
            if let Some(resume_id) = resume_id {
                cli_args.push("--resume".to_string());
                cli_args.push(resume_id.to_string());
            } else if let Some(issued) = issued_session_id {
                // 新会话由 CC-Panes 发号（与本地 claude.rs build_command 一致）
                cli_args.push("--session-id".to_string());
                cli_args.push(issued.to_string());
            }
            if workspace_remote_path.is_some()
                && workspace_remote_path != Some(wsl.remote_path.as_str())
            {
                cli_args.push("--add-dir".to_string());
                cli_args.push(wsl.remote_path.clone());
            }
            if !skip_mcp {
                if let Some(config_path) =
                    self.write_wsl_claude_mcp_config(session_id, wsl, env_vars)?
                {
                    cli_args.push("--mcp-config".to_string());
                    cli_args.push(config_path);
                }
            }
            if let Some(prompt) = append_system_prompt {
                cli_args.push("--append-system-prompt".to_string());
                cli_args.push(prompt.to_string());
            }
            if yolo_mode {
                cli_args.push("--dangerously-skip-permissions".to_string());
            }
            if let Some(prompt) = initial_prompt {
                cli_args.push("--".to_string());
                cli_args.push(prompt.to_string());
            }
        } else if cli_tool == CliTool::Kimi {
            if workspace_remote_path.is_some()
                && workspace_remote_path != Some(wsl.remote_path.as_str())
            {
                cli_args.push("--add-dir".to_string());
                cli_args.push(wsl.remote_path.clone());
            }
            if let Some(prompt) = initial_prompt {
                cli_args.push(prompt.to_string());
            }
        } else if cli_tool == CliTool::Glm {
            cli_args.push("--cwd".to_string());
            cli_args.push(launch_cwd.to_string());
            if let Some(resume_id) = resume_id {
                cli_args.push("--session".to_string());
                cli_args.push(resume_id.to_string());
            }
            if let Some(prompt) = initial_prompt {
                cli_args.push("run".to_string());
                cli_args.push(prompt.to_string());
            }
        } else if cli_tool == CliTool::Cursor {
            if let Some(resume_id) = resume_id {
                cli_args.push("--resume".to_string());
                cli_args.push(resume_id.to_string());
            }
            if let Some(prompt) = initial_prompt {
                cli_args.push(prompt.to_string());
            }
        } else if cli_tool == CliTool::Grok {
            // MCP：Grok 的注入面是 WSL 内 ~/.grok/config.toml，需 wslpath + UNC 写
            // （参考 codex 的 resolve_wsl_codex_config_windows_path）。本期 WSL grok
            // 不注入 MCP，TODO 后续增量。
            if let Some(resume_id) = resume_id {
                cli_args.push("--resume".to_string());
                cli_args.push(resume_id.to_string());
            } else if let Some(issued) = issued_session_id {
                // 新会话由 CC-Panes 发号（与本地 grok.rs build_command 一致）
                cli_args.push("--session-id".to_string());
                cli_args.push(issued.to_string());
            }
            if let Some(prompt) = append_system_prompt {
                cli_args.push("--rules".to_string());
                cli_args.push(prompt.to_string());
            }
            if yolo_mode {
                cli_args.push("--always-approve".to_string());
            }
            if let Some(prompt) = initial_prompt {
                cli_args.push(prompt.to_string());
            }
        } else if let Some(prompt) = initial_prompt {
            cli_args.push(prompt.to_string());
        }

        let escaped_cli_args = cli_args
            .iter()
            .map(|arg| Self::shell_escape(arg))
            .collect::<Vec<_>>()
            .join(" ");
        remote_parts.push(if escaped_cli_args.is_empty() {
            format!("exec {}", command)
        } else {
            format!("exec {} {}", command, escaped_cli_args)
        });

        self.build_wsl_script_command(wsl, session_id, command, remote_parts)
    }

    #[cfg(not(windows))]
    #[allow(clippy::too_many_arguments)]
    pub(super) fn build_wsl_supported_cli_command(
        &self,
        _wsl: &ResolvedWslLaunch,
        _cli_tool: CliTool,
        _session_id: &str,
        _env_vars: &HashMap<String, String>,
        _provider_env: &HashMap<String, String>,
        _resume_id: Option<&str>,
        _issued_session_id: Option<&str>,
        _append_system_prompt: Option<&str>,
        _initial_prompt: Option<&str>,
        _skip_mcp: bool,
        _yolo_mode: bool,
    ) -> Result<(String, Vec<String>)> {
        unreachable!("WSL launch is only supported on Windows")
    }

    #[cfg(windows)]
    fn write_wsl_claude_mcp_config(
        &self,
        session_id: &str,
        wsl: &ResolvedWslLaunch,
        env_vars: &HashMap<String, String>,
    ) -> Result<Option<String>> {
        let (Some(port), Some(token), Some(windows_host)) = (
            env_vars.get("CC_PANES_API_PORT"),
            env_vars.get("CC_PANES_API_TOKEN"),
            wsl.windows_host.as_deref(),
        ) else {
            warn!(
                distro = %wsl.distro,
                has_port = env_vars.contains_key("CC_PANES_API_PORT"),
                has_token = env_vars.contains_key("CC_PANES_API_TOKEN"),
                has_windows_host = wsl.windows_host.is_some(),
                "write_wsl_claude_mcp_config: incomplete MCP context, skipping WSL Claude MCP config"
            );
            return Ok(None);
        };

        let file_name = format!(
            "wsl-claude-mcp-{}.json",
            sanitize_wsl_claude_session_id(session_id)
        );
        let config_path = self.app_paths.data_dir().join(&file_name);

        // 清扫崩溃残留：会话正常结束会删自己的配置（cleanup_session_mcp_configs），
        // 但 daemon 崩溃时会遗留。仅删除同时满足两个条件的文件：
        // 1) 修改时间 >1h（不是刚启动的会话）；2) 文件名对应的会话不在活跃
        // 会话表中（"旧于一小时"单独不足以断定不活跃——长跑会话可以超过一小时）。
        let active_session_files: std::collections::HashSet<String> = self
            .sessions
            .lock()
            .map(|sessions| {
                sessions
                    .keys()
                    .map(|id| format!("wsl-claude-mcp-{}.json", sanitize_wsl_claude_session_id(id)))
                    .collect()
            })
            .unwrap_or_default();
        if let Ok(entries) = std::fs::read_dir(self.app_paths.data_dir()) {
            let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if name_str.starts_with("wsl-claude-mcp-")
                    && name_str.ends_with(".json")
                    && *name_str != file_name
                    && !active_session_files.contains(name_str.as_ref())
                {
                    if let Ok(meta) = entry.metadata() {
                        if meta.modified().map(|m| m < cutoff).unwrap_or(false) {
                            let _ = std::fs::remove_file(entry.path());
                        }
                    }
                }
            }
        }
        let wsl_config_path = windows_path_to_wsl(&config_path).ok_or_else(|| {
            anyhow!(
                "Failed to translate Claude MCP config path to WSL path: {}",
                config_path.display()
            )
        })?;

        let mcp_url_with_launch = {
            let mut url = build_wsl_mcp_url(windows_host, port, token);
            if let Some(launch_id) = env_vars.get("CC_PANES_LAUNCH_ID") {
                url.push_str("&launchId=");
                url.push_str(launch_id);
            }
            url
        };
        let config = serde_json::json!({
            "mcpServers": {
                "ccpanes": {
                    "type": "http",
                    "url": mcp_url_with_launch,
                    "headers": {
                        "Authorization": format!("Bearer {}", token)
                    }
                }
            }
        });

        std::fs::write(&config_path, serde_json::to_string_pretty(&config)?)?;

        Ok(Some(wsl_config_path))
    }

    #[cfg(not(windows))]
    fn write_wsl_claude_mcp_config(
        &self,
        _session_id: &str,
        _wsl: &ResolvedWslLaunch,
        _env_vars: &HashMap<String, String>,
    ) -> Result<Option<String>> {
        unreachable!("WSL launch is only supported on Windows")
    }

    #[cfg(windows)]
    #[allow(clippy::too_many_arguments)]
    pub(super) fn build_wsl_command(
        &self,
        wsl: &ResolvedWslLaunch,
        session_id: &str,
        env_vars: &HashMap<String, String>,
        provider_env: &HashMap<String, String>,
        resume_id: Option<&str>,
        append_system_prompt: Option<&str>,
        initial_prompt: Option<&str>,
        skip_mcp: bool,
        shared_mcp_urls: &HashMap<String, String>,
        allowed_mcp_server_ids: &[String],
        disable_unlisted_mcp_servers: bool,
        _selected_mcp_config_toml: &str,
        yolo_mode: bool,
    ) -> Result<(String, Vec<String>)> {
        let mut remote_parts = Vec::new();
        push_wsl_env_exports(&mut remote_parts, provider_env);
        push_wsl_ccpanes_env_exports(&mut remote_parts, env_vars);
        push_wsl_codex_mcp_isolation_prelude(
            &mut remote_parts,
            disable_unlisted_mcp_servers,
            allowed_mcp_server_ids,
        );
        match self.build_wsl_codex_skill_sync_commands() {
            Ok(mut commands) => remote_parts.append(&mut commands),
            Err(error) => warn!(
                distro = %wsl.distro,
                error = %error,
                "build_wsl_command: failed to prepare bundled Codex skill sync; continuing without sync"
            ),
        }

        let codex_path = "codex";

        let mut codex_args = Vec::new();

        if !skip_mcp {
            if let (Some(port), Some(token), Some(windows_host)) = (
                env_vars.get("CC_PANES_API_PORT"),
                env_vars.get("CC_PANES_API_TOKEN"),
                wsl.windows_host.as_deref(),
            ) {
                let mut mcp_url = build_wsl_mcp_url(windows_host, port, token);
                if let Some(launch_id) = env_vars.get("CC_PANES_LAUNCH_ID") {
                    mcp_url.push_str("&launchId=");
                    mcp_url.push_str(launch_id);
                }
                codex_args.push("-c".to_string());
                codex_args.push(format!(
                    "mcp_servers.ccpanes.url={}",
                    format_toml_value_for_cli(&toml::Value::String(mcp_url))
                ));
                codex_args.push("-c".to_string());
                codex_args.push("mcp_servers.ccpanes.enabled=true".to_string());
                for (name, url) in shared_mcp_urls {
                    let mcp_url = rewrite_local_mcp_url_for_wsl(url, windows_host);
                    codex_args.push("-c".to_string());
                    codex_args.push(format!(
                        "mcp_servers.{}.url={}",
                        format_toml_key_segment_for_cli(name),
                        format_toml_value_for_cli(&toml::Value::String(mcp_url))
                    ));
                }

                // 关闭用户全局未列出的 plugins（plugins 是 stable feature，默认开）。
                // marketplaces 非 config section、用户 config 通常无此段，无需处理。
                if disable_unlisted_mcp_servers {
                    codex_args.push("--disable".to_string());
                    codex_args.push("plugins".to_string());
                }
            } else {
                warn!(
                    distro = %wsl.distro,
                    has_port = env_vars.contains_key("CC_PANES_API_PORT"),
                    has_token = env_vars.contains_key("CC_PANES_API_TOKEN"),
                    has_windows_host = wsl.windows_host.is_some(),
                    "build_wsl_command: skipping ccpanes MCP CLI override because WSL MCP context is incomplete"
                );
            }
        } else {
            codex_args.push("-c".to_string());
            codex_args.push("mcp_servers.ccpanes.enabled=false".to_string());
        }

        if let Some(token) = env_vars.get("CC_PANES_API_TOKEN") {
            remote_parts.push(format!(
                "export CC_PANES_API_TOKEN={}",
                Self::shell_escape(token)
            ));
        }

        if wsl.remote_path != "~" && wsl.remote_path != "~/" {
            codex_args.push("-C".to_string());
            codex_args.push(wsl.remote_path.clone());
        }
        push_codex_developer_instructions_arg(&mut codex_args, append_system_prompt);
        // 标题带 thread-id：CC-Panes 从 PTY 输出的 OSC 标题序列解析确定性 resume id
        // （与本地 codex.rs push_terminal_title_override 保持一致）
        codex_args.push("-c".to_string());
        codex_args.push(r#"tui.terminal_title=["activity","project","thread-id"]"#.to_string());
        if yolo_mode {
            push_codex_yolo_mode_arg(&mut codex_args);
        }
        // resume 前预检：codex 会话库里若已无该 id 的 rollout 文件（被存错/从未落盘/v4 抓错），
        // 拿它去 `codex resume <id>` 会被 codex 拒绝并秒退 → pane 半残。此时回退为开新会话。
        // fail-open：仅在"确定不存在"时丢弃 resume；检查本身失败则保留，避免误伤。
        let effective_resume_id = match resume_id {
            Some(id)
                if super::osc_resume_capture::codex_rollout_exists(
                    id,
                    Some(wsl.distro.as_str()),
                ) == Some(false) =>
            {
                warn!(
                    distro = %wsl.distro,
                    resume_id = %id,
                    "codex resume target missing in ~/.codex/sessions; launching fresh session"
                );
                None
            }
            other => other,
        };
        append_codex_resume_args(&mut codex_args, effective_resume_id, initial_prompt);

        let escaped_codex_args = codex_args
            .iter()
            .map(|arg| Self::shell_escape(arg))
            .collect::<Vec<_>>()
            .join(" ");
        // $CCPANES_CODEX_MCP_DISABLE 由 prelude 填充为「-c mcp_servers.X.enabled=false ...」，
        // 需未转义地展开（多个 token），且必须在 resume 子命令之前 → 紧跟 codex 之后。
        remote_parts.push(format!(
            "exec {} $CCPANES_CODEX_MCP_DISABLE {}",
            Self::shell_escape(codex_path),
            escaped_codex_args
        ));

        // 日志脱敏：exec 行含 MCP token / developer_instructions / prompt
        let final_exec_log = {
            let mut text = cc_cli_adapters::mask_token_values(
                remote_parts.last().map(String::as_str).unwrap_or(""),
            );
            for secret in [append_system_prompt, initial_prompt].into_iter().flatten() {
                if !secret.is_empty() {
                    text = text.replace(secret, "<prompt>");
                }
            }
            if text.chars().count() > 600 {
                let prefix: String = text.chars().take(600).collect();
                text = format!("{prefix}…");
            }
            text
        };
        info!(
            session_id = %session_id,
            distro = %wsl.distro,
            remote_path = %wsl.remote_path,
            resume_id = ?resume_id,
            final_exec = %final_exec_log,
            "codex(wsl): build_wsl_command result"
        );

        self.build_wsl_script_command(wsl, session_id, "codex", remote_parts)
    }

    #[cfg(not(windows))]
    #[allow(clippy::too_many_arguments)]
    pub(super) fn build_wsl_command(
        &self,
        _wsl: &ResolvedWslLaunch,
        _session_id: &str,
        _env_vars: &HashMap<String, String>,
        _provider_env: &HashMap<String, String>,
        _resume_id: Option<&str>,
        _append_system_prompt: Option<&str>,
        _initial_prompt: Option<&str>,
        _skip_mcp: bool,
        _shared_mcp_urls: &HashMap<String, String>,
        _allowed_mcp_server_ids: &[String],
        _disable_unlisted_mcp_servers: bool,
        _selected_mcp_config_toml: &str,
        _yolo_mode: bool,
    ) -> Result<(String, Vec<String>)> {
        unreachable!("WSL launch is only supported on Windows")
    }
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use super::wsl_host_probe_bash_arg;
    use super::WslHostProbeCache;
    use super::{
        append_codex_resume_args, push_codex_developer_instructions_arg, push_codex_yolo_mode_arg,
        push_wsl_codex_mcp_isolation_prelude, render_wsl_launch_script, wsl_host_probe_script,
    };
    #[cfg(windows)]
    use super::{
        build_wsl_claude_skill_sync_prelude, build_wsl_codex_skill_sync_prelude,
        collect_wsl_claude_source_files, collect_wsl_codex_source_dirs, VERSION_FILE_NAME,
    };
    use std::fs;
    use std::path::{Path, PathBuf};

    fn unique_temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cc-panes-wsl-codex-{}-{}",
            name,
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn remove_dir(path: &Path) {
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn cleanup_session_mcp_configs_removes_only_own_session_files() {
        let dir = unique_temp_dir("mcp-cleanup");
        let sid = "11111111-aaaa-bbbb-cccc-222222222222";
        let other = "33333333-dddd-eeee-ffff-444444444444";
        for name in [
            format!("mcp-{}.json", sid),
            format!("wsl-claude-mcp-{}.json", sid),
            format!("mcp-{}.json", other),
            format!("wsl-claude-mcp-{}.json", other),
            "mcp-orchestrator.json".to_string(),
        ] {
            fs::write(dir.join(name), "{}").unwrap();
        }

        super::cleanup_session_mcp_configs(&dir, sid);

        assert!(!dir.join(format!("mcp-{}.json", sid)).exists());
        assert!(!dir.join(format!("wsl-claude-mcp-{}.json", sid)).exists());
        assert!(dir.join(format!("mcp-{}.json", other)).exists());
        assert!(dir.join(format!("wsl-claude-mcp-{}.json", other)).exists());
        assert!(dir.join("mcp-orchestrator.json").exists());
        remove_dir(&dir);
    }

    #[test]
    fn cleanup_session_mcp_configs_ignores_empty_or_hostile_session_id() {
        let dir = unique_temp_dir("mcp-cleanup-hostile");
        // 全部字符被 sanitize 过滤 → 空文件名，直接返回不动任何文件
        super::cleanup_session_mcp_configs(&dir, "../..");
        super::cleanup_session_mcp_configs(&dir, "");
        remove_dir(&dir);
    }

    #[test]
    fn probe_cache_hit_skips_second_probe() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let cache = WslHostProbeCache::new();
        let calls = AtomicUsize::new(0);
        let ttl = std::time::Duration::from_secs(60);

        let first = cache.get_or_probe("Ubuntu", 8080, ttl, || {
            calls.fetch_add(1, Ordering::SeqCst);
            Some("172.20.0.1".to_string())
        });
        let second = cache.get_or_probe("Ubuntu", 8080, ttl, || {
            calls.fetch_add(1, Ordering::SeqCst);
            Some("should-not-run".to_string())
        });

        assert_eq!(first.as_deref(), Some("172.20.0.1"));
        assert_eq!(second.as_deref(), Some("172.20.0.1"));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn probe_cache_does_not_cache_failure() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let cache = WslHostProbeCache::new();
        let calls = AtomicUsize::new(0);
        let ttl = std::time::Duration::from_secs(60);

        let first = cache.get_or_probe("Ubuntu", 8080, ttl, || {
            calls.fetch_add(1, Ordering::SeqCst);
            None
        });
        let second = cache.get_or_probe("Ubuntu", 8080, ttl, || {
            calls.fetch_add(1, Ordering::SeqCst);
            Some("172.20.0.1".to_string())
        });

        assert_eq!(first, None);
        assert_eq!(second.as_deref(), Some("172.20.0.1"));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn probe_cache_expires_after_ttl_and_keys_by_distro_port() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let cache = WslHostProbeCache::new();
        let calls = AtomicUsize::new(0);

        // TTL 为零：写入即过期，下一次必须重探
        let zero_ttl = std::time::Duration::ZERO;
        cache.get_or_probe("Ubuntu", 8080, zero_ttl, || {
            calls.fetch_add(1, Ordering::SeqCst);
            Some("a".to_string())
        });
        cache.get_or_probe("Ubuntu", 8080, zero_ttl, || {
            calls.fetch_add(1, Ordering::SeqCst);
            Some("b".to_string())
        });
        assert_eq!(calls.load(Ordering::SeqCst), 2);

        // 不同 port 是不同 key
        let ttl = std::time::Duration::from_secs(60);
        cache.get_or_probe("Ubuntu", 9090, ttl, || {
            calls.fetch_add(1, Ordering::SeqCst);
            Some("c".to_string())
        });
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn wsl_host_probe_script_covers_loopback_gateway_and_nameserver() {
        let script = wsl_host_probe_script();
        // 候选顺序：回环（mirrored）→ 默认网关（NAT）→ resolv.conf nameserver。
        assert!(script.contains("127.0.0.1"));
        assert!(script.contains("ip route show default"));
        assert!(script.contains("/etc/resolv.conf"));
        // 校验的是本 orchestrator 独有的 /api/health 载荷，非裸 TCP。
        assert!(script.contains("/api/health"));
        assert!(script.contains(r#""status""#));
        // 逐候选带 1s 超时兜底，避免黑洞候选阻塞。
        assert!(script.contains("timeout 1"));
    }

    #[cfg(windows)]
    #[test]
    fn wsl_host_probe_bash_arg_base64_round_trips_to_script() {
        use base64::Engine as _;
        let arg = wsl_host_probe_bash_arg(61012);
        assert!(arg.ends_with("| base64 -d | bash -s 61012"));
        let encoded = arg
            .strip_prefix("echo ")
            .and_then(|rest| rest.split_once(' ').map(|(b64, _)| b64))
            .expect("base64 blob");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("valid base64");
        assert_eq!(
            String::from_utf8(decoded).expect("utf8"),
            wsl_host_probe_script()
        );
        // 命令参数只含 base64 安全字符 + 管道/空格，无引号 → 不受 wsl.exe 引号解析影响。
        assert!(!arg.contains('\'') && !arg.contains('"'));
    }

    #[test]
    fn append_codex_resume_args_keeps_prompt_after_resume_id() {
        let mut args = vec!["-C".to_string(), "/workspace/project".to_string()];

        append_codex_resume_args(
            &mut args,
            Some("session-123"),
            Some("continue fixing tests"),
        );

        assert_eq!(
            args,
            vec![
                "-C",
                "/workspace/project",
                "resume",
                "session-123",
                "continue fixing tests",
            ]
        );
    }

    #[test]
    fn append_codex_resume_args_keeps_prompt_without_resume_id() {
        let mut args = vec![];

        append_codex_resume_args(&mut args, None, Some("open the task"));

        assert_eq!(args, vec!["open the task"]);
    }

    #[test]
    fn codex_developer_instructions_arg_precedes_resume_and_prompt() {
        let mut args = vec!["-C".to_string(), "/workspace/project".to_string()];

        push_codex_developer_instructions_arg(&mut args, Some("profile skill"));
        append_codex_resume_args(&mut args, Some("session-123"), Some("continue"));

        assert_eq!(
            args,
            vec![
                "-C",
                "/workspace/project",
                "-c",
                "developer_instructions=\"profile skill\"",
                "resume",
                "session-123",
                "continue",
            ]
        );
    }

    #[test]
    fn codex_yolo_arg_precedes_resume_and_prompt() {
        let mut args = vec!["-C".to_string(), "/workspace/project".to_string()];

        push_codex_yolo_mode_arg(&mut args);
        append_codex_resume_args(&mut args, Some("session-123"), Some("continue"));

        assert_eq!(
            args,
            vec![
                "-C",
                "/workspace/project",
                "--dangerously-bypass-approvals-and-sandbox",
                "resume",
                "session-123",
                "continue",
            ]
        );
    }

    #[test]
    fn codex_mcp_isolation_prelude_no_longer_isolates_home_and_disables_unlisted() {
        let mut commands = Vec::new();

        push_wsl_codex_mcp_isolation_prelude(&mut commands, true, &["allowedserver".to_string()]);
        let script = render_wsl_launch_script(&commands);

        // 去隔离：不再 export 隔离 CODEX_HOME、不再 rm -rf、不再 sanitize 拷 config。
        assert!(!script.contains("export CODEX_HOME=\"$HOME/.cache/cc-panes/codex-home"));
        assert!(!script.contains("rm -rf \"$CODEX_HOME\""));
        assert!(!script.contains("(mcp_servers|plugins|marketplaces)"));
        // 改为：初始化禁用变量 + 枚举真实 config 对非 allowed server 追加 -c enabled=false。
        assert!(script.contains("CCPANES_CODEX_MCP_DISABLE=\"\""));
        assert!(script.contains("CCPANES_CODEX_REAL_HOME=\"${CODEX_HOME:-$HOME/.codex}\""));
        assert!(script.contains("mcp_servers.$CCPANES_MCP_NAME.enabled=false"));
        // allowed 名单写入 shell（含传入的 allowedserver + 隐式 ccpanes）。
        assert!(script.contains("allowedserver"));
        assert!(script.contains("ccpanes"));
    }

    #[test]
    fn codex_mcp_isolation_prelude_disabled_only_inits_empty_var() {
        let mut commands = Vec::new();
        push_wsl_codex_mcp_isolation_prelude(&mut commands, false, &[]);
        let script = render_wsl_launch_script(&commands);
        // 未开隔离：只初始化空变量，不枚举、不禁用。
        assert!(script.contains("CCPANES_CODEX_MCP_DISABLE=\"\""));
        assert!(!script.contains("mcp_servers.$CCPANES_MCP_NAME.enabled=false"));
    }

    #[test]
    fn render_wsl_launch_script_keeps_each_command_on_its_own_line() {
        let script = render_wsl_launch_script(&[
            "export TOKEN='secret'".to_string(),
            "exec codex '-C' '/mnt/d/repo'".to_string(),
        ]);

        assert_eq!(
            script,
            "#!/usr/bin/env bash\nset -e\nexport TOKEN='secret'\nexec codex '-C' '/mnt/d/repo'\n"
        );
    }

    #[test]
    #[cfg(windows)]
    fn collect_wsl_claude_source_files_requires_version_and_md_files() {
        let root = unique_temp_dir("claude-source");
        fs::write(root.join(VERSION_FILE_NAME), "1.0.0").unwrap();
        fs::write(root.join("launch-task.md"), "body").unwrap();
        fs::write(root.join("workspace.md"), "body").unwrap();

        let files = collect_wsl_claude_source_files(&root).unwrap();
        assert_eq!(files, vec!["launch-task.md", "workspace.md"]);
        remove_dir(&root);
    }

    #[test]
    #[cfg(windows)]
    fn collect_wsl_codex_source_dirs_filters_to_bundled_dirs() {
        let root = unique_temp_dir("codex-source");
        fs::write(root.join(VERSION_FILE_NAME), "1.0.0").unwrap();
        fs::create_dir_all(root.join("ccpanes-launch-task")).unwrap();
        fs::write(root.join("ccpanes-launch-task").join("SKILL.md"), "body").unwrap();
        fs::create_dir_all(root.join("user-skill")).unwrap();
        fs::write(root.join("user-skill").join("SKILL.md"), "body").unwrap();

        let dirs = collect_wsl_codex_source_dirs(&root).unwrap();
        assert_eq!(dirs, vec!["ccpanes-launch-task"]);
        remove_dir(&root);
    }

    #[test]
    #[cfg(windows)]
    fn build_wsl_claude_skill_sync_prelude_mentions_expected_targets() {
        let commands = build_wsl_claude_skill_sync_prelude(
            "/mnt/c/Users/test/.claude/commands/ccpanes",
            &[String::from("launch-task.md")],
        );

        assert!(commands
            .iter()
            .any(|line: &String| line.contains("$HOME/.claude/commands/ccpanes")));
        assert!(commands
            .iter()
            .any(|line: &String| line.contains("cp \"$CCPANES_WSL_CLAUDE_SRC/launch-task.md\"")));
    }

    #[test]
    #[cfg(windows)]
    fn build_wsl_codex_skill_sync_prelude_copies_skill_dirs_only() {
        let commands = build_wsl_codex_skill_sync_prelude(
            "/mnt/c/Users/test/.codex/skills",
            &[String::from("ccpanes-launch-task")],
        );

        assert!(commands
            .iter()
            .any(|line: &String| line.contains("${CODEX_HOME:-$HOME/.codex}/skills")));
        // 去隔离后目标是真实 ~/.codex/skills：绝不能批量删 ccpanes-* 目录（会误删用户自建）。
        assert!(!commands
            .iter()
            .any(|line: &String| line.contains("find \"$CCPANES_WSL_CODEX_DST\"")));
        // 仍正常 upsert 内置 skill。
        assert!(commands.iter().any(|line: &String| line
            .contains("mkdir -p \"$CCPANES_WSL_CODEX_DST/ccpanes-launch-task\"")));
        assert!(commands.iter().any(|line: &String| line
            .contains("cp \"$CCPANES_WSL_CODEX_SRC/ccpanes-launch-task/SKILL.md\"")));
    }
}
