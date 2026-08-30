use crate::constants::events as EV;
use crate::events::{EventEmitter, SessionNotifier};
use crate::models::shared_mcp::SharedMcpConfig;
use crate::models::{
    CliTool, CreateSessionRequest, LaunchProfile, LaunchProfileMcpMode, LaunchProfileSkillMode,
    LaunchProviderSelection, SshConnectionInfo, StoreCheckpointOutcome, TerminalBufferMode,
    TerminalCheckpoint, TerminalExit, TerminalOutput, TerminalOutputFlowStat,
    TerminalRecoverySnapshot, TerminalReplaySnapshot, WslLaunchInfo,
};
use crate::pty::{spawn_pty, PtyConfig, PtyProcess};
use crate::services::pi_rpc_service::PiManagedStateCleanup;
use crate::services::{
    managed_provider_conflict_env_keys, resolve_provider_plan, validate_provider_runtime,
    CreateSessionOutcome, DefaultSkillService, LaunchProfileService, PiRpcLaunchSpec,
    ProjectCliHooksService, ProviderMode, ProviderResolutionInput, ProviderService,
    ResolvedProviderPlan, SettingsService, SpecService, SshConnectionService, SshCredentialService,
    TerminalLinkContext, WorkspaceService,
};
use crate::utils::error::{AppError, AppResult};
use crate::utils::{orchestrator_manifest, validate_launch_cwd, AppPaths, LaunchRuntime};
use anyhow::{anyhow, Result};
use cc_cli_adapters::{
    CliAdapterContext, CliProvider, CliToolRegistry, PiAdapterOptions, PiTransport,
    SkillDeliveryMode,
};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tracing::{debug, error, info, warn};
use uuid::Uuid;

mod csi_mode_detect;
mod cursor_chat_capture;
mod osc_resume_capture;
mod osc_state_detect;
mod shell_integration;
#[cfg(windows)]
mod windows_codex;
mod wsl_codex;
mod wsl_mcp_proxy;

use self::wsl_codex::{
    strip_wsl_proxy_env_vars, windows_path_to_wsl, WslManagedPiStateCleanup, WSL_PROXY_ENV_KEYS,
};
use super::ssh_terminal_service::{spawn_ssh_terminal, SshTerminalConfig};
use super::terminal_output_flow::{
    OutputFlowGate, ParkOutcome, FAILSAFE_TIMEOUTS_BEFORE_DESYNC, PRODUCER_PAUSE_FAILSAFE,
};

/// 供会话历史在恢复 Codex 前复用现有 rollout 预检，不改变捕获链行为。
pub fn codex_rollout_exists(session_id: &str, distro: Option<&str>) -> Option<bool> {
    osc_resume_capture::codex_rollout_exists(session_id, distro)
}

fn to_cli_provider(provider: crate::models::provider::Provider) -> CliProvider {
    CliProvider {
        id: provider.id,
        name: provider.name,
        provider_type: serde_json::to_value(provider.provider_type)
            .ok()
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_else(|| "unknown".to_string()),
        api_key: provider.api_key,
        base_url: provider.base_url,
        region: provider.region,
        project_id: provider.project_id,
        aws_profile: provider.aws_profile,
        config_dir: provider.config_dir,
        is_default: provider.is_default,
    }
}

fn create_session_outcome(
    session_id: String,
    reused_existing: bool,
    provider_plan: &ResolvedProviderPlan,
) -> CreateSessionOutcome {
    CreateSessionOutcome {
        session_id,
        reused_existing,
        resolved_model_id: provider_plan.model_id.clone(),
    }
}

fn cached_which(name: &str) -> Result<PathBuf, which::Error> {
    use std::sync::OnceLock;

    static CACHE: OnceLock<Mutex<HashMap<String, Option<PathBuf>>>> = OnceLock::new();

    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = cache.lock().unwrap_or_else(|error| error.into_inner());
    if let Some(cached) = map.get(name) {
        return cached.clone().ok_or(which::Error::CannotFindBinaryPath);
    }

    let result = which::which(name);
    map.insert(name.to_string(), result.as_ref().ok().cloned());
    result
}

fn merge_session_prompts(parts: impl IntoIterator<Item = Option<String>>) -> Option<String> {
    let merged = parts
        .into_iter()
        .flatten()
        .map(|part| part.trim().to_string())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    if merged.is_empty() {
        None
    } else {
        Some(merged)
    }
}

/// Avoid loading a bundled Skill twice. Adapters with a native command or
/// native Skill directory receive the bundle there; this fallback is only for
/// adapters whose sole supported portable transport is a session prompt.
fn uses_portable_skill_session_prompt_fallback(
    registry: &CliToolRegistry,
    cli_tool: CliTool,
) -> bool {
    let Some(adapter) = registry.get(cli_tool.as_id()) else {
        return false;
    };
    let modes = adapter.skill_delivery_modes();
    modes.contains(&SkillDeliveryMode::SessionPrompt)
        && !modes.iter().any(|mode| {
            matches!(
                mode,
                SkillDeliveryMode::NativeCommand | SkillDeliveryMode::NativeSkill
            )
        })
}

fn launch_cancelled_error(launch_id: Option<&str>, stage: &str) -> AppError {
    let mut params = HashMap::from([("stage".to_string(), stage.to_string())]);
    if let Some(launch_id) = launch_id {
        params.insert("launchId".to_string(), launch_id.to_string());
    }
    AppError::coded_with_params(
        "LAUNCH_CANCELLED",
        format!("Terminal launch was cancelled during {stage}"),
        params,
    )
}

fn log_launch_stage(
    launch_id: Option<&str>,
    session_id: Option<&str>,
    cli_tool: CliTool,
    runtime_kind: &str,
    started_at: Instant,
    stage: &str,
    outcome: &str,
) {
    info!(
        launch_id = launch_id.unwrap_or("<none>"),
        session_id = session_id.unwrap_or("<pending>"),
        cli_tool = cli_tool.as_id(),
        runtime_kind,
        stage,
        elapsed_ms = started_at.elapsed().as_millis() as u64,
        outcome,
        "terminal launch stage"
    );
}

/// 本次会话是否挂载 CC-Panes 内置 skill。
///
/// 内置 skill 物化在 `<data_dir>/skills/builtin`，按会话经 CLI 参数挂载
/// （Claude `--plugin-dir` / Codex `-c skills.config=`），**不写用户的 CLI Home**。
/// `LaunchProfileSkillMode::Disabled` 时返回空——此时 adapter 完全不碰 skill 配置。
///
/// 注：`Core` / `Custom` 的**逐条**筛选目前仍只作用于 prompt 侧
/// （`LaunchProfileService::resolve_*`）；挂载是目录粒度的，两者粒度不同，
/// 这里只判「挂不挂」。要做到逐条挂载需按 profile 物化子集目录，另行处理。
fn skill_mount_paths_for_profile(
    profile: Option<&LaunchProfile>,
    builtin_skills_dir: &std::path::Path,
) -> Vec<String> {
    let disabled = profile
        .map(|profile| profile.skill_policy.mode == LaunchProfileSkillMode::Disabled)
        .unwrap_or(false);
    if disabled || !builtin_skills_dir.is_dir() {
        return Vec::new();
    }
    vec![builtin_skills_dir.to_string_lossy().into_owned()]
}

fn launch_profile_isolates_mcp(profile: Option<&LaunchProfile>) -> bool {
    profile
        .map(|profile| match profile.mcp_policy.mode {
            LaunchProfileMcpMode::Disabled | LaunchProfileMcpMode::Custom => true,
            LaunchProfileMcpMode::Default => {
                !profile.mcp_policy.enabled_server_ids.is_empty()
                    || !profile.mcp_policy.disabled_server_ids.is_empty()
                    || !profile.mcp_policy.include_ccpanes_mcp
                    || !profile.mcp_policy.include_shared_mcp
            }
        })
        .unwrap_or(false)
}

fn allowed_mcp_server_ids_for_profile(
    profile: Option<&LaunchProfile>,
    shared_mcp_config: &SharedMcpConfig,
) -> Vec<String> {
    let Some(profile) = profile else {
        return Vec::new();
    };
    if profile.mcp_policy.mode == LaunchProfileMcpMode::Disabled {
        return Vec::new();
    }

    let mut allowed = HashSet::new();
    if profile.mcp_policy.include_ccpanes_mcp {
        allowed.insert("ccpanes".to_string());
    }

    if profile.mcp_policy.include_shared_mcp {
        match profile.mcp_policy.mode {
            LaunchProfileMcpMode::Custom => {
                allowed.extend(profile.mcp_policy.enabled_server_ids.iter().cloned());
            }
            LaunchProfileMcpMode::Default => {
                let disabled = profile
                    .mcp_policy
                    .disabled_server_ids
                    .iter()
                    .map(String::as_str)
                    .collect::<HashSet<_>>();
                allowed.extend(
                    shared_mcp_config
                        .servers
                        .keys()
                        .filter(|name| !disabled.contains(name.as_str()))
                        .cloned(),
                );
                allowed.extend(profile.mcp_policy.enabled_server_ids.iter().cloned());
            }
            LaunchProfileMcpMode::Disabled => {}
        }
    }

    let mut allowed = allowed.into_iter().collect::<Vec<_>>();
    allowed.sort();
    allowed
}

fn selected_shared_mcp_config_toml_for_codex(
    allowed_mcp_server_ids: &[String],
    shared_mcp_config: &SharedMcpConfig,
) -> String {
    let allowed = allowed_mcp_server_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let mut servers = toml::map::Map::new();

    for (name, config) in &shared_mcp_config.servers {
        if !allowed.contains(name.as_str()) {
            continue;
        }

        let mut server = toml::map::Map::new();
        server.insert(
            "command".to_string(),
            toml::Value::String(config.command.clone()),
        );
        server.insert(
            "args".to_string(),
            toml::Value::Array(
                config
                    .args
                    .iter()
                    .cloned()
                    .map(toml::Value::String)
                    .collect(),
            ),
        );
        if !config.env.is_empty() {
            let env = config
                .env
                .iter()
                .map(|(key, value)| (key.clone(), toml::Value::String(value.clone())))
                .collect::<toml::map::Map<_, _>>();
            server.insert("env".to_string(), toml::Value::Table(env));
        }
        servers.insert(name.clone(), toml::Value::Table(server));
    }

    if servers.is_empty() {
        return String::new();
    }

    let mut root = toml::map::Map::new();
    root.insert("mcp_servers".to_string(), toml::Value::Table(servers));
    toml::to_string_pretty(&toml::Value::Table(root)).unwrap_or_default()
}

/// 进程级 which 结果缓存，避免每次调用遍历 PATH（macOS 含网络路径时可能阻塞 3-10 秒）
/// 解析默认 Shell
/// Windows: 优先 pwsh > powershell > cmd
/// Unix: 使用 $SHELL 或 /bin/sh
fn resolve_default_shell() -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        // 优先 PowerShell 7
        if cached_which("pwsh").is_ok() {
            return ("pwsh".to_string(), vec![]);
        }
        // PowerShell 5.1
        if cached_which("powershell").is_ok() {
            return ("powershell".to_string(), vec![]);
        }
        // cmd.exe
        let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
        (comspec, vec![])
    }
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        (shell, vec![])
    }
}

/// Shell 信息
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    pub id: String,
    pub name: String,
    pub path: String,
}

impl ShellInfo {
    fn new(id: &str, name: &str, path: &str) -> Self {
        Self {
            id: id.to_string(),
            name: name.to_string(),
            path: path.to_string(),
        }
    }
}

/// 探测系统可用 Shell
pub fn detect_shells() -> Vec<ShellInfo> {
    let mut shells = vec![];

    #[cfg(windows)]
    {
        // 1. PowerShell 7
        if let Ok(path) = cached_which("pwsh") {
            shells.push(ShellInfo::new(
                "pwsh",
                "PowerShell 7",
                &path.to_string_lossy(),
            ));
        }
        // 2. PowerShell 5.1
        if let Ok(path) = cached_which("powershell") {
            shells.push(ShellInfo::new(
                "powershell",
                "Windows PowerShell",
                &path.to_string_lossy(),
            ));
        }
        // 3. cmd.exe
        let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
        shells.push(ShellInfo::new("cmd", "Command Prompt", &comspec));
        // 4. Git Bash
        let git_bash = "C:\\Program Files\\Git\\bin\\bash.exe";
        if std::path::Path::new(git_bash).exists() {
            shells.push(ShellInfo::new("git-bash", "Git Bash", git_bash));
        }
        // 5. WSL
        if cached_which("wsl").is_ok() {
            shells.push(ShellInfo::new("wsl", "WSL", "wsl"));
        }
    }

    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        let name = std::path::Path::new(&shell)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "sh".to_string());
        shells.push(ShellInfo::new(&name, &name, &shell));

        // 常见 shells
        for (id, name, path) in &[
            ("bash", "Bash", "/bin/bash"),
            ("zsh", "Zsh", "/bin/zsh"),
            ("fish", "Fish", "/usr/bin/fish"),
        ] {
            if std::path::Path::new(path).exists() && !shells.iter().any(|s| s.id == *id) {
                shells.push(ShellInfo::new(id, name, path));
            }
        }
    }

    shells
}

/// 根据 shell ID 解析 Shell 路径
fn resolve_shell(shell_id: Option<&str>) -> (String, Vec<String>) {
    if let Some(id) = shell_id {
        let shells = detect_shells();
        if let Some(shell) = shells.iter().find(|s| s.id == id) {
            return (shell.path.clone(), vec![]);
        }
    }
    resolve_default_shell()
}

/// 终端状态
///
/// **阶段 2 扩充**：从原 4 状态扩到 8 状态，承载 hook 驱动的细粒度生命周期。
/// 注意：所有变体均为单元变体，序列化为 camelCase 字符串（`"thinking"` / `"toolRunning"` ...），
/// 保持与前端 IPC 协议兼容（前端 `TerminalStatusType` 是字符串字面量并集）。
///
/// **工具名不放在枚举里**：序列化为对象会破坏前端协议。工具名由 `SessionStateMachine`
/// 单独维护在 `SessionStateEntry::current_tool_name`，前端通过 SessionStatusInfo 的扩展字段
/// （如果需要）单独获取。
// 序列化恒为 camelCase；反序列化额外用 alias 容忍 PascalCase——MCP 侧
// `waitFor` 参数的 schema 是 `Vec<String>`（枚举取值不进 schema），客户端只能
// 从工具描述猜大小写，实测两个不同的 agent（Claude 与 dsh）第一次都猜成了
// `"Idle"` 并吃了 unknown variant。alias 只影响输入端，输出照旧 camelCase。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionStatus {
    /// 启动中（hook 还没上报第一个事件）
    #[serde(alias = "Initializing")]
    Initializing,
    /// 真·空闲（TurnEnd hook 上报；或 PTY 输出超时的兜底降级）
    #[serde(alias = "Idle")]
    Idle,
    /// 思考中（PromptBefore 后、ToolBefore 前 / Stop 前）
    #[serde(alias = "Thinking")]
    Thinking,
    /// 工具调用中（ToolBefore 上报；工具名见 SessionStateEntry）
    #[serde(alias = "ToolRunning")]
    ToolRunning,
    /// 上下文压缩中（BeforeCompact 上报）
    #[serde(alias = "Compacting")]
    Compacting,
    /// 等待用户输入（Notification permission_prompt / elicitation_*）
    #[serde(alias = "WaitingInput")]
    WaitingInput,
    /// 出错（StopFailure 上报；error_type 由通知层附带）
    #[serde(alias = "Error")]
    Error,
    /// 会话退出
    #[serde(alias = "Exited")]
    Exited,
    /// **已弃用**：留作 PTY ANSI 推断的退化值，新代码应使用具体细分状态
    #[serde(rename = "active", alias = "Active")]
    Active,
}

impl SessionStatus {
    /// 是否处于"正在干活"语义（前端显示绿色家族 / 脉动动效）
    pub fn is_busy(&self) -> bool {
        matches!(
            self,
            SessionStatus::Thinking
                | SessionStatus::ToolRunning
                | SessionStatus::Compacting
                | SessionStatus::Active
        )
    }

    /// 是否终止
    pub fn is_terminal(&self) -> bool {
        matches!(self, SessionStatus::Exited)
    }
}

/// kill 的发起来源，随 `session-killed` 事件广播给所有前端。
/// 前端据此分流：user-close/mcp 关标签；orphan-reclaim/daemon-reaper 保留标签
/// 显示进程退出（回收类 kill 可能来自其他实例，静默关标签会造成"面板凭空消失"）。
/// `docs/17-provider-hot-switch.md` 预留的 ProviderSwitch 落地时在此加变体。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum KillReason {
    UserClose,
    Mcp,
    OrphanReclaim,
    DaemonReaper,
    LaunchTimeout,
    #[serde(other)]
    Unknown,
}

impl KillReason {
    pub fn parse(value: Option<&str>) -> Self {
        match value {
            Some("user-close") => KillReason::UserClose,
            Some("mcp") => KillReason::Mcp,
            Some("orphan-reclaim") => KillReason::OrphanReclaim,
            Some("daemon-reaper") => KillReason::DaemonReaper,
            Some("launch-timeout") => KillReason::LaunchTimeout,
            _ => KillReason::Unknown,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            KillReason::UserClose => "user-close",
            KillReason::Mcp => "mcp",
            KillReason::OrphanReclaim => "orphan-reclaim",
            KillReason::DaemonReaper => "daemon-reaper",
            KillReason::LaunchTimeout => "launch-timeout",
            KillReason::Unknown => "unknown",
        }
    }
}

/// 终端会话状态信息
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatusInfo {
    pub session_id: String,
    pub status: SessionStatus,
    pub last_output_at: u64, // 毫秒时间戳
    pub pid: Option<u32>,    // PTY 根进程 PID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_tool_use_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_tool_summary: Option<String>,
    pub updated_at: u64,
}

// ============ 输出缓冲区 ============

/// 剥离 ANSI 转义序列，返回纯文本
fn strip_ansi(data: &str) -> String {
    let bytes = strip_ansi_escapes::strip(data.as_bytes());
    String::from_utf8_lossy(&bytes).to_string()
}

/// 未完成转义序列的攒字节上限，按类型分档。超限就当普通文本放行——那等于退回
/// 「前半被吞、后半裸奔」的旧行为，所以档位必须留足真实序列的长度。
///
/// CSI 短得多（SGR truecolor 也才 19 字节），128 绰绰有余。OSC 则可以很长：
/// OSC 8 超链接带一条百余字符的 URL 就逼近 128（正好卡在临界，URL 再长一点就悄悄
/// 退化），OSC 52 往剪贴板塞 1KB 文本更是 1300+ 字节。故 OSC/DCS 一档给到 4KB，
/// 仍然有界——攒不满只说明流里有个孤立的 ESC，不该让它无限扣着后续输出不放。
const MAX_CSI_CARRY: usize = 128;
const MAX_STRING_ESCAPE_CARRY: usize = 4096;

/// `candidate` 以 ESC 开头；返回它这一类允许攒多少字节。
fn escape_carry_limit(candidate: &str) -> usize {
    match candidate.as_bytes().get(1) {
        // OSC / DCS / SOS / PM / APC 都是「字符串型」转义，长度无固定上限。
        Some(b']') | Some(b'P') | Some(b'X') | Some(b'^') | Some(b'_') => MAX_STRING_ESCAPE_CARRY,
        _ => MAX_CSI_CARRY,
    }
}

/// 把结尾那段**未完成的转义序列**从文本里切出来。返回 `(可安全剥离的部分, 待续尾巴)`。
///
/// PTY 是字节流，转义序列会被随机切在任意位置。`strip_ansi_escapes` 遇到未终止的
/// 序列是**整段吞掉**（实测 `"A\x1b[38;2;24"` → `"A"`，连 ESC 一起没了），于是下一个
/// chunk 开头的 `8;248;242m` 因为丢了 ESC 前缀，就被当成普通文本留在纯文本缓冲里。
///
/// `utf8_safe_process` 已经 carry 了未完成的 UTF-8 字符，`OutputBuffer` 也 carry 了
/// 未完成的行——唯独转义序列没人 carry，这里补上。
fn split_trailing_incomplete_escape(text: &str) -> (&str, &str) {
    let Some(esc_at) = text.rfind('\u{1b}') else {
        return (text, "");
    };
    // ESC 是 ASCII，不可能落在多字节字符内部，按字节切是安全的。
    let candidate = &text[esc_at..];
    if candidate.len() > escape_carry_limit(candidate) || is_complete_escape(candidate) {
        return (text, "");
    }
    (&text[..esc_at], candidate)
}

/// `candidate` 以 ESC 开头；判断它是否已经完整。
fn is_complete_escape(candidate: &str) -> bool {
    let bytes = candidate.as_bytes();
    debug_assert_eq!(bytes.first(), Some(&0x1b));
    let Some(&kind) = bytes.get(1) else {
        return false; // 光一个 ESC，后面还没来
    };

    match kind {
        // CSI：参数字节 0x30–0x3F、中间字节 0x20–0x2F，终止于 0x40–0x7E。
        b'[' => bytes[2..].iter().any(|&b| (0x40..=0x7e).contains(&b)),
        // OSC / DCS / SOS / PM / APC：终止于 BEL 或 ST（ESC \）。
        b']' | b'P' | b'X' | b'^' | b'_' => {
            bytes[2..].contains(&0x07) || candidate[2..].contains("\u{1b}\\")
        }
        // 其余是两字节转义（ESC + 单个终止符），有第二个字节就算完整。
        _ => true,
    }
}

/// 终端会话的输出环形缓冲区（存储 ANSI 已剥离的纯文本行）
struct OutputBuffer {
    lines: VecDeque<String>,
    /// 当前未完成行（未遇到换行符的尾部数据）
    partial: String,
    /// 被 chunk 边界切断的转义序列尾巴，等下一个 chunk 拼回去再剥离。
    /// 不 carry 的话前半会被 strip 整个吞掉，后半丢了 ESC 前缀就当正文留下。
    escape_carry: String,
    max_lines: usize,
    /// 当前 lines 中所有行的总字节数
    total_bytes: usize,
    max_bytes: usize,
}

/// attach-existing 时用于重建终端画面的原始 VT 回放缓冲区
struct ReplayBuffer {
    chunks: VecDeque<String>,
    total_bytes: usize,
    max_bytes: usize,
    buffer_mode: TerminalBufferMode,
    /// checkpoint 世代：创建时生成，daemon 重启 / 会话重建后必不相同，
    /// 用于拒收旧世代照片（评审修订 2 的第四拒收态）。
    epoch: u64,
    /// 会话起点以来累计推入的 raw 字节数（seq 记账，只增不减）。
    pushed_seq: u64,
    /// 窗口起点 seq：front-drop 丢弃 chunk 时前移被丢字节数。
    /// 不变式：`pushed_seq - window_start_seq == total_bytes`。
    window_start_seq: u64,
    /// 前端上传的画面照片（M3b-1 只存不裁剪；锚定裁剪属 M3b-4）。
    checkpoint: Option<TerminalCheckpoint>,
}

/// 生成 ReplayBuffer 的 checkpoint epoch：UNIX 毫秒 << 16 | 进程内单调计数低位。
/// 同进程内连续创建（同毫秒）靠低位区分；跨进程（daemon 重启）靠时间戳区分。
fn generate_checkpoint_epoch() -> u64 {
    use std::sync::atomic::AtomicU64;
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let low = COUNTER.fetch_add(1, Ordering::Relaxed) & 0xFFFF;
    (millis << 16) | low
}

/// 读取终端输出的返回类型
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOutput {
    pub session_id: String,
    pub lines: Vec<String>,
}

fn is_spinner_decoration(c: char) -> bool {
    matches!(
        c,
        '✻' | '✽' | '✶' | '✢' | '●' | '·' | '*' | '○' | '◉' | '◌' | '◦' | '•'
    )
}

fn normalize_spinner_line(line: &str) -> String {
    let trimmed = line.trim().trim_start_matches(|c: char| {
        is_spinner_decoration(c) || c.is_ascii_digit() || c.is_whitespace()
    });
    let mut normalized = String::with_capacity(trimmed.len());
    let mut previous_ascii_letter = None;

    for ch in trimmed.chars() {
        if is_spinner_decoration(ch) || ch.is_ascii_digit() {
            continue;
        }

        if ch.is_ascii_alphabetic() {
            let lower = ch.to_ascii_lowercase();
            if previous_ascii_letter == Some(lower) {
                continue;
            }
            normalized.push(lower);
            previous_ascii_letter = Some(lower);
            continue;
        }

        previous_ascii_letter = None;
        if ch.is_whitespace() {
            if !normalized.ends_with(' ') {
                normalized.push(' ');
            }
        } else {
            normalized.push(ch);
        }
    }

    normalized.trim().to_string()
}

/// 检测 Claude/Codex 动态状态行（无实质内容，应被过滤）
fn is_spinner_line(line: &str) -> bool {
    let text = normalize_spinner_line(line);
    if text.is_empty() {
        return false;
    }

    const SPINNER_WORDS: &[&str] = &[
        "reticulating",
        // 归一化会折叠连续相同字母，故存 simering 而非 simmering——与 bondogling
        // （来自 Boondoggling）同理。写原词会永远匹配不上。
        "simering",
        "swirling",
        "whirlpooling",
        "quantumizing",
        "synthesizing",
        "materializing",
        "crystalizing",
        "harmonizing",
        "calibrating",
        "percolating",
        "amalgamating",
        "coalescing",
        "bondogling",
        "churned",
    ];

    if SPINNER_WORDS.iter().any(|word| text.starts_with(word)) {
        return true;
    }

    text == "thinking more"
        || text == "almost done thinking"
        || text.starts_with("thinking more ")
        || text.starts_with("almost done thinking ")
        || text == "working"
        || text.starts_with("working(")
        || text.starts_with("working (")
        || text.starts_with("workinw")
        || text.starts_with("waiting for background terminal")
}

impl OutputBuffer {
    fn new(max_lines: usize, max_bytes: usize) -> Self {
        Self {
            lines: VecDeque::new(),
            partial: String::new(),
            escape_carry: String::new(),
            max_lines,
            total_bytes: 0,
            max_bytes,
        }
    }

    /// 追加终端输出文本到缓冲区
    fn push(&mut self, text: &str) {
        // 1. 先接回上个 chunk 被切断的转义序列，再切出本 chunk 的新尾巴，然后才剥离。
        //    顺序不能反：剥离是无状态的，未终止序列会被整段吞掉且不可恢复。
        let joined = if self.escape_carry.is_empty() {
            std::borrow::Cow::Borrowed(text)
        } else {
            let mut merged = std::mem::take(&mut self.escape_carry);
            merged.push_str(text);
            std::borrow::Cow::Owned(merged)
        };
        let (strippable, carry) = split_trailing_incomplete_escape(&joined);
        self.escape_carry = carry.to_string();

        let clean = strip_ansi(strippable);
        if clean.is_empty() {
            return;
        }

        // 2. 归一化换行：\r\n → \n，单独 \r → \n
        let normalized = clean.replace("\r\n", "\n").replace('\r', "\n");

        // 3. 拼接 partial 后按 \n 分行
        let combined = if self.partial.is_empty() {
            normalized
        } else {
            let mut p = std::mem::take(&mut self.partial);
            p.push_str(&normalized);
            p
        };

        let mut parts = combined.split('\n').peekable();
        while let Some(part) = parts.next() {
            if parts.peek().is_some() {
                // 完整行（后面还有 \n）
                self.push_line(part.to_string());
            } else {
                // 最后一段 → partial
                self.partial = part.to_string();
            }
        }

        // 4. partial 超 4KB 时强制 flush 成一行（防进度条等输出持续追加导致内存增长）
        if self.partial.len() > 4096 {
            let line = std::mem::take(&mut self.partial);
            self.push_line(line);
        }

        // 5. 淘汰直到满足限制
        self.evict();
    }

    fn push_line(&mut self, line: String) {
        // 过滤 spinner 动画行
        if is_spinner_line(&line) {
            return;
        }
        // 压缩连续空行：最多保留 1 个
        if line.trim().is_empty() {
            if let Some(last) = self.lines.back() {
                if last.trim().is_empty() {
                    return;
                }
            }
        }
        self.total_bytes += line.len();
        self.lines.push_back(line);
    }

    fn evict(&mut self) {
        while self.lines.len() > self.max_lines || self.total_bytes > self.max_bytes {
            if let Some(removed) = self.lines.pop_front() {
                self.total_bytes = self.total_bytes.saturating_sub(removed.len());
            } else {
                break;
            }
        }
    }

    /// 缩减缓冲区到指定上限（用于会话退出后释放内存）
    fn shrink(&mut self, max_lines: usize, max_bytes: usize) {
        self.max_lines = max_lines;
        self.max_bytes = max_bytes;
        self.evict();
    }

    /// 获取最近 N 行（0 = 全部）
    fn get_recent(&self, n: usize) -> Vec<String> {
        if n == 0 || n >= self.lines.len() {
            self.lines.iter().cloned().collect()
        } else {
            self.lines
                .iter()
                .skip(self.lines.len() - n)
                .cloned()
                .collect()
        }
    }
}

impl ReplayBuffer {
    fn new(max_bytes: usize) -> Self {
        Self {
            chunks: VecDeque::new(),
            total_bytes: 0,
            max_bytes,
            buffer_mode: TerminalBufferMode::Normal,
            epoch: generate_checkpoint_epoch(),
            pushed_seq: 0,
            window_start_seq: 0,
            checkpoint: None,
        }
    }

    fn push(&mut self, data: &str) {
        if data.is_empty() {
            return;
        }

        self.update_buffer_mode(data);

        let chunk_len = data.len();
        self.chunks.push_back(data.to_string());
        self.total_bytes += chunk_len;
        self.pushed_seq += chunk_len as u64;

        self.evict_front();
    }

    fn shrink(&mut self, max_bytes: usize) {
        self.max_bytes = max_bytes;
        self.evict_front();
    }

    /// front-drop 淘汰到 max_bytes 以内，同步前移窗口起点并复查照片有效性。
    fn evict_front(&mut self) {
        while self.total_bytes > self.max_bytes {
            let Some(front) = self.chunks.pop_front() else {
                break;
            };
            self.total_bytes = self.total_bytes.saturating_sub(front.len());
            self.window_start_seq += front.len() as u64;
        }
        // 窗口推过锚点 → 照片与保留字节之间出现缝隙，整体作废（宁可截史不可花屏）。
        if self
            .checkpoint
            .as_ref()
            .is_some_and(|cp| cp.anchor_seq < self.window_start_seq)
        {
            self.checkpoint = None;
        }
    }

    /// 存储前端上传的画面照片。校验顺序：too-large → epoch → stale → gap → future。
    /// 本批不裁剪 chunks（锚定裁剪属 M3b-4）。
    fn store_checkpoint(&mut self, cp: TerminalCheckpoint) -> StoreCheckpointOutcome {
        if cp.snapshot_ansi.len() > CHECKPOINT_SNAPSHOT_MAX_BYTES {
            return StoreCheckpointOutcome::RejectedTooLarge;
        }
        if cp.checkpoint_epoch != self.epoch {
            return StoreCheckpointOutcome::RejectedEpochMismatch;
        }
        if self
            .checkpoint
            .as_ref()
            .is_some_and(|existing| cp.anchor_seq <= existing.anchor_seq)
        {
            return StoreCheckpointOutcome::RejectedStaleAnchor;
        }
        if cp.anchor_seq < self.window_start_seq {
            return StoreCheckpointOutcome::RejectedAnchorGap;
        }
        if cp.anchor_seq > self.pushed_seq {
            return StoreCheckpointOutcome::RejectedFutureAnchor;
        }
        let anchor_seq = cp.anchor_seq;
        self.checkpoint = Some(cp);
        if CHECKPOINT_ANCHORING_ENABLED {
            // 锚定裁剪（M3b-4）：photo 已涵盖 anchor 之前全部字节的渲染效果，
            // 裁掉它们即把窗口语义从「会话起点 8MB」换成「photo + delta」。
            // 只裁整段（anchor 必落 chunk 边界，「丢弃只能整段」不变式无痛）。
            self.trim_before_anchor(anchor_seq);
        }
        StoreCheckpointOutcome::Accepted { anchor_seq }
    }

    /// 裁掉「整段位于 anchor 之前」的 chunks（起点 seq 与终点 seq 都 ≤ anchor）。
    /// 与 evict_front 的容量淘汰共用 window_start_seq 记账；不会裁过 anchor，
    /// 照片经本函数永不失效。
    fn trim_before_anchor(&mut self, anchor_seq: u64) {
        while let Some(front) = self.chunks.front() {
            let front_end = self.window_start_seq + front.len() as u64;
            if front_end > anchor_seq {
                break;
            }
            let front = self.chunks.pop_front().expect("front checked above");
            self.total_bytes = self.total_bytes.saturating_sub(front.len());
            self.window_start_seq += front.len() as u64;
        }
        debug_assert!(
            self.checkpoint
                .as_ref()
                .is_none_or(|cp| cp.anchor_seq >= self.window_start_seq),
            "trim_before_anchor must never invalidate the checkpoint"
        );
    }

    /// 是否需要催前端补拍：有效照片存在且 anchor 之后已积累超过阈值的新字节。
    /// **无照片（或照片已失效）不催**——首拍由前端边沿触发（M3b-2 补拍语义）。
    fn needs_checkpoint(&self, threshold_bytes: u64) -> bool {
        match self.checkpoint.as_ref() {
            Some(cp)
                if cp.checkpoint_epoch == self.epoch && cp.anchor_seq >= self.window_start_seq =>
            {
                self.pushed_seq.saturating_sub(cp.anchor_seq) > threshold_bytes
            }
            _ => false,
        }
    }

    /// 结构化恢复快照：有效照片时 photo + anchor 之后的保留字节作 delta；
    /// 无照片或已失效时 checkpoint: None + delta = 全窗口拼接（等价 snapshot().data）。
    fn recovery_snapshot(&self) -> TerminalRecoverySnapshot {
        let valid_checkpoint = self.checkpoint.as_ref().filter(|cp| {
            cp.checkpoint_epoch == self.epoch && cp.anchor_seq >= self.window_start_seq
        });
        let (checkpoint, delta) = match valid_checkpoint {
            Some(cp) => (Some(cp.clone()), self.concat_chunks_from(cp.anchor_seq)),
            None => (None, self.snapshot().data),
        };
        TerminalRecoverySnapshot {
            checkpoint,
            delta,
            buffer_mode: self.buffer_mode,
            end_seq: self.pushed_seq,
            checkpoint_epoch: self.epoch,
        }
    }

    /// 按序拼接「起点 seq ≥ anchor」的 chunk。push 以 chunk 为单位、seq 按 chunk
    /// 累加，前端见到的任何 endSeq 必落 chunk 边界；anchor 落在 chunk 中间理论
    /// 不该发生，按保守整段包含（重复优于丢字）并在 debug_assert 里抓。
    fn concat_chunks_from(&self, anchor_seq: u64) -> String {
        let mut seq = self.window_start_seq;
        let mut delta = String::new();
        for chunk in &self.chunks {
            let end = seq + chunk.len() as u64;
            if seq >= anchor_seq {
                delta.push_str(chunk);
            } else if end > anchor_seq {
                debug_assert!(
                    false,
                    "checkpoint anchor {anchor_seq} fell inside a chunk [{seq}, {end})"
                );
                delta.push_str(chunk);
            }
            seq = end;
        }
        delta
    }

    fn snapshot(&self) -> TerminalReplaySnapshot {
        // 锚定裁剪后（M3b-4）旧端点必须仍返回完整画面：photo + 保留字节拼接串。
        // 两张照片之间拼接串保持前缀增长；photo rebase 时轮询差分走一次
        // desync（M3b-0 已修好该路）。未裁剪 / 无照片时行为逐字节等于旧实现。
        let photo = self
            .checkpoint
            .as_ref()
            .filter(|cp| {
                CHECKPOINT_ANCHORING_ENABLED
                    && cp.checkpoint_epoch == self.epoch
                    && cp.anchor_seq >= self.window_start_seq
            })
            .map(|cp| cp.snapshot_ansi.as_str())
            .unwrap_or("");
        let mut data = String::with_capacity(photo.len() + self.total_bytes);
        data.push_str(photo);
        for chunk in &self.chunks {
            data.push_str(chunk);
        }
        TerminalReplaySnapshot {
            data,
            buffer_mode: self.buffer_mode,
        }
    }

    fn update_buffer_mode(&mut self, data: &str) {
        let bytes = data.as_bytes();
        let mut i = 0;
        while i + 4 < bytes.len() {
            if bytes[i] == 0x1b && bytes[i + 1] == b'[' && bytes[i + 2] == b'?' {
                let mut j = i + 3;
                while j < bytes.len() && bytes[j].is_ascii_digit() {
                    j += 1;
                }
                if j >= bytes.len() {
                    break;
                }

                let code = &data[i + 3..j];
                let action = bytes[j];
                let is_alt_screen = matches!(code, "47" | "1047" | "1049");
                if is_alt_screen {
                    match action {
                        b'h' => self.buffer_mode = TerminalBufferMode::Alternate,
                        b'l' => self.buffer_mode = TerminalBufferMode::Normal,
                        _ => {}
                    }
                }
                i = j;
            }
            i += 1;
        }
    }
}

/// 终端会话
struct TerminalSession {
    launch_id: Option<String>,
    project_path: String,
    runtime_kind: String,
    /// 这条会话跑的是哪个 CLI。submit 时据此判断目标是不是带 composer 的 TUI——
    /// 纯 shell 与 TUI agent 对「多行文本里的换行」期待相反。
    cli_tool: CliTool,
    process: Arc<dyn PtyProcess>,
    writer_tx: mpsc::Sender<WriterCommand>,
    status: Arc<Mutex<SessionStatus>>,
    exit_code: Arc<Mutex<Option<i32>>>,
    last_output_at: Arc<Mutex<Instant>>,
    /// reader 线程取消标志：kill() 设置为 true，reader 线程检查后退出
    cancelled: Arc<AtomicBool>,
    /// 输出缓冲区（ANSI 已剥离的纯文本行）
    output_buffer: Arc<Mutex<OutputBuffer>>,
    /// attach-existing 时重建屏幕用的原始 VT 缓冲
    replay_buffer: Arc<Mutex<ReplayBuffer>>,
    /// TUI 已通过 DECSET 2004 宣告可接收 bracketed paste。
    paste_ready: Arc<AtomicBool>,
    /// 投递记账（B-5）：已 emit 但前端未确认的字节数，Stage 3 的暂停水位输入。
    output_flow: Arc<OutputFlowGate>,
    /// Managed Pi launches own an isolated adapter state directory. Native Pi
    /// has no descriptor and therefore never reaches this cleanup path.
    managed_pi_state_cleanup: Option<PiManagedStateCleanup>,
    /// WSL managed Pi state lives under the distribution user's home, so it
    /// needs its own cleanup descriptor instead of the local adapter root.
    managed_wsl_pi_state_cleanup: Option<WslManagedPiStateCleanup>,
}

/// Keeps adapter-created managed Pi state owned by the launch until the PTY
/// session has been registered. Every early return after Pi builds its command
/// then tears down the isolated directory automatically.
struct PendingPiManagedStateCleanup {
    cleanup: Option<PiManagedStateCleanup>,
}

impl PendingPiManagedStateCleanup {
    fn new(cleanup: Option<PiManagedStateCleanup>) -> Self {
        Self { cleanup }
    }

    fn disarm(&mut self) {
        self.cleanup = None;
    }
}

impl Drop for PendingPiManagedStateCleanup {
    fn drop(&mut self) {
        if let Some(cleanup) = self.cleanup.take() {
            cleanup.cleanup();
        }
    }
}

/// The WSL Pi directory only exists after the PTY begins its WSL launch. Keep
/// its cleanup descriptor armed until the terminal session owns it, including
/// the narrow cancellation window after a PTY has been spawned.
struct PendingWslManagedPiStateCleanup {
    cleanup: Option<WslManagedPiStateCleanup>,
}

impl PendingWslManagedPiStateCleanup {
    fn new(cleanup: Option<WslManagedPiStateCleanup>) -> Self {
        Self { cleanup }
    }

    fn disarm(&mut self) {
        self.cleanup = None;
    }
}

impl Drop for PendingWslManagedPiStateCleanup {
    fn drop(&mut self) {
        if let Some(cleanup) = self.cleanup.take() {
            cleanup.cleanup();
        }
    }
}

struct LaunchReservation<'a> {
    active_launches: &'a Mutex<HashSet<String>>,
    launch_id: String,
}

impl Drop for LaunchReservation<'_> {
    fn drop(&mut self) {
        if let Ok(mut active_launches) = self.active_launches.lock() {
            active_launches.remove(&self.launch_id);
        }
    }
}

/// Orchestrator 连接信息（port + token），启动后注入
#[derive(Debug, Clone)]
pub struct OrchestratorInfo {
    pub port: u16,
    pub token: String,
}

/// 探测 loopback 端口上是否为**我们自己的** orchestrator。
///
/// 仅做裸 TCP connect 不够：orchestrator 端口是 OS 随机分配的，宿主退出后可能被
/// 无关本地进程回收；裸 connect 会误判可达，进而把真实 token 注入陌生进程。
/// 这里改为对 `/api/health` 发一个最小 HTTP 请求，校验返回体是本 orchestrator 独有的
/// `{"status":"ok"}`——陌生监听者不会实现该路由与该载荷，从而杜绝 token 外泄。
fn local_orchestrator_endpoint_reachable(port: u16) -> bool {
    use std::io::{Read, Write};

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(250))
    else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(400)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(400)));

    let request =
        "GET /api/health HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n".as_bytes();
    if stream.write_all(request).is_err() {
        return false;
    }

    let mut response = Vec::with_capacity(256);
    let mut buf = [0_u8; 256];
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                response.extend_from_slice(&buf[..n]);
                if response.len() > 4096 {
                    break;
                }
            }
            Err(_) => break,
        }
    }

    let text = String::from_utf8_lossy(&response);
    let status_ok = text
        .lines()
        .next()
        .map(|line| line.contains("200"))
        .unwrap_or(false);
    status_ok && text.contains("\"status\"") && text.contains("\"ok\"")
}

struct DeadBufferEntry {
    output_buffer: Arc<Mutex<OutputBuffer>>,
    replay_buffer: Arc<Mutex<ReplayBuffer>>,
    created_at: Instant,
    exit_code: Arc<Mutex<Option<i32>>>,
    pid: Option<u32>,
    last_output_at: u64,
}

/// 终端服务 - 管理多个 PTY 会话
pub struct TerminalService {
    sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
    /// Launch ids currently being created. This closes duplicate/retry races before a session id
    /// exists, while the session map remains the source of truth after registration.
    active_launches: Mutex<HashSet<String>>,
    /// One-shot launch ids cancelled by an outer deadline before a session id was available.
    cancelled_launches: Mutex<HashMap<String, Instant>>,
    /// 已退出会话的缓冲区，保留 5 分钟供事后读取
    dead_buffers: Arc<Mutex<HashMap<String, DeadBufferEntry>>>,
    settings_service: Arc<SettingsService>,
    provider_service: Arc<ProviderService>,
    notifier: parking_lot::RwLock<Option<Arc<dyn SessionNotifier>>>,
    emitter: parking_lot::RwLock<Option<Arc<dyn EventEmitter>>>,
    app_paths: Arc<AppPaths>,
    /// Orchestrator 连接信息，setup 阶段设置
    orchestrator_info: Mutex<Option<OrchestratorInfo>>,
    /// hook 驱动的会话状态机（阶段 2.8 setter 注入；用于 ANSI 推断降级判定）
    state_machine: Mutex<Option<Arc<crate::services::SessionStateMachine>>>,
    /// Spec 服务（终端启动时自动注入 active spec prompt）
    spec_service: Mutex<Option<Arc<SpecService>>>,
    /// CLI 工具适配器注册表
    cli_registry: Arc<CliToolRegistry>,
    /// 项目级 CLI hooks 服务
    project_cli_hooks_service: Arc<ProjectCliHooksService>,
    ssh_credential_service: Arc<SshCredentialService>,
    ssh_connection_service: Arc<SshConnectionService>,
    /// 共享 MCP 服务引用（setup 阶段注入）
    shared_mcp_service: parking_lot::RwLock<Option<Arc<crate::services::SharedMcpService>>>,
    /// daemon 模式下由 control 通道推送的共享 MCP running URL 表。
    /// None = 从未收到推送（旧 app / 尚未连接）；Some(空 map) = 明确告知当前没有 running server。
    /// in-process 模式恒为 None，走 shared_mcp_service.get_running_servers_urls() 原路径。
    shared_mcp_url_override: parking_lot::RwLock<Option<HashMap<String, String>>>,
    /// Tauri 打包资源目录。Linux 安装布局下它不一定与主程序同目录。
    sidecar_resource_dir: parking_lot::RwLock<Option<PathBuf>>,
    launch_profile_service: parking_lot::RwLock<Option<Arc<LaunchProfileService>>>,
    workspace_service: parking_lot::RwLock<Option<Arc<WorkspaceService>>>,
    /// 每个 session 独立串行化所有输入写入，避免键盘输入、粘贴和 submit 互相交错。
    // Arc 以便自然退出的 wait 线程也能清理条目（kill 走 &self，wait 走 move 闭包）
    input_mutexes: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
}

struct SshAuthRuntime {
    prompt_buffer: String,
    saved_password: String,
    auto_response_sent: bool,
}

enum WriterCommand {
    Write {
        data: Vec<u8>,
        ack: mpsc::Sender<Result<(), String>>,
    },
}

const TERMINAL_WRITE_CHUNK_SIZE: usize = 512;
const TERMINAL_WRITE_INTER_CHUNK_DELAY: Duration = Duration::from_millis(30);
const TERMINAL_WRITE_ACK_TIMEOUT: Duration = Duration::from_secs(5);
const LIVE_OUTPUT_MAX_LINES: usize = 20_000;
const LIVE_OUTPUT_MAX_BYTES: usize = 20 * 1024 * 1024;
const LIVE_REPLAY_MAX_BYTES: usize = 8 * 1024 * 1024;
/// replay 环形缓冲的**地板**。上限随用户 scrollback 缩放（见
/// `live_replay_max_bytes`），但不低于这个值——低于一屏历史的重放没有意义。
const LIVE_REPLAY_MIN_BYTES: usize = LIVE_REPLAY_MAX_BYTES;
/// 每行 scrollback 折算的字节数：80 列文本 + 转义序列开销的经验值。
/// 上限是**内存界**而非精确的保留量承诺（照 Orca `terminal-scrollback-policy.ts:36-44`）。
const REPLAY_BYTES_PER_SCROLLBACK_ROW: usize = 120;

/// 按用户的 scrollback 设置算 replay 上限。
///
/// 固定 8MB 的问题：把 scrollback 调到 50k 行的用户，其 replay 窗口装不下他本该
/// 保留的历史，attach/desync 重建时白白截史。取 `max(地板, rows × 120)` 让上限
/// 跟着设置走。
fn live_replay_max_bytes(scrollback_rows: u32) -> usize {
    LIVE_REPLAY_MIN_BYTES.max(scrollback_rows as usize * REPLAY_BYTES_PER_SCROLLBACK_ROW)
}
/// PTY reader → 合批线程的有界通道容量（B-1）。与 WS 层对齐
/// （`ws_emitter.rs` SESSION_CHANNEL_CAPACITY = 256）。生产者暂停是主机制，
/// 这里只在闸门被关掉 / 对端无回执能力 / 洪流快过闸门时兜底。
const OUTPUT_BATCH_CHANNEL_CAPACITY: usize = 256;

/// M3b-4 锚定开关：照片被接受后裁掉 anchor 之前的 chunks（内存从「会话起点
/// 8MB 环」变「照片 + 照片之后的 delta」）。
///
/// **回退语义（评审修订 4，诚实版）**：翻回 false 只保证「新照片停止触发
/// 裁剪 + 恢复路径回落」；已被裁剪的会话历史不可恢复——那些会话接受
/// scrollback 深度损失（画面完整性不受影响：photo 涵盖被裁剪字节的渲染
/// 效果）。不承诺无损热回退。
const CHECKPOINT_ANCHORING_ENABLED: bool = true;
/// 前端上传照片（snapshot_ansi）的体积上限，超过即拒收。
const CHECKPOINT_SNAPSHOT_MAX_BYTES: usize = 8 * 1024 * 1024;
const DEAD_OUTPUT_MAX_LINES: usize = 20_000;
const DEAD_OUTPUT_MAX_BYTES: usize = 10 * 1024 * 1024;
const DEAD_REPLAY_MAX_BYTES: usize = 4 * 1024 * 1024;
const SUBMIT_TEXT_MAX_BYTES: usize = 256 * 1024;
const BRACKETED_PASTE_START: &str = "\x1b[200~";
const BRACKETED_PASTE_END: &str = "\x1b[201~";
const PASTE_READY_SUBMIT_DELAY_MS: u64 = 200;

/// 把文本包进终端 bracketed-paste 协议，并移除所有内嵌结束标记。
///
/// 在完整字符串上清洗后才进入分块写入，因此结束标记即使原输入跨调用方分片拼接，
/// 也无法提前逃逸粘贴块。
pub fn wrap_bracketed_paste(text: &str) -> String {
    let sanitized = text.replace(BRACKETED_PASTE_END, "");
    let mut wrapped = String::with_capacity(
        BRACKETED_PASTE_START.len() + sanitized.len() + BRACKETED_PASTE_END.len(),
    );
    wrapped.push_str(BRACKETED_PASTE_START);
    wrapped.push_str(&sanitized);
    wrapped.push_str(BRACKETED_PASTE_END);
    wrapped
}

fn submit_delay_ms(text_len: usize, paste_ready: bool) -> u64 {
    if paste_ready {
        PASTE_READY_SUBMIT_DELAY_MS
    } else {
        std::cmp::min(200 + (text_len as u64 / 512) * 30, 5000)
    }
}

fn summarize_input_bytes(data: &[u8]) -> serde_json::Value {
    let text = String::from_utf8_lossy(data);
    let chars: Vec<String> = text
        .chars()
        .take(24)
        .map(|ch| ch.escape_default().to_string())
        .collect();
    let code_points: Vec<String> = text
        .chars()
        .take(24)
        .map(|ch| format!("{:x}", ch as u32))
        .collect();
    let bytes: Vec<String> = data
        .iter()
        .take(32)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    serde_json::json!({
        "chars": chars,
        "charCount": text.chars().count(),
        "utf8Bytes": data.len(),
        "codePoints": code_points,
        "bytes": bytes,
        "truncated": text.chars().count() > 24 || data.len() > 32,
    })
}

fn spawn_terminal_writer(
    session_id: String,
    mut writer: Box<dyn Write + Send>,
) -> mpsc::Sender<WriterCommand> {
    let (writer_tx, writer_rx) = mpsc::channel::<WriterCommand>();

    thread::spawn(move || {
        while let Ok(command) = writer_rx.recv() {
            match command {
                WriterCommand::Write { data, ack } => {
                    debug!(
                        session_id = %session_id,
                        input = %summarize_input_bytes(&data),
                        "terminal-input.trace pty.writer.write"
                    );
                    let result = writer
                        .write_all(&data)
                        .and_then(|_| writer.flush())
                        .map_err(|error| error.to_string());
                    let should_stop = result.is_err();
                    let _ = ack.send(result);

                    if should_stop {
                        warn!(session_id = %session_id, "Terminal writer stopped after write error");
                        break;
                    }
                }
            }
        }
    });

    writer_tx
}

fn write_via_writer_tx(writer_tx: &mpsc::Sender<WriterCommand>, data: Vec<u8>) -> Result<()> {
    if data.is_empty() {
        return Ok(());
    }

    let (ack_tx, ack_rx) = mpsc::channel();
    writer_tx
        .send(WriterCommand::Write { data, ack: ack_tx })
        .map_err(|_| anyhow!("Terminal writer is closed"))?;

    match ack_rx.recv_timeout(TERMINAL_WRITE_ACK_TIMEOUT) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(anyhow!(error)),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(anyhow!("Terminal write timed out")),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(anyhow!("Terminal writer stopped")),
    }
}

/// ConPTY style-only 空闲帧：\x1b[39m\x1b[49m\x1b[59m\x1b[0m\x1b[?25l  (25 字节)
#[cfg_attr(not(windows), allow(dead_code))]
const CONPTY_STYLE_ONLY: &[u8] = b"\x1b[39m\x1b[49m\x1b[59m\x1b[0m\x1b[?25l";

/// 跨块缓冲状态，仅保留 carry 用于处理被拆分到两次 read() 的模式
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Default)]
struct WindowsOutputSanitizeState {
    carry: Vec<u8>,
}

/// 单次线性扫描剥离 ConPTY 光标渲染伪影
///
/// ConPTY 光标重绘的实际字节序列：
///   模式 A: \x08 <any_char> \x1b[7m <space>           (7 字节) — 退格+重绘原字符+反显空格
///   模式 D: \x1b[39m\x1b[49m\x1b[59m\x1b[0m\x1b[?25l  (25 字节) — style-only 空闲帧
///
/// 注意：旧版模式 B (\x1b[27m) 和模式 C (\x1b[7m <space>) 已移除。
/// 它们是标准的 SGR 反显序列，无条件剥离会导致 vim/less 等 TUI 应用渲染乱码。
/// 残留的 \x1b[27m 传到 xterm.js 后是无害的（当前无反显则为 no-op）。
#[cfg_attr(not(windows), allow(dead_code))]
fn strip_conpty_artifacts(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut i = 0;
    while i < data.len() {
        // 模式 A：\x08 <any_char> \x1b[7m <space>  (7 字节)
        // 光标重绘：退格 + 重绘原字符 + 反显空格
        if i + 7 <= data.len()
            && data[i] == 0x08
            && data[i + 2] == 0x1b
            && data[i + 3] == 0x5b
            && data[i + 4] == 0x37
            && data[i + 5] == 0x6d
            && data[i + 6] == 0x20
        {
            i += 7;
            continue;
        }

        // 模式 D：style-only 空闲帧 (25 字节)
        if i + CONPTY_STYLE_ONLY.len() <= data.len() && data[i..].starts_with(CONPTY_STYLE_ONLY) {
            i += CONPTY_STYLE_ONLY.len();
            continue;
        }

        out.push(data[i]);
        i += 1;
    }
    out
}

/// 检测数据末尾是否是某个可识别模式的不完整前缀
///
/// 返回需要保留到下一次 read() 的尾部字节数。
/// 所有模式的起始字节是 0x08 或 0x1b，只需检查以这些字节开头的后缀。
#[cfg_attr(not(windows), allow(dead_code))]
fn trailing_partial_len(input: &[u8]) -> usize {
    if input.is_empty() {
        return 0;
    }

    // 最长模式 25 字节（CONPTY_STYLE_ONLY），检查范围 = min(24, input.len())
    let max_check = 24.min(input.len());

    for suffix_len in (1..=max_check).rev() {
        let start = input.len() - suffix_len;
        let suffix = &input[start..];
        let first = suffix[0];

        // 只有 0x08 或 0x1b 才可能是模式起始
        if first != 0x08 && first != 0x1b {
            continue;
        }

        if is_prefix_of_any_pattern(suffix) {
            return suffix_len;
        }
    }

    0
}

/// 检查 `data` 是否是任意一个可识别模式的前缀（但不是完整匹配）
#[cfg_attr(not(windows), allow(dead_code))]
fn is_prefix_of_any_pattern(data: &[u8]) -> bool {
    let len = data.len();

    // 模式 A: \x08 <any> \x1b[7m <space>  (7 字节)
    // 前缀长度 1: \x08
    // 前缀长度 2: \x08 <any>  — 任意第二字节都合法
    // 前缀长度 3..6: 后续字节固定
    if len < 7 && data[0] == 0x08 {
        if len == 1 || len == 2 {
            return true;
        }
        // len >= 3: data[2] == 0x1b
        let pattern_tail: &[u8] = &[0x1b, 0x5b, 0x37, 0x6d, 0x20];
        if data[2..] == pattern_tail[..len - 2] {
            return true;
        }
    }

    // 模式 D: CONPTY_STYLE_ONLY  (25 字节)
    if len < CONPTY_STYLE_ONLY.len() && data[0] == 0x1b && data[..] == CONPTY_STYLE_ONLY[..len] {
        return true;
    }

    false
}

#[cfg(windows)]
fn sanitize_windows_output(
    chunk: &[u8],
    state: &mut WindowsOutputSanitizeState,
    disable_sanitize: bool,
) -> Vec<u8> {
    if disable_sanitize {
        return chunk.to_vec();
    }

    // 合并上次遗留的 carry 和本次 chunk
    let mut combined = Vec::with_capacity(state.carry.len() + chunk.len());
    combined.extend_from_slice(&state.carry);
    combined.extend_from_slice(chunk);
    state.carry.clear();

    // 检测末尾是否有不完整的模式前缀，保留到下次
    let keep_len = trailing_partial_len(&combined);
    if keep_len > 0 {
        let split_at = combined.len() - keep_len;
        state.carry.extend_from_slice(&combined[split_at..]);
        combined.truncate(split_at);
    }

    if combined.is_empty() {
        return Vec::new();
    }

    strip_conpty_artifacts(&combined)
}

/// UTF-8 安全的输出处理
///
/// 处理跨 chunk 的 UTF-8 多字节字符截断问题。
/// 如果 chunk 末尾是不完整的 UTF-8 序列，将其保留到下一次 read。
/// Windows PowerShell 5.1 在中文系统上可能输出 GBK/GB2312 字节，因此 UTF-8
/// 严格解码失败时回退到 GBK，避免中文直接变成 replacement characters。
fn utf8_safe_process(buf: &[u8], carry: &mut Vec<u8>) -> Option<String> {
    let mut combined = Vec::with_capacity(carry.len() + buf.len());
    combined.extend_from_slice(carry);
    combined.extend_from_slice(buf);
    carry.clear();

    if combined.is_empty() {
        return None;
    }

    match std::str::from_utf8(&combined) {
        Ok(output) => Some(output.to_string()),
        Err(error) if error.error_len().is_none() => {
            let valid_end = error.valid_up_to();
            carry.extend_from_slice(&combined[valid_end..]);
            if valid_end == 0 {
                return None;
            }

            Some(decode_terminal_output(&combined[..valid_end]))
        }
        Err(_) => Some(decode_terminal_output(&combined)),
    }
}

fn decode_terminal_output(bytes: &[u8]) -> String {
    if let Ok(output) = std::str::from_utf8(bytes) {
        return output.to_string();
    }

    let (decoded, _, _) = encoding_rs::GBK.decode(bytes);
    decoded.into_owned()
}

fn normalize_prompt_text(data: &str) -> String {
    strip_ansi(&data.replace("\r\n", "\n").replace('\r', "\n"))
}

fn looks_like_ssh_password_prompt(prompt: &str) -> bool {
    let lower = prompt.to_ascii_lowercase();
    !lower.contains("passphrase") && (lower.ends_with("password:") || lower.ends_with("password: "))
}

fn ssh_password_response(password: &str) -> Vec<u8> {
    format!("{password}\r").into_bytes()
}

fn current_epoch_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn build_session_status_info(
    session_id: String,
    status: SessionStatus,
    last_output_at: u64,
    pid: Option<u32>,
    exit_code: Option<i32>,
    state_machine: Option<&Arc<crate::services::SessionStateMachine>>,
) -> SessionStatusInfo {
    let snapshot = state_machine.and_then(|sm| sm.snapshot(&session_id));
    let effective_status = state_machine
        .map(|sm| sm.status_for_query(&session_id, status))
        .unwrap_or(status);
    let stale_busy_fallback = status.is_busy() && effective_status == SessionStatus::Idle;
    SessionStatusInfo {
        session_id,
        status: effective_status,
        last_output_at,
        pid,
        exit_code,
        current_tool_name: if stale_busy_fallback {
            None
        } else {
            snapshot
                .as_ref()
                .and_then(|entry| entry.current_tool_name.clone())
        },
        current_tool_use_id: if stale_busy_fallback {
            None
        } else {
            snapshot
                .as_ref()
                .and_then(|entry| entry.current_tool_use_id.clone())
        },
        current_tool_summary: if stale_busy_fallback {
            None
        } else {
            snapshot
                .as_ref()
                .and_then(|entry| entry.current_tool_summary.clone())
        },
        updated_at: snapshot
            .as_ref()
            .map(|entry| entry.updated_at)
            .unwrap_or(last_output_at),
    }
}

fn should_apply_pty_status_fallback(hook_active: bool, current: SessionStatus) -> bool {
    !hook_active && !matches!(current, SessionStatus::Exited | SessionStatus::Error)
}

fn append_ssh_session_options(args: &mut Vec<String>) {
    for option in [
        "ConnectTimeout=10",
        "ServerAliveInterval=15",
        "ServerAliveCountMax=2",
        "TCPKeepAlive=yes",
    ] {
        args.push("-o".to_string());
        args.push(option.to_string());
    }
}

impl TerminalService {
    pub fn new(
        settings_service: Arc<SettingsService>,
        provider_service: Arc<ProviderService>,
        app_paths: Arc<AppPaths>,
        cli_registry: Arc<CliToolRegistry>,
        project_cli_hooks_service: Arc<ProjectCliHooksService>,
        ssh_credential_service: Arc<SshCredentialService>,
    ) -> Self {
        let ssh_connection_service = Arc::new(SshConnectionService::new(
            ssh_credential_service.clone(),
            app_paths.data_dir().join("ssh-known-hosts"),
        ));
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            active_launches: Mutex::new(HashSet::new()),
            cancelled_launches: Mutex::new(HashMap::new()),
            dead_buffers: Arc::new(Mutex::new(HashMap::new())),
            settings_service,
            provider_service,
            notifier: parking_lot::RwLock::new(None),
            emitter: parking_lot::RwLock::new(None),
            app_paths,
            orchestrator_info: Mutex::new(None),
            state_machine: Mutex::new(None),
            spec_service: Mutex::new(None),
            cli_registry,
            project_cli_hooks_service,
            ssh_credential_service,
            ssh_connection_service,
            shared_mcp_service: parking_lot::RwLock::new(None),
            shared_mcp_url_override: parking_lot::RwLock::new(None),
            sidecar_resource_dir: parking_lot::RwLock::new(None),
            launch_profile_service: parking_lot::RwLock::new(None),
            workspace_service: parking_lot::RwLock::new(None),
            input_mutexes: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn ssh_connection_service(&self) -> Arc<SshConnectionService> {
        self.ssh_connection_service.clone()
    }

    /// Set event emitter (called during setup when AppHandle is available)
    pub fn set_emitter(&self, emitter: Arc<dyn EventEmitter>) {
        *self.emitter.write() = Some(emitter);
    }

    /// Set session notifier (called during setup when AppHandle is available)
    pub fn set_notifier(&self, notifier: Arc<dyn SessionNotifier>) {
        *self.notifier.write() = Some(notifier);
    }

    /// 设置 Spec 服务（用于终端启动时自动注入 active spec prompt）
    pub fn set_spec_service(&self, spec_service: Arc<SpecService>) {
        if let Ok(mut svc) = self.spec_service.lock() {
            *svc = Some(spec_service);
        }
    }

    /// 设置共享 MCP 服务引用（setup 阶段调用）
    pub fn set_shared_mcp_service(&self, service: Arc<crate::services::SharedMcpService>) {
        *self.shared_mcp_service.write() = Some(service);
        info!("[terminal] SharedMcpService injected");
    }

    /// 设置 daemon control 通道推送的共享 MCP running URL 覆盖表。
    /// `None` 表示清除推送状态并回落到本进程 SharedMcpService 的运行时状态。
    pub fn set_shared_mcp_url_override(&self, urls: Option<HashMap<String, String>>) {
        let description = match urls.as_ref() {
            Some(urls) => format!("{} running server(s)", urls.len()),
            None => "no override".to_string(),
        };
        *self.shared_mcp_url_override.write() = urls;
        info!("[terminal] Shared MCP URL override updated: {description}");
    }

    #[cfg(test)]
    pub(crate) fn shared_mcp_url_override_for_test(&self) -> Option<HashMap<String, String>> {
        self.shared_mcp_url_override.read().clone()
    }

    fn resolve_effective_shared_mcp_urls(
        &self,
        shared_mcp_service: Option<&crate::services::SharedMcpService>,
        launch_profile_id: Option<&str>,
        resolved_workspace: Option<&crate::models::Workspace>,
        cli_tool: CliTool,
        runtime_kind: &str,
        effective_skip_mcp: bool,
    ) -> HashMap<String, String> {
        if effective_skip_mcp {
            return HashMap::new();
        }

        // daemon 模式下 running map 恒空（server 子进程归 app 所有），
        // 真值由 control 通道推送。override 存在即优先；None 才回落原路径。
        let shared_mcp_urls = match self.shared_mcp_url_override.read().clone() {
            Some(pushed) => pushed,
            None => shared_mcp_service
                .map(|svc| svc.get_running_servers_urls())
                .unwrap_or_default(),
        };
        self.launch_profile_service
            .read()
            .as_ref()
            .map(|svc| {
                svc.resolve_shared_mcp_urls_for_profile(
                    launch_profile_id,
                    resolved_workspace,
                    Some(cli_tool.as_id()),
                    Some(runtime_kind),
                    shared_mcp_urls.clone(),
                )
            })
            .unwrap_or(shared_mcp_urls)
    }

    pub fn set_sidecar_resource_dir(&self, resource_dir: PathBuf) {
        *self.sidecar_resource_dir.write() = Some(resource_dir);
    }

    fn portable_bundled_skill_prompt(
        &self,
        cli_tool: CliTool,
        profile: Option<&LaunchProfile>,
        ccpanes_mcp_available: bool,
    ) -> Option<String> {
        if !uses_portable_skill_session_prompt_fallback(&self.cli_registry, cli_tool) {
            return None;
        }
        let skill_names = LaunchProfileService::bundled_skill_names_for_session_prompt(profile);
        if skill_names.is_empty() {
            return None;
        }
        let templates_dir = self
            .sidecar_resource_dir
            .read()
            .as_ref()
            .map(|resource_dir| {
                resource_dir
                    .join("resources")
                    .join("claude-bundle")
                    .join("default-skills")
            })?;
        if !templates_dir.join("manifest.json").is_file() {
            debug!(
                path = %templates_dir.display(),
                "portable bundled Skill session fallback unavailable: manifest is missing"
            );
            return None;
        }
        let adapter_supports_mcp = self
            .cli_registry
            .get(cli_tool.as_id())
            .is_some_and(|adapter| adapter.capabilities().supports_mcp);
        DefaultSkillService::new(templates_dir)
            .portable_session_prompt(&skill_names, ccpanes_mcp_available && adapter_supports_mcp)
    }

    /// Publish only explicitly Pi-compatible bundled Skills into a managed
    /// launch's isolated Pi state. Native Pi continues to use its own global
    /// agent root and is handled by startup-wide skill publication instead.
    fn inject_managed_pi_skills(&self, agent_root: &Path) {
        let templates_dir = self
            .sidecar_resource_dir
            .read()
            .as_ref()
            .map(|resource_dir| {
                resource_dir
                    .join("resources")
                    .join("claude-bundle")
                    .join("default-skills")
            });
        let Some(templates_dir) = templates_dir else {
            warn!("managed Pi skill injection skipped because bundled resources are unavailable");
            return;
        };
        if !templates_dir.join("manifest.json").is_file() {
            warn!(
                path = %templates_dir.display(),
                "managed Pi skill injection skipped because the bundled manifest is missing"
            );
            return;
        }
        DefaultSkillService::new(templates_dir)
            .inject_pi_skills_to_agent_root(agent_root, env!("CARGO_PKG_VERSION"));
    }

    pub fn set_launch_profile_service(&self, service: Arc<LaunchProfileService>) {
        *self.launch_profile_service.write() = Some(service);
        info!("[terminal] LaunchProfileService injected");
    }

    pub fn set_workspace_service(&self, service: Arc<WorkspaceService>) {
        *self.workspace_service.write() = Some(service);
        info!("[terminal] WorkspaceService injected");
    }

    /// Resolve a local Pi RPC launch through the same profile/provider path as
    /// a terminal launch, without creating a PTY-backed terminal session.
    ///
    /// The caller starts the returned process through [`PiRpcService`]. An
    /// initial prompt is deliberately not included in the command line: the
    /// RPC owner must submit it after start via Pi's JSONL `prompt` command so
    /// the response id and subsequent events remain observable.
    pub fn build_pi_rpc_launch_spec(
        &self,
        request: &CreateSessionRequest,
    ) -> AppResult<PiRpcLaunchSpec> {
        let cli_tool = request.effective_cli_tool();
        if cli_tool != CliTool::Pi {
            return Err(AppError::coded(
                "PI_RPC_TOOL_REQUIRED",
                "Pi RPC launch requires cliTool 'pi'",
            ));
        }
        if request.ssh.is_some() || request.wsl.is_some() {
            return Err(AppError::coded(
                "PI_RPC_LOCAL_ONLY",
                "Pi RPC is currently available only for local launches",
            ));
        }

        validate_launch_cwd(
            &request.project_path,
            request.workspace_path.as_deref(),
            LaunchRuntime::Local,
        )?;

        let resolved_workspace = request.workspace_name.as_deref().and_then(|name| {
            self.workspace_service
                .read()
                .as_ref()
                .and_then(|service| service.get_workspace(name).ok())
        });
        let (resolved_profile, _) = self
            .launch_profile_service
            .read()
            .as_ref()
            .map(|service| {
                service.resolve_launch_profile_with_diagnostic(
                    request.launch_profile_id.as_deref(),
                    resolved_workspace.as_ref(),
                    None,
                    Some(cli_tool.as_id()),
                    Some("local"),
                )
            })
            .unwrap_or((None, None));
        let profile_provider_id = resolved_profile
            .as_ref()
            .and_then(|profile| profile.provider_id.as_deref());
        let profile_model_id = resolved_profile
            .as_ref()
            .and_then(|profile| profile.model_id.as_deref());
        let mut adapter_options = resolved_profile
            .as_ref()
            .map(|profile| profile.adapter_options.clone())
            .unwrap_or_default();
        if let Some(request_options) = request.adapter_options.as_ref() {
            for (key, value) in request_options {
                adapter_options.insert(key.clone(), value.clone());
            }
        }

        let pi_options =
            PiAdapterOptions::from_adapter_options(&adapter_options).map_err(|error| {
                AppError::coded(
                    "PI_OPTIONS_INVALID",
                    format!("Invalid Pi launch options: {error}"),
                )
            })?;
        if pi_options.transport != PiTransport::Rpc {
            return Err(AppError::coded(
                "PI_RPC_TRANSPORT_REQUIRED",
                "Pi RPC launch requires adapter option piTransport='rpc'",
            ));
        }

        let workspace_provider_id = resolved_workspace
            .as_ref()
            .and_then(|workspace| workspace.provider_id.as_deref());
        let default_provider_id = self
            .provider_service
            .get_default_provider_id(cli_tool.as_id());
        let providers = self.provider_service.list_providers();
        let provider_plan = resolve_provider_plan(
            ProviderResolutionInput {
                cli_tool,
                selection: request.provider_selection,
                requested_provider_id: request.provider_id.as_deref(),
                requested_model_id: request.model_id.as_deref(),
                profile_provider_id,
                profile_model_id,
                workspace_provider_id,
                default_provider_id: default_provider_id.as_deref(),
                adapter_options: Some(&adapter_options),
            },
            &providers,
            &self.cli_registry,
        )?;
        provider_plan.apply_model_adapter_defaults(&mut adapter_options);
        if let Some(model_id) = provider_plan.model_id.as_ref() {
            adapter_options.insert(
                "__ccpanesModelId".to_string(),
                serde_json::Value::String(model_id.clone()),
            );
        } else {
            adapter_options.remove("__ccpanesModelId");
        }
        validate_provider_runtime(&provider_plan, LaunchRuntime::Local, cli_tool)?;

        let adapter = self.cli_registry.get(cli_tool.as_id()).ok_or_else(|| {
            AppError::coded(
                "PI_RPC_ADAPTER_UNAVAILABLE",
                "Pi RPC adapter is not registered",
            )
        })?;
        if !adapter.capabilities().supports_rpc {
            return Err(AppError::coded(
                "PI_RPC_UNSUPPORTED",
                "The registered Pi adapter does not support RPC mode",
            ));
        }

        let mut env = self.settings_service.get_proxy_env_vars();
        if let Some(extra_env) = request.extra_env.as_ref() {
            for (key, value) in extra_env {
                if Self::is_valid_env_key(key) {
                    env.insert(key.clone(), value.clone());
                } else {
                    warn!("Skipping runner env var with invalid key: {}", key);
                }
            }
        }
        if provider_plan.mode == ProviderMode::Managed {
            Self::clear_managed_pi_environment(&mut env, CliTool::Pi);
        }

        // Pi's adapter owns the exact provider environment. The generic
        // Provider map uses different variables for some providers (notably
        // CODEX_API_KEY for OpenAI), so adding it here would retain unrelated
        // credentials alongside Pi's documented environment variables.
        env.insert(
            "CC_PANES_CLI_TOOL".to_string(),
            cli_tool.as_id().to_string(),
        );
        env.insert("CC_PANES_RUNTIME_KIND".to_string(), "local".to_string());
        env.insert(
            "CC_PANES_PROJECT_PATH".to_string(),
            request.project_path.clone(),
        );
        if let Some(launch_id) = request
            .launch_id
            .as_deref()
            .filter(|id| !id.trim().is_empty())
        {
            env.insert("CC_PANES_LAUNCH_ID".to_string(), launch_id.to_string());
        }
        if let Some(workspace_name) = resolved_workspace
            .as_ref()
            .map(|workspace| workspace.name.as_str())
            .or(request.workspace_name.as_deref())
            .filter(|name| !name.trim().is_empty())
        {
            env.insert(
                "CC_PANES_WORKSPACE_NAME".to_string(),
                workspace_name.to_string(),
            );
        }
        if let Some(workspace_path) = resolved_workspace
            .as_ref()
            .and_then(|workspace| workspace.path.as_deref())
            .filter(|path| !path.trim().is_empty())
        {
            env.insert(
                "CC_PANES_WORKSPACE_PATH".to_string(),
                workspace_path.to_string(),
            );
        }

        let resume_id = request.resume_id.as_deref().filter(|id| {
            let trimmed = id.trim();
            !trimmed.is_empty() && trimmed != "new"
        });
        let profile_skill_prompt =
            self.launch_profile_service
                .read()
                .as_ref()
                .and_then(|service| {
                    service.session_skill_prompt_for_profile(resolved_profile.as_ref())
                });
        let append_system_prompt =
            merge_session_prompts([request.append_system_prompt.clone(), profile_skill_prompt]);
        let rpc_launch_session_id = request
            .launch_id
            .clone()
            .filter(|id| !id.trim().is_empty())
            .unwrap_or_else(|| format!("pi-rpc-{}", Uuid::new_v4()));
        let context = CliAdapterContext {
            // Pi does not consume the CC-Panes session id as an argument. This
            // id only keeps adapter diagnostics distinct before PiRpcService
            // creates its own RPC-session id.
            session_id: rpc_launch_session_id.clone(),
            project_path: request.project_path.clone(),
            workspace_path: request.workspace_path.clone(),
            provider: provider_plan.provider.clone().map(to_cli_provider),
            executable_override: self
                .settings_service
                .get_settings()
                .cli_launchers
                .command_for(cli_tool.as_id())
                .map(str::to_string),
            adapter_options,
            resume_id: resume_id.map(str::to_string),
            issued_session_id: None,
            skip_mcp: true,
            // Pi's project trust is controlled by piProjectTrust, not the
            // generic terminal YOLO setting.
            yolo_mode: false,
            append_system_prompt,
            initial_prompt: None,
            orchestrator_port: None,
            orchestrator_token: None,
            launch_id: request.launch_id.clone(),
            data_dir: self.app_paths.data_dir().to_path_buf(),
            shared_mcp_urls: HashMap::new(),
            allowed_mcp_server_ids: Vec::new(),
            disable_unlisted_mcp_servers: true,
            skill_mount_paths: Vec::new(),
        };
        let mut result = adapter.build_command(&context).map_err(AppError::from)?;
        if provider_plan.mode == ProviderMode::Managed {
            if let Some(agent_root) = result
                .env_inject
                .get(cc_cli_adapters::PI_CODING_AGENT_DIR_ENV)
            {
                self.inject_managed_pi_skills(Path::new(agent_root));
            } else {
                warn!("managed Pi RPC launch did not provide an isolated agent root");
            }
        }
        if provider_plan.mode == ProviderMode::Managed {
            result.env_remove.extend(
                managed_provider_conflict_env_keys(cli_tool)
                    .iter()
                    .map(|key| (*key).to_string()),
            );
            result.env_remove.sort();
            result.env_remove.dedup();
        }
        // Adapter-injected values (the selected Pi Provider credentials) have
        // the final precedence, just like the PTY launch path.
        env.extend(result.env_inject);

        let cwd = request
            .workspace_path
            .as_deref()
            .unwrap_or(request.project_path.as_str())
            .to_string();
        Ok(PiRpcLaunchSpec {
            command: result.command,
            args: result.args,
            cwd,
            env,
            env_remove: result.env_remove,
            managed_state_cleanup: (provider_plan.mode == ProviderMode::Managed).then(|| {
                PiManagedStateCleanup::new(
                    self.app_paths.data_dir().to_path_buf(),
                    rpc_launch_session_id.clone(),
                )
            }),
        })
    }

    fn prepare_ssh_auth_runtime(
        &self,
        ssh: Option<&SshConnectionInfo>,
    ) -> Result<Option<Arc<Mutex<SshAuthRuntime>>>> {
        let Some(ssh) = ssh else {
            return Ok(None);
        };

        let Some(machine_id) = ssh.machine_id.as_deref() else {
            return Ok(None);
        };

        if ssh.auth_method != Some(crate::models::AuthMethod::Password) {
            return Ok(None);
        }

        match self
            .ssh_credential_service
            .load_connection_password(machine_id)
        {
            Ok(Some(saved_password)) => Ok(Some(Arc::new(Mutex::new(SshAuthRuntime {
                prompt_buffer: String::new(),
                saved_password,
                auto_response_sent: false,
            })))),
            Ok(None) => Ok(None),
            Err(error) => {
                warn!(
                    machine_id = %machine_id,
                    error = %error,
                    "Failed to load stored SSH password; falling back to manual prompt"
                );
                Ok(None)
            }
        }
    }

    /// 创建新的终端会话
    #[allow(clippy::too_many_arguments)]
    pub fn create_session(
        &self,
        launch_id: Option<&str>,
        project_path: &str,
        cols: u16,
        rows: u16,
        workspace_name: Option<&str>,
        provider_id: Option<&str>,
        model_id: Option<&str>,
        provider_selection: LaunchProviderSelection,
        launch_profile_id: Option<&str>,
        workspace_path: Option<&str>,
        workspace_snapshot_id: Option<&str>,
        cli_tool: CliTool,
        resume_id: Option<&str>,
        skip_mcp: bool,
        append_system_prompt: Option<&str>,
        initial_prompt: Option<&str>,
        yolo_mode: Option<bool>,
        request_adapter_options: Option<&HashMap<String, serde_json::Value>>,
        extra_env: Option<&HashMap<String, String>>,
        ssh: Option<&SshConnectionInfo>,
        wsl: Option<&WslLaunchInfo>,
    ) -> Result<String> {
        self.create_session_with_outcome(
            launch_id,
            project_path,
            cols,
            rows,
            workspace_name,
            provider_id,
            model_id,
            provider_selection,
            launch_profile_id,
            workspace_path,
            workspace_snapshot_id,
            cli_tool,
            resume_id,
            skip_mcp,
            append_system_prompt,
            initial_prompt,
            yolo_mode,
            request_adapter_options,
            extra_env,
            ssh,
            wsl,
        )
        .map(|outcome| outcome.session_id)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_session_with_outcome(
        &self,
        launch_id: Option<&str>,
        project_path: &str,
        cols: u16,
        rows: u16,
        workspace_name: Option<&str>,
        provider_id: Option<&str>,
        model_id: Option<&str>,
        provider_selection: LaunchProviderSelection,
        launch_profile_id: Option<&str>,
        workspace_path: Option<&str>,
        workspace_snapshot_id: Option<&str>,
        cli_tool: CliTool,
        resume_id: Option<&str>,
        skip_mcp: bool,
        append_system_prompt: Option<&str>,
        initial_prompt: Option<&str>,
        yolo_mode: Option<bool>,
        request_adapter_options: Option<&HashMap<String, serde_json::Value>>,
        extra_env: Option<&HashMap<String, String>>,
        ssh: Option<&SshConnectionInfo>,
        wsl: Option<&WslLaunchInfo>,
    ) -> Result<CreateSessionOutcome> {
        // 归一化前端遗留哨兵："new"/空串都视为「新会话」（避免 `--resume new`，
        // 并让 Claude 发号分支正确生效）
        let resume_id = resume_id.filter(|rid| {
            let trimmed = rid.trim();
            !trimmed.is_empty() && trimmed != "new"
        });
        let runtime = if ssh.is_some() {
            LaunchRuntime::Ssh
        } else if wsl.is_some() {
            LaunchRuntime::Wsl
        } else {
            LaunchRuntime::Local
        };
        let _launch_reservation = self.reserve_launch(launch_id)?;
        self.ensure_launch_active(launch_id, "launch.begin")?;
        validate_launch_cwd(project_path, workspace_path, runtime).map_err(anyhow::Error::new)?;
        let is_ssh = ssh.is_some();
        let resolved_workspace = workspace_name.and_then(|name| {
            self.workspace_service
                .read()
                .as_ref()
                .and_then(|svc| svc.get_workspace(name).ok())
        });
        let runtime_kind = if ssh.is_some() {
            "ssh"
        } else if wsl.is_some() {
            "wsl"
        } else {
            "local"
        };
        let launch_trace_started_at = Instant::now();
        log_launch_stage(
            launch_id,
            None,
            cli_tool,
            runtime_kind,
            launch_trace_started_at,
            "launch.begin",
            "started",
        );
        let (resolved_profile, profile_diagnostic) = self
            .launch_profile_service
            .read()
            .as_ref()
            .map(|svc| {
                svc.resolve_launch_profile_with_diagnostic(
                    launch_profile_id,
                    resolved_workspace.as_ref(),
                    None,
                    Some(cli_tool.as_id()),
                    Some(runtime_kind),
                )
            })
            .unwrap_or((None, None));
        log_launch_stage(
            launch_id,
            None,
            cli_tool,
            runtime_kind,
            launch_trace_started_at,
            "launch.profile.resolved",
            "ok",
        );
        let profile_provider_id = resolved_profile
            .as_ref()
            .and_then(|profile| profile.provider_id.as_deref());
        let profile_model_id = resolved_profile
            .as_ref()
            .and_then(|profile| profile.model_id.as_deref());
        // adapter_options 合并：profile 打底，request 覆盖同名键（per-launch 覆盖）
        let mut adapter_options = resolved_profile
            .as_ref()
            .map(|profile| profile.adapter_options.clone())
            .unwrap_or_default();
        if let Some(request_options) = request_adapter_options {
            for (key, value) in request_options {
                adapter_options.insert(key.clone(), value.clone());
            }
        }
        if cli_tool == CliTool::Pi
            && PiAdapterOptions::from_adapter_options(&adapter_options)
                .map_err(|error| anyhow!("Invalid Pi launch options: {error}"))?
                .transport
                == PiTransport::Rpc
        {
            return Err(anyhow::Error::new(AppError::coded(
                "PI_RPC_PTY_UNSUPPORTED",
                "Pi RPC transport cannot be created as a terminal PTY session; use the Pi RPC service",
            )));
        }
        let workspace_provider_id = resolved_workspace
            .as_ref()
            .and_then(|workspace| workspace.provider_id.as_deref());
        let default_provider_id = self
            .provider_service
            .get_default_provider_id(cli_tool.as_id());
        let providers = self.provider_service.list_providers();
        let provider_plan = resolve_provider_plan(
            ProviderResolutionInput {
                cli_tool,
                selection: provider_selection,
                requested_provider_id: provider_id,
                requested_model_id: model_id,
                profile_provider_id,
                profile_model_id,
                workspace_provider_id,
                default_provider_id: default_provider_id.as_deref(),
                adapter_options: Some(&adapter_options),
            },
            &providers,
            &self.cli_registry,
        )
        .map_err(anyhow::Error::new)?;
        provider_plan.apply_model_adapter_defaults(&mut adapter_options);
        if let Some(model_id) = provider_plan.model_id.as_ref() {
            adapter_options.insert(
                "__ccpanesModelId".to_string(),
                serde_json::Value::String(model_id.clone()),
            );
        } else {
            adapter_options.remove("__ccpanesModelId");
        }
        validate_provider_runtime(&provider_plan, runtime, cli_tool).map_err(anyhow::Error::new)?;
        info!(
            cli_tool = cli_tool.as_id(),
            runtime = runtime_kind,
            mode = ?provider_plan.mode,
            source = ?provider_plan.source,
            provider_id = provider_plan
                .provider
                .as_ref()
                .map(|provider| provider.id.as_str())
                .unwrap_or("<native>"),
            "resolved launch provider"
        );
        let mut env_vars = self.settings_service.get_proxy_env_vars();
        let provider_vars = provider_plan
            .provider
            .as_ref()
            .map(|provider| self.provider_service.get_env_vars_for_provider(provider))
            .unwrap_or_default();
        let provider = provider_plan.provider.clone().map(to_cli_provider);
        let provider_conflict_env_remove = if provider_plan.mode == ProviderMode::Managed {
            managed_provider_conflict_env_keys(cli_tool)
                .iter()
                .map(|key| (*key).to_string())
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        log_launch_stage(
            launch_id,
            None,
            cli_tool,
            runtime_kind,
            launch_trace_started_at,
            "launch.provider.resolved",
            "ok",
        );
        let effective_skip_mcp =
            LaunchProfileService::should_skip_mcp_for_profile(resolved_profile.as_ref(), skip_mcp);
        // 注意：daemon 模式下 create_session 跑在 daemon 进程里，而
        // `set_sidecar_resource_dir` 只有 app 侧调用 —— 此处恒为 None，ctl 路径
        // 实际由 `ctl_binary_candidates` 的 exe 同目录候选兜底（有测试钉着）。
        let sidecar_resource_dir = self.sidecar_resource_dir.read().clone();
        if !is_ssh && !effective_skip_mcp && matches!(cli_tool, CliTool::Claude | CliTool::Codex) {
            if let Some(binary) = super::ctl_sidecar::inject_mcp_proxy_options(
                &mut adapter_options,
                sidecar_resource_dir.as_deref(),
            )? {
                info!(
                    cli_tool = cli_tool.as_id(),
                    binary = %binary.display(),
                    "create_session: cc-panes-ctl MCP proxy enabled"
                );
            }
        }
        let shared_mcp_service = self.shared_mcp_service.read().clone();
        let shared_mcp_config = shared_mcp_service
            .as_ref()
            .map(|svc| svc.get_config())
            .unwrap_or_default();
        let effective_shared_mcp_urls = self.resolve_effective_shared_mcp_urls(
            shared_mcp_service.as_deref(),
            launch_profile_id,
            resolved_workspace.as_ref(),
            cli_tool,
            runtime_kind,
            effective_skip_mcp,
        );
        log_launch_stage(
            launch_id,
            None,
            cli_tool,
            runtime_kind,
            launch_trace_started_at,
            "launch.mcp.resolved",
            "ok",
        );
        let allowed_mcp_server_ids =
            allowed_mcp_server_ids_for_profile(resolved_profile.as_ref(), &shared_mcp_config);
        let disable_unlisted_mcp_servers = launch_profile_isolates_mcp(resolved_profile.as_ref());
        let selected_mcp_config_toml =
            selected_shared_mcp_config_toml_for_codex(&allowed_mcp_server_ids, &shared_mcp_config);
        let sync_project_hooks =
            LaunchProfileService::should_sync_project_hooks_for_profile(resolved_profile.as_ref());
        // per-launch YOLO 覆盖：Some = 请求显式指定，None = 跟随 profile 解析值
        let effective_yolo_mode = yolo_mode.unwrap_or_else(|| {
            resolved_profile
                .as_ref()
                .map(|profile| profile.yolo_mode)
                .unwrap_or(false)
        });
        // 方案 A：显式选中的启动配置因 CLI/运行环境不匹配被静默丢弃时，不再无声回落——
        // 记录 warn 并向前端广播提示，避免 YOLO 等 profile 级设置无声失效。
        if let Some(diagnostic) = profile_diagnostic.as_ref() {
            warn!(
                requested_profile = %diagnostic.requested_profile_name,
                cli = cli_tool.as_id(),
                runtime = runtime_kind,
                cli_mismatch = diagnostic.cli_mismatch,
                runtime_mismatch = diagnostic.runtime_mismatch,
                used_profile = diagnostic.used_profile_name.as_deref().unwrap_or("<none>"),
                "所选启动配置不适用于当前 CLI/运行环境，已回落到默认配置（YOLO 等 profile 级设置可能未生效）"
            );
            if let Some(emitter) = self.emitter.read().as_ref() {
                let _ = emitter.emit(
                    EV::TERMINAL_LAUNCH_WARNING,
                    serde_json::json!({
                        "kind": "profileMismatch",
                        "launchId": launch_id,
                        "projectPath": project_path,
                        "cliTool": cli_tool.as_id(),
                        "runtimeKind": runtime_kind,
                        "requestedProfileId": diagnostic.requested_profile_id,
                        "requestedProfileName": diagnostic.requested_profile_name,
                        "cliMismatch": diagnostic.cli_mismatch,
                        "runtimeMismatch": diagnostic.runtime_mismatch,
                        "usedProfileId": diagnostic.used_profile_id,
                        "usedProfileName": diagnostic.used_profile_name,
                        "yoloEffective": effective_yolo_mode,
                    }),
                );
            }
        }
        let profile_skill_prompt = self
            .launch_profile_service
            .read()
            .as_ref()
            .and_then(|svc| svc.session_skill_prompt_for_profile(resolved_profile.as_ref()));
        let portable_bundled_skill_prompt = self.portable_bundled_skill_prompt(
            cli_tool,
            resolved_profile.as_ref(),
            !effective_skip_mcp,
        );
        let launch_append_system_prompt = merge_session_prompts([
            append_system_prompt.map(str::to_string),
            portable_bundled_skill_prompt,
            profile_skill_prompt.clone(),
        ]);
        if let Some(extra_env) = extra_env {
            for (key, value) in extra_env {
                if Self::is_valid_env_key(key) {
                    env_vars.insert(key.clone(), value.clone());
                } else {
                    warn!("Skipping runner env var with invalid key: {}", key);
                }
            }
        }
        if matches!(cli_tool, CliTool::Pi | CliTool::Omp)
            && provider_plan.mode == ProviderMode::Managed
        {
            Self::clear_managed_pi_environment(&mut env_vars, cli_tool);
        }
        // Managed Provider is authoritative for this launch. The Pi family
        // rebuilds its provider environment in the adapter because its
        // documented variables differ from the generic Provider map (for
        // example OPENAI_API_KEY vs CODEX_API_KEY); injecting both would leave
        // unrelated credentials in the child process.
        if !matches!(cli_tool, CliTool::Pi | CliTool::Omp) {
            env_vars.extend(provider_vars.clone());
        }
        let emitter = self.emitter.read().clone().ok_or_else(|| {
            anyhow!("TerminalService not initialized: emitter not set (call set_emitter first)")
        })?;
        let notifier = self.notifier.read().clone().ok_or_else(|| {
            anyhow!("TerminalService not initialized: notifier not set (call set_notifier first)")
        })?;
        let settings_service = self.settings_service.clone();
        let session_id = Uuid::new_v4().to_string();
        let managed_pi_state_cleanup = (matches!(cli_tool, CliTool::Pi | CliTool::Omp)
            && provider_plan.mode == ProviderMode::Managed
            && ssh.is_none()
            && wsl.is_none())
        .then(|| {
            PiManagedStateCleanup::for_managed_dir(
                self.app_paths.data_dir().to_path_buf(),
                session_id.clone(),
                Self::pi_family_managed_state_dir_name(cli_tool)
                    .expect("pi-family gate checked above"),
            )
        });
        let mut pending_pi_managed_state_cleanup =
            PendingPiManagedStateCleanup::new(managed_pi_state_cleanup.clone());
        let mut managed_wsl_pi_state_cleanup: Option<WslManagedPiStateCleanup> = None;
        // 新会话由 CC-Panes 发号（如 claude/grok 的 --session-id），启动前即确定 resume id。
        // 是否支持发号由 adapter 能力声明决定；resume 场景复用原 id，无需发号；
        // 不支持发号的 CLI（如 codex）走各自的捕获通道。
        let issued_session_id =
            Self::should_issue_session_id(&self.cli_registry, cli_tool, resume_id)
                .then(|| Uuid::new_v4().to_string());

        // 注入终端环境变量（macOS Release .app 从 Finder 启动时不继承终端环境）
        env_vars
            .entry("TERM".to_string())
            .or_insert_with(|| "xterm-256color".to_string());
        env_vars
            .entry("COLORTERM".to_string())
            .or_insert_with(|| "truecolor".to_string());
        // GUI 应用不继承 shell locale（macOS 从 Finder/Dock 启动即如此），不补的话
        // 整条会话跑在 LC_CTYPE=C 下，多字节文本的字符数与显示宽度都会算错。
        // 已经是 UTF-8 则不动——判据与 WSL Codex 那条路径一致。
        crate::utils::ensure_utf8_locale(&mut env_vars);
        env_vars.insert("CC_PANES_PTY_SESSION_ID".to_string(), session_id.clone());
        if let Some(workspace_snapshot_id) = workspace_snapshot_id {
            env_vars.insert(
                "CC_PANES_WORKSPACE_SNAPSHOT_ID".to_string(),
                workspace_snapshot_id.to_string(),
            );
        }
        if let Some(launch_id) = launch_id {
            env_vars.insert("CC_PANES_LAUNCH_ID".to_string(), launch_id.to_string());
        }
        env_vars.insert(
            "CC_PANES_CLI_TOOL".to_string(),
            cli_tool.as_id().to_string(),
        );
        env_vars.insert(
            "CC_PANES_RUNTIME_KIND".to_string(),
            runtime_kind.to_string(),
        );
        if let Some(prompt) = profile_skill_prompt.as_ref() {
            env_vars.insert("CC_PANES_LAUNCH_PROFILE_SKILLS".to_string(), prompt.clone());
        }
        if let Some(wsl) = wsl {
            if let Some(distro) = wsl
                .distro
                .as_deref()
                .filter(|value| !value.trim().is_empty())
            {
                env_vars.insert("CC_PANES_WSL_DISTRO".to_string(), distro.to_string());
            }
        }

        // 让会话内的人与 AI 直接够得到 cc-panes-ctl（orchestrator 死时仍可经 daemon
        // 接管会话）。只写这一个绝对路径变量，**不碰 PATH**——原因见
        // ctl_sidecar::session_ctl_env_value 的文档注释。
        if let Some(ctl_path) =
            super::ctl_sidecar::session_ctl_env_value(sidecar_resource_dir.as_deref(), is_ssh)
        {
            env_vars.insert(
                super::ctl_sidecar::SESSION_CTL_ENV_KEY.to_string(),
                ctl_path,
            );
        }

        // 解析 Shell 配置
        let shell_id = self.settings_service.get_settings().terminal.shell.clone();

        env_vars.insert(
            "CC_PANES_PROJECT_PATH".to_string(),
            project_path.to_string(),
        );
        let canonical_workspace_name = resolved_workspace
            .as_ref()
            .map(|w| w.name.as_str())
            .or(workspace_name);
        if let Some(name) = canonical_workspace_name {
            if !name.trim().is_empty() {
                env_vars.insert("CC_PANES_WORKSPACE_NAME".to_string(), name.to_string());
            }
        }
        // workspace 根路径（用于 plan-as-memory 钩子的分级归档）
        if let Some(ws_path) = resolved_workspace
            .as_ref()
            .and_then(|w| w.path.as_deref())
            .filter(|p| !p.trim().is_empty())
        {
            env_vars.insert("CC_PANES_WORKSPACE_PATH".to_string(), ws_path.to_string());
        }

        let orchestrator_info_for_launch = if is_ssh {
            None
        } else {
            self.healthy_orchestrator_info()
        };

        // 注入 Orchestrator API 信息到所有 PTY 会话（仅本地模式）
        if let Some(info) = orchestrator_info_for_launch.as_ref() {
            env_vars.insert("CC_PANES_API_PORT".to_string(), info.port.to_string());
            env_vars.insert("CC_PANES_API_TOKEN".to_string(), info.token.clone());
            env_vars.insert(
                "CC_PANES_API_BASE_URL".to_string(),
                format!("http://127.0.0.1:{}", info.port),
            );
        }

        // WSL 透传：把 CC_PANES_* env 通过 WSLENV 暴露给 WSL 子进程
        // （Windows env 默认不进 WSL，必须列出 key；纯字符串用裸 key 即可，无需 /p。
        // 例外是 CC_PANES_CTL —— 它是**路径**，必须带 /p 才会被翻成 /mnt/... 形式）
        if wsl.is_some() {
            let mut wsl_keys: Vec<&str> = vec![
                "CC_PANES_CLI_TOOL",
                "CC_PANES_PROJECT_PATH",
                "CC_PANES_PTY_SESSION_ID",
                "CC_PANES_RUNTIME_KIND",
                "CC_PANES_WORKSPACE_NAME",
            ];
            if env_vars.contains_key("CC_PANES_WORKSPACE_PATH") {
                wsl_keys.push("CC_PANES_WORKSPACE_PATH");
            }
            if env_vars.contains_key("CC_PANES_API_TOKEN") {
                wsl_keys.extend([
                    "CC_PANES_API_BASE_URL",
                    "CC_PANES_API_PORT",
                    "CC_PANES_API_TOKEN",
                ]);
            }
            if env_vars.contains_key("CC_PANES_LAUNCH_ID") {
                wsl_keys.push("CC_PANES_LAUNCH_ID");
            }
            if env_vars.contains_key("CC_PANES_TASK_BINDING_ID") {
                wsl_keys.push("CC_PANES_TASK_BINDING_ID");
            }
            if env_vars.contains_key("CC_PANES_DISPATCH_TASK_ID") {
                wsl_keys.push("CC_PANES_DISPATCH_TASK_ID");
            }
            if env_vars.contains_key("CC_PANES_WORKSPACE_SNAPSHOT_ID") {
                wsl_keys.push("CC_PANES_WORKSPACE_SNAPSHOT_ID");
            }
            if env_vars.contains_key(super::ctl_sidecar::SESSION_CTL_ENV_KEY) {
                // /p = 路径翻译。WSL 内敲 `"$CC_PANES_CTL" status` 即可（走 interop
                // 跑 Windows 那份 exe，它的 127.0.0.1 正好是服务在听的那个）。
                wsl_keys.push("CC_PANES_CTL/p");
            }
            let injected = wsl_keys.join(":");
            let merged = match env_vars.get("WSLENV") {
                Some(existing) if !existing.is_empty() => {
                    format!("{}:{}", existing, injected)
                }
                _ => injected,
            };
            env_vars.insert("WSLENV".to_string(), merged);
        }

        // 三分支汇合后 cwd 一律是「项目/工作空间的 Windows 路径」，光看 cwd 分不出启动形态，
        // 后面 Windows Codex 的 PowerShell bootstrap 要靠这个标志把 WSL/SSH 排除掉。
        #[cfg(windows)]
        let is_local_launch = ssh.is_none() && wsl.is_none();

        // SSH 模式 vs 本地模式分支
        let (cwd, command, args, env_remove, ssh_remote_command) = if let Some(ssh_info) = ssh {
            // 新连接走应用内 SSH2 channel；旧配置缺少认证元数据时保留系统 ssh 回退。
            // 跳过 MCP 注入、Orchestrator 信息注入、--add-dir、--resume、--append-system-prompt
            let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
            let remote_command = Self::build_ssh_remote_command(
                ssh_info,
                cli_tool,
                &provider_vars,
                provider.as_ref(),
                effective_yolo_mode,
            );
            let embedded = self
                .ssh_connection_service
                .can_use_embedded_terminal(ssh_info);
            let (cmd, cmd_args) = if embedded {
                (
                    format!("ssh2://{}:{}", ssh_info.host, ssh_info.port),
                    Vec::new(),
                )
            } else {
                self.build_ssh_command(ssh_info, &remote_command)?
            };
            info!(
                session_id = %session_id,
                host = %ssh_info.host,
                remote_path = %ssh_info.remote_path,
                cli_tool = ?cli_tool,
                embedded,
                "create_session: SSH mode"
            );
            (
                home,
                cmd,
                cmd_args,
                vec![],
                embedded.then_some(remote_command),
            )
        } else if let Some(wsl_info) = wsl {
            let cwd = match workspace_path {
                Some(ws_path) => PathBuf::from(ws_path),
                None => PathBuf::from(project_path),
            };
            let cli_tool_id = cli_tool.as_id();
            let mut env_remove = WSL_PROXY_ENV_KEYS
                .iter()
                .map(|key| key.to_string())
                .collect::<Vec<_>>();
            if provider_plan.mode == ProviderMode::Managed {
                env_remove.extend(provider_conflict_env_remove.iter().cloned());
                env_remove.sort();
                env_remove.dedup();
            }
            strip_wsl_proxy_env_vars(&mut env_vars);
            let mut resolved_wsl = self.resolve_wsl_launch(wsl_info, &session_id)?;
            let wsl_mcp_proxy_enabled = !effective_skip_mcp
                && cc_cli_adapters::mcp_proxy_invocation_from_options(
                    &adapter_options,
                    self.app_paths.data_dir(),
                    launch_id,
                )
                .is_some();
            if wsl_mcp_proxy_enabled {
                wsl_mcp_proxy::configure_interop_command(
                    &mut adapter_options,
                    &resolved_wsl.wsl_path,
                    &resolved_wsl.distro,
                )?;
            }

            if cli_tool_id != "none" {
                let hooks_project_path = workspace_path.unwrap_or(project_path);
                if sync_project_hooks {
                    let hook_sync_result = if cli_tool == CliTool::Codex {
                        let hook_binary =
                            ProjectCliHooksService::get_hook_binary_path().and_then(|path| {
                                windows_path_to_wsl(&path)
                                    .map(PathBuf::from)
                                    .ok_or_else(|| {
                                        format!(
                                            "Failed to translate hook binary path to WSL path: {}",
                                            path.display()
                                        )
                                    })
                            });
                        match hook_binary {
                            Ok(wsl_hook_binary) => {
                                self.project_cli_hooks_service.sync_wsl_codex_project_hooks(
                                    hooks_project_path,
                                    project_path,
                                    &wsl_hook_binary,
                                )
                            }
                            Err(error) => Err(error),
                        }
                    } else {
                        let hook_binary =
                            ProjectCliHooksService::get_hook_binary_path().and_then(|path| {
                                windows_path_to_wsl(&path)
                                    .map(PathBuf::from)
                                    .ok_or_else(|| {
                                        format!(
                                            "Failed to translate hook binary path to WSL path: {}",
                                            path.display()
                                        )
                                    })
                            });
                        match hook_binary {
                            Ok(wsl_hook_binary) => self
                                .project_cli_hooks_service
                                .sync_project_cli_hooks_with_binary(
                                    hooks_project_path,
                                    cli_tool_id,
                                    &wsl_hook_binary,
                                ),
                            Err(error) => Err(error),
                        }
                    };

                    if let Err(error) = hook_sync_result {
                        warn!(
                            session_id = %session_id,
                            cli_tool = cli_tool_id,
                            project_path = hooks_project_path,
                            error = %error,
                            "create_session: failed to sync project hooks before WSL launch; continuing"
                        );
                    }
                } else {
                    info!(
                        session_id = %session_id,
                        cli_tool = cli_tool_id,
                        project_path = hooks_project_path,
                        "create_session: launch profile disabled WSL project skill hook sync"
                    );
                }
            }

            if matches!(cli_tool, CliTool::Codex | CliTool::Claude) && !effective_skip_mcp {
                if let Some(port_value) = env_vars.get("CC_PANES_API_PORT") {
                    match port_value.parse::<u16>() {
                        Ok(port) => match self.resolve_reachable_wsl_windows_host(
                            &resolved_wsl.wsl_path,
                            &resolved_wsl.distro,
                            port,
                        ) {
                            Ok(host) => {
                                resolved_wsl.windows_host = Some(host.clone());
                                if let Some(port_value) = env_vars.get("CC_PANES_API_PORT") {
                                    env_vars.insert(
                                        "CC_PANES_API_BASE_URL".to_string(),
                                        format!("http://{}:{}", host, port_value),
                                    );
                                }
                            }
                            Err(error) => {
                                warn!(
                                    distro = %resolved_wsl.distro,
                                    port = %port,
                                    error = %error,
                                    "create_session: failed to resolve reachable Windows host for WSL MCP injection; continuing without MCP"
                                );
                            }
                        },
                        Err(error) => {
                            warn!(
                                port_value = %port_value,
                                error = %error,
                                "create_session: invalid orchestrator port for WSL MCP injection; continuing without MCP"
                            );
                        }
                    }
                }
            }

            let (cmd, cmd_args) = match cli_tool {
                CliTool::None => self.build_wsl_shell_command(&resolved_wsl)?,
                CliTool::Codex => {
                    cc_cli_adapters::CodexAdapter::ensure_yolo_wsl_project_trust(
                        &resolved_wsl.wsl_path,
                        &resolved_wsl.distro,
                        &resolved_wsl.remote_path,
                        effective_yolo_mode,
                    );
                    // 收口 #7：清掉 WSL 内 ~/.codex/config.toml 残留的旧 CC-Panes ccpanes 段
                    // （本地迁移只动 Windows 侧，够不到 WSL Linux 侧这份）。best-effort。
                    if !effective_skip_mcp {
                        cc_cli_adapters::CodexAdapter::migrate_stale_wsl_ccpanes_mcp_config(
                            &resolved_wsl.wsl_path,
                            &resolved_wsl.distro,
                        );
                    }
                    if !wsl_mcp_proxy_enabled {
                        self.ensure_wsl_codex_mcp_registered(
                            &session_id,
                            &resolved_wsl,
                            &env_vars,
                            effective_skip_mcp,
                        )?;
                    }
                    self.build_wsl_command(
                        &resolved_wsl,
                        &session_id,
                        &env_vars,
                        &provider_vars,
                        provider.as_ref(),
                        resume_id,
                        launch_append_system_prompt.as_deref(),
                        initial_prompt,
                        effective_skip_mcp,
                        &effective_shared_mcp_urls,
                        &allowed_mcp_server_ids,
                        disable_unlisted_mcp_servers,
                        &selected_mcp_config_toml,
                        effective_yolo_mode,
                        &adapter_options,
                    )?
                }
                // 其余 CLI 走同一个 builder。**这里的三态（shell / codex 专线 /
                // 其余）只是「启动方式」这一个轴**——per-CLI 的差异分布在另外两张
                // 独立的表里，轴不同，不要合并：
                //   - `wsl_codex.rs` 的可执行名表：CLI id → WSL 内命令名（含
                //     glm→crush、cursor→cursor-agent 这类别名）
                //   - `wsl_codex.rs` 的参数分支：按 argv 方言划分，各 CLI 各不相同
                // 新增一个 CLI 通常要动的是那两张表，而不是这里。
                CliTool::Claude
                | CliTool::Gemini
                | CliTool::Opencode
                | CliTool::Cursor
                | CliTool::Grok
                | CliTool::Pi
                | CliTool::Omp
                | CliTool::Kimi
                | CliTool::Glm => self.build_wsl_supported_cli_command(
                    &resolved_wsl,
                    cli_tool,
                    &session_id,
                    &mut env_vars,
                    &provider_vars,
                    provider.as_ref(),
                    resume_id,
                    issued_session_id.as_deref(),
                    launch_append_system_prompt.as_deref(),
                    initial_prompt,
                    effective_skip_mcp,
                    effective_yolo_mode,
                    &adapter_options,
                )?,
            };

            if matches!(cli_tool, CliTool::Pi | CliTool::Omp)
                && provider_plan.mode == ProviderMode::Managed
            {
                managed_wsl_pi_state_cleanup = Some(WslManagedPiStateCleanup::new(
                    &resolved_wsl,
                    &session_id,
                    Self::pi_family_managed_state_dir_name(cli_tool)
                        .expect("pi-family gate checked above"),
                ));
            }

            info!(
                session_id = %session_id,
                distro = %resolved_wsl.distro,
                remote_path = %resolved_wsl.remote_path,
                cli_tool = ?cli_tool,
                "create_session: WSL mode"
            );

            (cwd, cmd, cmd_args, env_remove, None)
        } else {
            // 本地模式：原有逻辑
            let cwd = match workspace_path {
                Some(ws_path) => PathBuf::from(ws_path),
                None => PathBuf::from(project_path),
            };

            let cli_tool_id = cli_tool.as_id();

            // 命令：根据 cli_tool 分发（通过 Registry 适配器层）
            let (cmd, cmd_args, cmd_env_remove) = if cli_tool_id == "none" {
                let (c, shell_args) = resolve_shell(shell_id.as_deref());
                // 纯 shell 标签页注入 OSC 133/7 集成脚本（失败时透传）
                let (c, shell_args) = shell_integration::apply(
                    self.app_paths.data_dir(),
                    c,
                    shell_args,
                    &mut env_vars,
                );
                (c, shell_args, vec![])
            } else {
                let adapter = self
                    .cli_registry
                    .get(cli_tool_id)
                    .ok_or_else(|| anyhow!("Unknown CLI tool: {}", cli_tool_id))?;

                let hooks_project_path = workspace_path.unwrap_or(project_path);
                log_launch_stage(
                    launch_id,
                    Some(&session_id),
                    cli_tool,
                    runtime_kind,
                    launch_trace_started_at,
                    "launch.project_hooks.begin",
                    "started",
                );
                if sync_project_hooks {
                    if let Err(error) = self
                        .project_cli_hooks_service
                        .sync_project_cli_hooks(hooks_project_path, cli_tool_id)
                    {
                        warn!(
                            session_id = %session_id,
                            cli_tool = cli_tool_id,
                            project_path = hooks_project_path,
                            error = %error,
                            "create_session: failed to sync project hooks before launch; continuing"
                        );
                    }
                } else {
                    info!(
                        session_id = %session_id,
                        cli_tool = cli_tool_id,
                        project_path = hooks_project_path,
                        "create_session: launch profile disabled project skill hook sync"
                    );
                }
                log_launch_stage(
                    launch_id,
                    Some(&session_id),
                    cli_tool,
                    runtime_kind,
                    launch_trace_started_at,
                    "launch.project_hooks.end",
                    "ok",
                );

                // 自动注入 Spec prompt（仅 CLI 工具模式，且无显式 prompt/运行配置 Skill 时）
                let spec_prompt = if launch_append_system_prompt.is_none() {
                    self.generate_spec_prompt(project_path)
                } else {
                    None
                };
                let effective_prompt =
                    merge_session_prompts([launch_append_system_prompt.clone(), spec_prompt]);
                let mut local_adapter_options = adapter_options.clone();
                if cli_tool == CliTool::Claude && provider_plan.mode == ProviderMode::Managed {
                    local_adapter_options.insert(
                        cc_cli_adapters::MANAGED_PROVIDER_ENV_OPTION.to_string(),
                        serde_json::to_value(&provider_vars)?,
                    );
                }

                let ctx = CliAdapterContext {
                    session_id: session_id.clone(),
                    project_path: project_path.to_string(),
                    workspace_path: workspace_path.map(|s| s.to_string()),
                    provider: provider.clone(),
                    executable_override: self
                        .settings_service
                        .get_settings()
                        .cli_launchers
                        .command_for(cli_tool_id)
                        .map(str::to_string),
                    adapter_options: local_adapter_options,
                    resume_id: resume_id.map(|s| s.to_string()),
                    issued_session_id: issued_session_id.clone(),
                    skip_mcp: effective_skip_mcp,
                    yolo_mode: effective_yolo_mode,
                    append_system_prompt: effective_prompt,
                    initial_prompt: initial_prompt.map(|s| s.to_string()),
                    orchestrator_port: orchestrator_info_for_launch.as_ref().map(|i| i.port),
                    orchestrator_token: orchestrator_info_for_launch
                        .as_ref()
                        .map(|i| i.token.clone()),
                    launch_id: launch_id.map(|s| s.to_string()),
                    data_dir: self.app_paths.data_dir().to_path_buf(),
                    shared_mcp_urls: effective_shared_mcp_urls,
                    allowed_mcp_server_ids,
                    disable_unlisted_mcp_servers,
                    skill_mount_paths: skill_mount_paths_for_profile(
                        resolved_profile.as_ref(),
                        &self.app_paths.builtin_skills_dir(),
                    ),
                };

                log_launch_stage(
                    launch_id,
                    Some(&session_id),
                    cli_tool,
                    runtime_kind,
                    launch_trace_started_at,
                    "launch.config.begin",
                    "started",
                );
                let mut result = adapter.build_command(&ctx)?;
                log_launch_stage(
                    launch_id,
                    Some(&session_id),
                    cli_tool,
                    runtime_kind,
                    launch_trace_started_at,
                    "launch.config.end",
                    "ok",
                );
                if matches!(cli_tool, CliTool::Pi | CliTool::Omp)
                    && provider_plan.mode == ProviderMode::Managed
                {
                    if let Some(agent_root) = result
                        .env_inject
                        .get(cc_cli_adapters::PI_CODING_AGENT_DIR_ENV)
                    {
                        self.inject_managed_pi_skills(Path::new(agent_root));
                    } else {
                        warn!(session_id = %session_id, "managed Pi-family launch did not provide an isolated agent root");
                    }
                }
                log_launch_stage(
                    launch_id,
                    Some(&session_id),
                    cli_tool,
                    runtime_kind,
                    launch_trace_started_at,
                    "launch.executable.resolved",
                    "ok",
                );
                if provider_plan.mode == ProviderMode::Managed {
                    result
                        .env_remove
                        .extend(provider_conflict_env_remove.iter().cloned());
                    result.env_remove.sort();
                    result.env_remove.dedup();
                }
                env_vars.extend(result.env_inject);
                (result.command, result.args, result.env_remove)
            };
            (cwd, cmd, cmd_args, cmd_env_remove, None)
        };
        let launch_claude = cli_tool != CliTool::None;
        let ssh_auth_runtime = if ssh_remote_command.is_some() {
            None
        } else {
            self.prepare_ssh_auth_runtime(ssh)?
        };

        // 创建 PTY
        debug!(
            session_id = %session_id,
            command = %command,
            cwd = %cwd.display(),
            launch_claude,
            "create_session: spawning PTY"
        );
        let command_for_log = command.clone();
        let cwd_for_log = cwd.display().to_string();
        let launch_started_at = std::time::SystemTime::now();
        let rollout_cwds = if let Some(wsl) = wsl {
            let mut paths = Vec::new();
            if let Some(workspace_remote_path) = wsl
                .workspace_remote_path
                .as_deref()
                .filter(|path| !path.trim().is_empty())
            {
                paths.push(workspace_remote_path.to_string());
            }
            if !wsl.remote_path.trim().is_empty()
                && !paths.iter().any(|path| path == &wsl.remote_path)
            {
                paths.push(wsl.remote_path.clone());
            }
            paths
        } else if ssh.is_none() {
            vec![workspace_path.unwrap_or(project_path).to_string()]
        } else {
            Vec::new()
        };

        // resume 启动诊断上下文：会话短时间内退出时输出取证 WARN
        // （绑定的 resume id 失效会表现为 CLI 启动即报错退出）。
        // 命令行经脱敏（token 掩码 + prompt 截断）后才允许进日志。
        let resume_diag = resume_id.map(|rid| {
            let redacted = cc_cli_adapters::redact_args_for_log(&args).join(" ");
            let mut command_line = format!("{} {}", command, redacted);
            if command_line.chars().count() > 500 {
                command_line = command_line.chars().take(500).collect();
            }
            (rid.to_string(), cli_tool.as_id().to_string(), command_line)
        });

        #[cfg(windows)]
        let (pty_command, pty_args) = if windows_codex::should_bootstrap(
            is_local_launch,
            cli_tool,
            &cwd,
        ) {
            info!(
                session_id = %session_id,
                cwd = %cwd.display(),
                "create_session: using Windows PowerShell bootstrap for Codex in a non-ASCII cwd"
            );
            windows_codex::wrap_with_powershell(command, args, &mut env_vars)?
        } else {
            (command, args)
        };

        #[cfg(not(windows))]
        let (pty_command, pty_args) = (command, args);

        // 资源策略随会话启动一次性下发（docs/71）：让窗格里的 cargo/rg 抢不过 UI。
        let resource_policy = self
            .settings_service
            .get_settings()
            .terminal
            .resource_policy();

        let config = PtyConfig {
            cols,
            rows,
            cwd,
            command: pty_command,
            args: pty_args,
            env: env_vars,
            env_remove,
            resource_policy,
        };

        log_launch_stage(
            launch_id,
            Some(&session_id),
            cli_tool,
            runtime_kind,
            launch_trace_started_at,
            "launch.command.final",
            "ok",
        );
        self.ensure_launch_active(launch_id, "launch.pty.begin")?;
        log_launch_stage(
            launch_id,
            Some(&session_id),
            cli_tool,
            runtime_kind,
            launch_trace_started_at,
            "launch.pty.begin",
            "started",
        );
        // SSH 会话不参与生产者暂停：同主机多终端共享一个 ssh2 Session，停读一个
        // channel 会阻塞共享传输拖垮其他终端；且 keepalive 只在 read() 的 WouldBlock
        // 分支里发（15s），park 超时即掉线。改由有界通道整段丢弃 + desync 兜底。
        let is_ssh_session = ssh.is_some() && ssh_remote_command.is_some();
        let spawn_attempt = match (ssh, ssh_remote_command.as_deref()) {
            (Some(connection), Some(remote_command)) => spawn_ssh_terminal(
                &self.ssh_connection_service,
                SshTerminalConfig {
                    connection,
                    remote_command,
                    cols,
                    rows,
                },
            ),
            _ => spawn_pty(config),
        };
        let spawn_result = match spawn_attempt {
            Ok(result) => {
                info!(
                    session_id = %session_id,
                    command = %command_for_log,
                    launch_claude,
                    "create_session: terminal spawned successfully"
                );
                log_launch_stage(
                    launch_id,
                    Some(&session_id),
                    cli_tool,
                    runtime_kind,
                    launch_trace_started_at,
                    "launch.pty.spawned",
                    "ok",
                );
                result
            }
            Err(e) => {
                log_launch_stage(
                    launch_id,
                    Some(&session_id),
                    cli_tool,
                    runtime_kind,
                    launch_trace_started_at,
                    "launch.failed",
                    "pty.spawn",
                );
                error!(
                    session_id = %session_id,
                    command = %command_for_log,
                    cwd = %cwd_for_log,
                    err = %e,
                    "create_session: PTY spawn FAILED"
                );
                wsl_codex::cleanup_session_mcp_configs(self.app_paths.data_dir(), &session_id);
                return Err(e);
            }
        };
        let mut pending_wsl_pi_state_cleanup =
            PendingWslManagedPiStateCleanup::new(managed_wsl_pi_state_cleanup.clone());
        if let Err(error) = self.ensure_launch_active(launch_id, "launch.pty.spawned") {
            let _ = spawn_result.process.kill();
            wsl_codex::cleanup_session_mcp_configs(self.app_paths.data_dir(), &session_id);
            return Err(error);
        }
        // Claude 发号成功：广播确定性 resume id（后端监听写 launch_history 并转发前端）
        if let Some(ref issued) = issued_session_id {
            let _ = emitter.emit(
                EV::TERMINAL_RESUME_ID_DETECTED,
                serde_json::json!({
                    "sessionId": session_id,
                    "resumeSessionId": issued,
                    "source": "issued",
                    "cliTool": cli_tool.as_id(),
                    "runtimeKind": runtime_kind,
                    "launchId": launch_id,
                    "projectPath": project_path,
                    "workspacePath": workspace_path,
                    "wslDistro": wsl.and_then(|w| w.distro.clone()),
                }),
            );
        }

        let mut reader = spawn_result.reader;
        let writer = spawn_result.writer;
        let process = spawn_result.process;
        let writer_tx = spawn_terminal_writer(session_id.clone(), writer);
        let read_writer_tx = writer_tx.clone();

        // 状态追踪
        let status = Arc::new(Mutex::new(SessionStatus::Active));
        let exit_code = Arc::new(Mutex::new(None));
        let last_output_at = Arc::new(Mutex::new(Instant::now()));
        let cancelled = Arc::new(AtomicBool::new(false));
        let output_buffer = Arc::new(Mutex::new(OutputBuffer::new(
            LIVE_OUTPUT_MAX_LINES,
            LIVE_OUTPUT_MAX_BYTES,
        )));
        // replay 上限跟随用户的 scrollback 设置：把 scrollback 调到 50k 行的用户
        // 不该在 attach/desync 重建时被 8MB 的硬编码窗口白白截史。
        let replay_buffer = Arc::new(Mutex::new(ReplayBuffer::new(live_replay_max_bytes(
            self.settings_service.get_settings().terminal.scrollback,
        ))));
        let paste_ready = Arc::new(AtomicBool::new(false));
        let output_flow = Arc::new(if is_ssh_session {
            OutputFlowGate::disabled()
        } else {
            OutputFlowGate::new()
        });

        // sanitize 可开关兜底（默认关闭 — dwFlags=0 应该解决了根本问题）
        #[cfg(windows)]
        let disable_sanitize = self
            .settings_service
            .get_settings()
            .terminal
            .disable_conpty_sanitize
            .unwrap_or(true);

        // 保存 PID 用于 reader 线程状态推送
        let session_pid = process.pid();
        // 为等待线程 clone 一份 process 引用
        let process_for_wait = Arc::clone(&process);
        let wait_pi_managed_state_cleanup = managed_pi_state_cleanup.clone();
        let wait_wsl_pi_state_cleanup = managed_wsl_pi_state_cleanup.clone();

        // 保存会话
        {
            // Cancellation and registration use one lock order so a timeout racing this block
            // either consumes the marker here or observes and kills the inserted session.
            let mut cancelled_launches = self
                .cancelled_launches
                .lock()
                .map_err(|_| anyhow!("cancelled launches lock poisoned"))?;
            if launch_id.is_some_and(|id| cancelled_launches.remove(id).is_some()) {
                drop(cancelled_launches);
                let _ = process.kill();
                return Err(anyhow::Error::new(launch_cancelled_error(
                    launch_id,
                    "launch.session.register",
                )));
            }
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| anyhow!("sessions lock poisoned"))?;
            sessions.insert(
                session_id.clone(),
                TerminalSession {
                    launch_id: launch_id.map(str::to_string),
                    project_path: project_path.to_string(),
                    runtime_kind: runtime_kind.to_string(),
                    cli_tool,
                    process,
                    writer_tx,
                    status: status.clone(),
                    exit_code: exit_code.clone(),
                    last_output_at: last_output_at.clone(),
                    cancelled: cancelled.clone(),
                    output_buffer: output_buffer.clone(),
                    replay_buffer: replay_buffer.clone(),
                    paste_ready: paste_ready.clone(),
                    output_flow: output_flow.clone(),
                    managed_pi_state_cleanup: managed_pi_state_cleanup.clone(),
                    managed_wsl_pi_state_cleanup: managed_wsl_pi_state_cleanup.clone(),
                },
            );
            pending_pi_managed_state_cleanup.disarm();
            pending_wsl_pi_state_cleanup.disarm();
        }
        log_launch_stage(
            launch_id,
            Some(&session_id),
            cli_tool,
            runtime_kind,
            launch_trace_started_at,
            "launch.session.registered",
            "ok",
        );

        // 启动输出批量合并线程（减少 IPC 事件频率，防止 WKWebView 主线程死锁）
        // 策略：累积数据，满足任一条件时刷出：≥16KB 或 ≥16ms 超时。
        // 每个 chunk 附带 ReplayBuffer 记账的 end seq（同一字节流同一计数，M3b-2）；
        // 合批时取批内最后一个 chunk 的 end seq，emit 是整数个 read-chunk 拼接，
        // 前端见到的任何 endSeq 必落 chunk 边界。
        // 有界兜底（B-1）：生产者暂停是主机制，正常情况下根本触不到这个上限；
        // 它只在 pause 被关掉、对端无回执能力、或洪流快过闸门反应时兜底。容量与
        // WS 层对齐（ws_emitter.rs SESSION_CHANNEL_CAPACITY = 256）。
        //
        // **发送端必须 try_send 而非阻塞 send**：reader 线程一旦阻塞在 send() 里就
        // 看不到 cancelled（terminal_service.rs 循环顶部才检查），kill 会话会挂起。
        let (batch_tx, batch_rx) =
            std::sync::mpsc::sync_channel::<(String, Option<u64>)>(OUTPUT_BATCH_CHANNEL_CAPACITY);
        let batch_emitter = emitter.clone();
        let batch_sid = session_id.clone();
        let batch_flow = output_flow.clone();
        thread::spawn(move || {
            const BATCH_SIZE_THRESHOLD: usize = 16384; // 16KB
            const BATCH_TIMEOUT: Duration = Duration::from_millis(16); // ~60fps

            // 只有**真正发出去**的批才计 in-flight（B-5）。emit 返回 Err 时字节根本
            // 没到前端（例如 Windows webview 恢复期 emits 被挂起），照样记账就是
            // 凭空造出一笔永远等不到 ACK 的债，Stage 3 的闸门会据此把生产者永久暂停。
            let note_emitted = |flow: &OutputFlowGate, emitted: bool, end_seq: Option<u64>| {
                if emitted {
                    flow.note_sent(end_seq);
                }
            };

            let mut batch = String::with_capacity(BATCH_SIZE_THRESHOLD);
            let mut batch_end_seq: Option<u64> = None;
            loop {
                match batch_rx.recv_timeout(BATCH_TIMEOUT) {
                    Ok((data, end_seq)) => {
                        batch.push_str(&data);
                        batch_end_seq = end_seq;
                        // 排空通道中已有的数据
                        while let Ok((more, more_seq)) = batch_rx.try_recv() {
                            batch.push_str(&more);
                            batch_end_seq = more_seq;
                            if batch.len() >= BATCH_SIZE_THRESHOLD {
                                break;
                            }
                        }
                        // 达到大小阈值则立即刷出；击键回显也走这条快路，不必等满
                        // 16ms 窗口——回显延迟是用户直接可感知的（Orca
                        // src/main/ipc/pty.ts:2681-2682 同款判据）。
                        if batch.len() >= BATCH_SIZE_THRESHOLD
                            || batch_flow.is_interactive_echo(batch.len())
                        {
                            let end_seq = batch_end_seq.take();
                            let emitted =
                                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                    batch_emitter
                                        .emit(
                                            EV::TERMINAL_OUTPUT,
                                            serde_json::to_value(&TerminalOutput {
                                                session_id: batch_sid.clone(),
                                                data: std::mem::take(&mut batch),
                                                end_seq,
                                            })
                                            .unwrap_or_default(),
                                        )
                                        .is_ok()
                                }))
                                .unwrap_or(false);
                            note_emitted(&batch_flow, emitted, end_seq);
                            batch = String::with_capacity(BATCH_SIZE_THRESHOLD);
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        // 超时：刷出累积的数据（保证低吞吐场景下数据不滞留）
                        if !batch.is_empty() {
                            let end_seq = batch_end_seq.take();
                            let emitted =
                                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                    batch_emitter
                                        .emit(
                                            EV::TERMINAL_OUTPUT,
                                            serde_json::to_value(&TerminalOutput {
                                                session_id: batch_sid.clone(),
                                                data: std::mem::take(&mut batch),
                                                end_seq,
                                            })
                                            .unwrap_or_default(),
                                        )
                                        .is_ok()
                                }))
                                .unwrap_or(false);
                            note_emitted(&batch_flow, emitted, end_seq);
                            batch = String::with_capacity(BATCH_SIZE_THRESHOLD);
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        // 读取线程退出，刷出残留数据
                        if !batch.is_empty() {
                            let end_seq = batch_end_seq.take();
                            let emitted =
                                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                    batch_emitter
                                        .emit(
                                            EV::TERMINAL_OUTPUT,
                                            serde_json::to_value(&TerminalOutput {
                                                session_id: batch_sid.clone(),
                                                data: batch,
                                                end_seq,
                                            })
                                            .unwrap_or_default(),
                                        )
                                        .is_ok()
                                }))
                                .unwrap_or(false);
                            note_emitted(&batch_flow, emitted, end_seq);
                        }
                        break;
                    }
                }
            }
        });

        // Codex 会话：从 PTY 输出的 OSC 标题序列捕获确定性 thread-id
        // （配合 build_command 注入的 tui.terminal_title=["...","thread-id"]）
        let mut osc_capture = (cli_tool == CliTool::Codex).then(|| {
            osc_resume_capture::OscResumeCapture::new(
                osc_resume_capture::OscCaptureContext {
                    session_id: session_id.clone(),
                    runtime_kind: runtime_kind.to_string(),
                    launch_id: launch_id.map(str::to_string),
                    project_path: project_path.to_string(),
                    workspace_path: workspace_path.map(str::to_string),
                    wsl_distro: wsl.and_then(|w| w.distro.clone()),
                    rollout_cwds,
                    launch_started_at,
                    rollout_fallback: resume_id.is_none() && ssh.is_none(),
                },
                emitter.clone(),
            )
        });

        // Cursor：无 OSC/issued id，后台扫 ~/.cursor/chats meta.json 落 resume id。
        // resume 路径已有 id 时不扫（避免把同 cwd 新 chat 绑到旧会话）。
        let _cursor_chat_capture =
            (cli_tool == CliTool::Cursor && resume_id.is_none() && ssh.is_none()).then(|| {
                cursor_chat_capture::CursorChatCapture::start(
                    cursor_chat_capture::CursorChatCaptureContext {
                        session_id: session_id.clone(),
                        runtime_kind: runtime_kind.to_string(),
                        launch_id: launch_id.map(str::to_string),
                        project_path: project_path.to_string(),
                        workspace_path: workspace_path.map(str::to_string),
                        wsl_distro: wsl.and_then(|w| w.distro.clone()),
                        launch_started_at,
                    },
                    emitter.clone(),
                )
            });

        // 启动读取线程（含状态检测 + UTF-8 安全）
        let sid = session_id.clone();
        let read_emitter = emitter.clone();
        let read_status = status.clone();
        let read_last_output = last_output_at.clone();
        let read_cancelled = cancelled.clone();
        let read_notifier = notifier.clone();
        let _settings_svc = settings_service.clone();
        let read_output_buffer = output_buffer.clone();
        let read_replay_buffer = replay_buffer.clone();
        let read_paste_ready = paste_ready.clone();
        let read_output_flow = output_flow.clone();
        // 每会话只警告一次：队列满往往是连续的，逐 chunk 打日志会把日志刷爆。
        let read_desync_warned = Arc::new(AtomicBool::new(false));
        let reader_pid = session_pid;
        let read_ssh_auth_runtime = ssh_auth_runtime.clone();
        // 阶段 2.8：把状态机引用 clone 进 read 线程，用于"ANSI 推断降级"判定
        let read_state_machine = self
            .state_machine
            .lock()
            .ok()
            .and_then(|g| g.as_ref().cloned());
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let prev_status = Mutex::new(SessionStatus::Active);
            let mut utf8_carry: Vec<u8> = Vec::new();
            let mut first_output = true;
            let mut last_emitted_status = SessionStatus::Active;
            let mut last_status_emit_time = Instant::now();
            // busy-loop 检测：每秒 read 次数超过阈值则警告
            let mut read_count: u64 = 0;
            let mut read_window_start = Instant::now();
            #[cfg(windows)]
            let mut sanitize_state = WindowsOutputSanitizeState::default();
            let mut osc_detector = osc_state_detect::OscStateDetector::new();
            let mut csi_mode_detector = csi_mode_detect::CsiModeDetector::new();
            loop {
                if read_cancelled.load(Ordering::Relaxed) {
                    break;
                }
                // 生产者暂停（B-1）：水位超标时停在这里不调 read()，PTY 内核缓冲
                // 填满后刷屏的子进程阻塞在自己的 write() 上——被自己的输出限速。
                // 内部保证不会永久卡：ACK 排空、失效超时、cancelled 三条都能放行。
                // SSH 会话拿到的是 disabled gate，这里直接穿过（见 OutputFlowGate 模块注释）。
                if read_output_flow.park_if_paused(&read_cancelled) == ParkOutcome::Stalled {
                    // 连续多轮失效超时 = 回执链路已死（前端崩了 / 消息丢了 /
                    // WebView 卡死）。只靠失效超时会退化成"每 5 秒放一小口"的
                    // 龟速终端；发 desync 让前端丢弃画面从快照重建，链路顺带复位。
                    warn!(
                        "[pty-read] session={} delivery stalled ({}s without acks); \
                         signalling desync so the pane rebuilds from snapshot",
                        sid,
                        PRODUCER_PAUSE_FAILSAFE.as_secs() * FAILSAFE_TIMEOUTS_BEFORE_DESYNC
                    );
                    let _ = read_emitter
                        .emit(EV::TERMINAL_DESYNC, serde_json::json!({ "sessionId": sid }));
                }
                if read_cancelled.load(Ordering::Relaxed) {
                    break;
                }
                match reader.read(&mut buf) {
                    Ok(0) => {
                        warn!(
                            "[pty-read] session={} read returned Ok(0), breaking loop \
                             (read_count={} in {}ms)",
                            sid,
                            read_count,
                            read_window_start.elapsed().as_millis()
                        );
                        break;
                    }
                    Ok(n) => {
                        // busy-loop 检测
                        read_count += 1;
                        if read_count.is_multiple_of(500) {
                            let elapsed = read_window_start.elapsed();
                            if elapsed.as_secs() < 2 {
                                warn!(
                                    "[pty-read] session={} potential busy-loop: {} reads in {}ms \
                                     (last chunk={} bytes)",
                                    sid,
                                    read_count,
                                    elapsed.as_millis(),
                                    n
                                );
                            }
                            // 重置窗口
                            read_count = 0;
                            read_window_start = Instant::now();
                        }

                        // 首次输出诊断日志（含 hex），用于排查前端事件注册竞态
                        if first_output {
                            let hex: String = buf[..n]
                                .iter()
                                .map(|b| format!("{:02x}", b))
                                .collect::<Vec<_>>()
                                .join(" ");
                            info!(
                                "[pty-read] session={} first output: {} bytes, hex=[{}]",
                                sid, n, hex
                            );
                            first_output = false;
                        }
                        #[cfg(windows)]
                        let output_bytes = sanitize_windows_output(
                            &buf[..n],
                            &mut sanitize_state,
                            disable_sanitize,
                        );
                        #[cfg(not(windows))]
                        let output_bytes = buf[..n].to_vec();

                        if output_bytes.is_empty() {
                            continue;
                        }

                        // UTF-8 安全处理
                        let data = match utf8_safe_process(&output_bytes, &mut utf8_carry) {
                            Some(s) => s,
                            None => continue,
                        };

                        // 再次检查取消标志，避免 emit 已死 session 的事件
                        if read_cancelled.load(Ordering::Relaxed) {
                            break;
                        }

                        // Codex OSC 标题捕获（done 后仅一次原子读，开销可忽略）
                        if let Some(capture) = osc_capture.as_mut() {
                            capture.scan(&data);
                        }

                        csi_mode_detector.process(data.as_bytes(), |signal| match signal {
                            csi_mode_detect::CsiModeSignal::PasteReady(ready) => {
                                read_paste_ready.store(ready, Ordering::Release);
                            }
                            csi_mode_detect::CsiModeSignal::AlternateBufferExited => {
                                read_paste_ready.store(false, Ordering::Release);
                            }
                        });

                        // OSC 状态信号（in-band 通道）：hook 的 terminalSequence 标记、
                        // shell 集成的 133 命令边界、OSC 9 通知。信号汇入状态机，
                        // 与 HTTP hook 通道在 on_event_with_channel 内跨通道去重。
                        if let Some(sm) = read_state_machine.as_ref() {
                            osc_detector.process(data.as_bytes(), |signal| {
                                apply_osc_signal(sm, &sid, signal);
                            });
                        }

                        // 更新状态
                        {
                            let mut ts = read_last_output.lock().unwrap_or_else(|e| {
                                warn!("last_output_at lock poisoned, using fallback value");
                                e.into_inner()
                            });
                            *ts = Instant::now();
                        }

                        // 推断状态
                        let inferred = infer_status(&data);
                        // 阶段 2.8：hook 在 30s 内活跃时，ANSI 推断仅作"无变更"兜底，
                        // 不覆盖 SessionStateMachine 维护的细分 status（Thinking / ToolRunning /
                        // Compacting / WaitingInput / Error / Idle）。
                        let hook_active = read_state_machine
                            .as_ref()
                            .and_then(|sm| sm.seconds_since_last_hook(&sid))
                            .map(|secs| secs < 30)
                            .unwrap_or(false);
                        let new_status = {
                            let mut s = read_status.lock().unwrap_or_else(|e| {
                                warn!("read_status lock poisoned, using fallback value");
                                e.into_inner()
                            });
                            if should_apply_pty_status_fallback(hook_active, *s) {
                                // Hook 静默后重新允许 PTY 推断接管。否则 Codex 这类只暴露
                                // 部分 hook 事件的 CLI 会在一次 waiting-input 后永久卡住状态。
                                *s = inferred;
                            }
                            *s
                        };

                        // 检测状态变更并触发通知
                        // 阶段 2.8：hook 主导时不再由 PTY 触发 WaitingInput 通知（hook 自己上报更准）。
                        // 弱判据（`?` 结尾/裸 `>`/shell 提示符）只改徽章不弹通知：grok 这类
                        // TUI 底栏常驻 `>`，每次重绘都翻出一次伪边沿，曾造成 1-2 分钟一张的
                        // 「需要你输入」通知洪水。
                        if !hook_active {
                            let mut prev = prev_status.lock().unwrap_or_else(|e| {
                                warn!("prev_status lock poisoned, using fallback value");
                                e.into_inner()
                            });
                            if *prev != SessionStatus::WaitingInput
                                && new_status == SessionStatus::WaitingInput
                                && inferred_waiting_is_strong(&data)
                            {
                                read_notifier.notify_waiting_input(&sid);
                            }
                            *prev = new_status;
                        }

                        let normalized_prompt = normalize_prompt_text(&data);

                        // 追加到原始 VT 回放缓冲区，并取 push 后的 pushed_seq 作为
                        // 本 chunk 的 end seq——seq 必须与 ReplayBuffer 记账同源
                        // （同一字节流同一计数），锁失败时不产 seq（None）。
                        let chunk_end_seq = match read_replay_buffer.lock() {
                            Ok(mut replay) => {
                                replay.push(&data);
                                Some(replay.pushed_seq)
                            }
                            Err(_) => None,
                        };

                        // 追加到纯文本输出缓冲区
                        if let Ok(mut buf) = read_output_buffer.lock() {
                            buf.push(&data);
                        }

                        // 发送到批量合并线程（替代直接 emit，降低 IPC 频率）。
                        //
                        // try_send 而非 send：阻塞在这里的 reader 看不到 cancelled
                        // （循环顶部才检查），kill 会话会挂起。队列满时**整段丢弃
                        // 并发 desync**——绝不掐断 VT 序列中段（同 ws_emitter 契约）。
                        // 字节已进 ReplayBuffer，前端走 snapshot 重放补齐。
                        match batch_tx.try_send((data.clone(), chunk_end_seq)) {
                            Ok(()) => {}
                            Err(std::sync::mpsc::TrySendError::Full(_)) => {
                                if !read_desync_warned.swap(true, Ordering::Relaxed) {
                                    warn!(
                                        "[pty-read] session={} output batch channel full; \
                                         skipping chunk and signalling desync (capacity={})",
                                        sid, OUTPUT_BATCH_CHANNEL_CAPACITY
                                    );
                                }
                                let _ = read_emitter.emit(
                                    EV::TERMINAL_DESYNC,
                                    serde_json::json!({ "sessionId": sid }),
                                );
                            }
                            Err(std::sync::mpsc::TrySendError::Disconnected(_)) => break,
                        }

                        if let Some(runtime) = read_ssh_auth_runtime.as_ref() {
                            if let Ok(mut runtime) = runtime.lock() {
                                runtime.prompt_buffer.push_str(&normalized_prompt);
                                if runtime.prompt_buffer.len() > 512 {
                                    // keep_from 是字节偏移；SSH MOTD/中文 banner 含多字节
                                    // 字符时可能落在字符中间，drain 非字符边界会 panic
                                    // 并毒化本锁。向后对齐到最近的字符边界（最多多丢 3B）。
                                    let mut keep_from = runtime.prompt_buffer.len() - 512;
                                    while keep_from < runtime.prompt_buffer.len()
                                        && !runtime.prompt_buffer.is_char_boundary(keep_from)
                                    {
                                        keep_from += 1;
                                    }
                                    runtime.prompt_buffer.drain(..keep_from);
                                }
                                let last_line = runtime
                                    .prompt_buffer
                                    .rsplit('\n')
                                    .next()
                                    .map(|line| line.trim_end().to_string());
                                if let Some(last_line) = last_line {
                                    if !runtime.auto_response_sent
                                        && looks_like_ssh_password_prompt(&last_line)
                                    {
                                        let password =
                                            ssh_password_response(&runtime.saved_password);
                                        if write_via_writer_tx(&read_writer_tx, password).is_ok() {
                                            runtime.auto_response_sent = true;
                                            runtime.prompt_buffer.clear();
                                        }
                                    }
                                }
                            }
                        }

                        // 发送状态事件（节流：仅在 status 变化或距上次发射 ≥2s 时发射）
                        let now_instant = Instant::now();
                        let status_changed = new_status != last_emitted_status;
                        let time_elapsed = now_instant.duration_since(last_status_emit_time)
                            >= std::time::Duration::from_secs(2);

                        if status_changed || time_elapsed {
                            let status_for_emit = new_status;
                            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                let now_ms = current_epoch_millis();
                                let _ = read_emitter.emit(
                                    EV::TERMINAL_STATUS,
                                    serde_json::to_value(build_session_status_info(
                                        sid.clone(),
                                        status_for_emit,
                                        now_ms,
                                        Some(reader_pid),
                                        None,
                                        read_state_machine.as_ref(),
                                    ))
                                    .unwrap_or_default(),
                                );
                            }));
                            last_emitted_status = new_status;
                            last_status_emit_time = now_instant;
                        }
                    }
                    Err(e) => {
                        warn!(
                            "[pty-read] session={} read error: {} (read_count={} in {}ms)",
                            sid,
                            e,
                            read_count,
                            read_window_start.elapsed().as_millis()
                        );
                        break;
                    }
                }
            }
            // reader 线程退出时 batch_tx 被 drop，触发 batcher 线程的 Disconnected 分支
        });

        // 启动等待线程
        let sid = session_id.clone();
        let wait_emitter = emitter;
        let exit_status = status;
        let wait_notifier = notifier;
        let sessions_for_wait = Arc::clone(&self.sessions);
        let dead_buffers_for_wait = Arc::clone(&self.dead_buffers);
        let input_mutexes_for_wait = Arc::clone(&self.input_mutexes);
        let wait_paste_ready = paste_ready;
        let wait_output_flow = output_flow;
        let wait_pid = session_pid;
        let wait_resume_diag = resume_diag;
        let wait_output_buffer = output_buffer.clone();
        let wait_exit_code = exit_code.clone();
        let wait_spawned_at = Instant::now();
        let wait_data_dir = self.app_paths.data_dir().to_path_buf();
        let wait_state_machine = self
            .state_machine
            .lock()
            .ok()
            .and_then(|g| g.as_ref().cloned());
        thread::spawn(move || {
            let process_exit_code = match process_for_wait.wait() {
                Ok(status) => {
                    if status.success() {
                        0
                    } else {
                        1
                    }
                }
                Err(_) => -1,
            };
            if let Ok(mut stored_exit_code) = wait_exit_code.lock() {
                *stored_exit_code = Some(process_exit_code);
            }
            info!(session_id = %sid, exit_code = process_exit_code, "PTY process exited");
            if let Some(cleanup) = wait_pi_managed_state_cleanup.as_ref() {
                cleanup.cleanup();
            }
            if let Some(cleanup) = wait_wsl_pi_state_cleanup.as_ref() {
                cleanup.cleanup();
            }

            // resume 启动失败取证：resume 会话在 120s 内退出（ConPTY exit code 不可靠，
            // 时间窗 + 错误特征匹配是主信号）。tail 可能含用户 prompt/模型输出，
            // 仅在命中错误特征或非零退出时记录，且限 20 行。
            if let Some((resume_id, cli_tool_id, command_line)) = wait_resume_diag.as_ref() {
                let elapsed = wait_spawned_at.elapsed();
                if process_exit_code != 0 || elapsed < std::time::Duration::from_secs(120) {
                    let tail = wait_output_buffer
                        .lock()
                        .map(|buf| buf.get_recent(20))
                        .unwrap_or_default();
                    let joined = tail.join("\n").to_lowercase();
                    let matched_pattern = [
                        "no conversation found",
                        "session not found",
                        "cannot resume",
                        "not found in",
                        "error",
                    ]
                    .iter()
                    .find(|pattern| joined.contains(*pattern))
                    .copied();
                    let include_tail = matched_pattern.is_some() || process_exit_code != 0;
                    warn!(
                        session_id = %sid,
                        resume_id = %resume_id,
                        cli_tool = %cli_tool_id,
                        exit_code = process_exit_code,
                        elapsed_ms = elapsed.as_millis() as u64,
                        matched_pattern = ?matched_pattern,
                        command = %command_line,
                        tail = ?include_tail.then_some(tail),
                        "resume session exited shortly after launch (heuristic; manual quit also triggers this)"
                    );
                    // resume 失败可见化（docs/86 A4）：此前只有上面这条后端 WARN，
                    // 前端零提示，表现为「标签一闪即空」。判据比 WARN 更窄——
                    // 必须命中错误特征，手动退出（exit 0 无错误输出）不误报。
                    if matched_pattern.is_some() {
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            let _ = wait_emitter.emit(
                                EV::TERMINAL_LAUNCH_WARNING,
                                serde_json::json!({
                                    "kind": "resumeLaunchFailed",
                                    "sessionId": sid.clone(),
                                    "resumeId": resume_id,
                                    "cliTool": cli_tool_id,
                                    "exitCode": process_exit_code,
                                    "matchedPattern": matched_pattern,
                                }),
                            );
                        }));
                    }
                }
            }

            // 标记为已退出
            wait_paste_ready.store(false, Ordering::Release);
            // 拆除释放（B-1）：进程自己结束时 reader 可能正 park 着——它在等 ACK，
            // 而没人会再来 ACK，于是要空等一整个失效窗口才发现 PTY 已关。放行让它
            // 立刻走到 read() 拿到 EOF 并退出循环。
            wait_output_flow.release();
            {
                let mut s = exit_status.lock().unwrap_or_else(|e| {
                    warn!("exit_status lock poisoned, using fallback value");
                    e.into_inner()
                });
                *s = SessionStatus::Exited;
            }
            if let Some(sm) = wait_state_machine.as_ref() {
                sm.force_exited(&sid);
            }

            // 发送退出通知
            wait_notifier.notify_session_exited(&sid, process_exit_code);
            wait_notifier.cleanup_session(&sid);

            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _ = wait_emitter.emit(
                    EV::TERMINAL_EXIT,
                    serde_json::to_value(&TerminalExit {
                        session_id: sid.clone(),
                        exit_code: process_exit_code,
                    })
                    .unwrap_or_default(),
                );
            }));

            // 发送最终状态
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _ = wait_emitter.emit(
                    EV::TERMINAL_STATUS,
                    serde_json::to_value(build_session_status_info(
                        sid.clone(),
                        SessionStatus::Exited,
                        current_epoch_millis(),
                        Some(wait_pid),
                        Some(process_exit_code),
                        wait_state_machine.as_ref(),
                    ))
                    .unwrap_or_default(),
                );
            }));

            // 延迟清理会话：等待读取线程完成后移除 session，
            // 防止僵尸会话永久驻留在 HashMap 中
            thread::sleep(std::time::Duration::from_millis(500));
            // 自然退出也要清理 per-session 输入锁，否则长期运行下每个已退出
            // 会话都会残留一个 Arc<Mutex<()>>（此前仅 kill() 清理）。
            if let Ok(mut input_mutexes) = input_mutexes_for_wait.lock() {
                input_mutexes.remove(&sid);
            }
            if let Ok(mut sessions) = sessions_for_wait.lock() {
                // 移除前保存 output_buffer 到 dead_buffers，供事后读取
                if let Some(session) = sessions.remove(&sid) {
                    let exit_code = Arc::clone(&session.exit_code);
                    // 会话退出后仍保留足够输出供用户回看，5 分钟后清理。
                    if let Ok(mut buf) = session.output_buffer.lock() {
                        buf.shrink(DEAD_OUTPUT_MAX_LINES, DEAD_OUTPUT_MAX_BYTES);
                    }
                    if let Ok(mut replay) = session.replay_buffer.lock() {
                        replay.shrink(DEAD_REPLAY_MAX_BYTES);
                    }
                    if let Ok(mut dead) = dead_buffers_for_wait.lock() {
                        dead.insert(
                            sid.clone(),
                            DeadBufferEntry {
                                output_buffer: session.output_buffer,
                                replay_buffer: session.replay_buffer,
                                created_at: Instant::now(),
                                exit_code,
                                pid: Some(wait_pid),
                                last_output_at: current_epoch_millis(),
                            },
                        );
                    }
                }
            }
            wsl_codex::cleanup_session_mcp_configs(&wait_data_dir, &sid);
        });

        log_launch_stage(
            launch_id,
            Some(&session_id),
            cli_tool,
            runtime_kind,
            launch_trace_started_at,
            "launch.ready",
            "ok",
        );
        info!(session_id = %session_id, project = %project_path, launch_claude, "Terminal session created");
        Ok(create_session_outcome(session_id, false, &provider_plan))
    }

    fn ensure_launch_active(&self, launch_id: Option<&str>, stage: &str) -> Result<()> {
        let Some(launch_id) = launch_id.filter(|value| !value.trim().is_empty()) else {
            return Ok(());
        };
        let cancelled = self
            .cancelled_launches
            .lock()
            .map_err(|_| anyhow!("cancelled launches lock poisoned"))?
            .remove(launch_id)
            .is_some();
        if !cancelled {
            return Ok(());
        }
        warn!(
            launch_id,
            stage, "terminal launch cancelled before session became ready"
        );
        Err(anyhow::Error::new(launch_cancelled_error(
            Some(launch_id),
            stage,
        )))
    }

    fn reserve_launch(&self, launch_id: Option<&str>) -> Result<Option<LaunchReservation<'_>>> {
        let Some(launch_id) = launch_id.filter(|value| !value.trim().is_empty()) else {
            return Ok(None);
        };
        let launch_id = launch_id.trim();
        let mut active_launches = self
            .active_launches
            .lock()
            .map_err(|_| anyhow!("active launches lock poisoned"))?;
        if active_launches.contains(launch_id) {
            return Err(anyhow::Error::new(AppError::coded_with_params(
                "LAUNCH_DUPLICATE",
                format!("A terminal launch with id '{launch_id}' is already active"),
                HashMap::from([(String::from("launchId"), launch_id.to_string())]),
            )));
        }
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("sessions lock poisoned"))?;
        if sessions
            .values()
            .any(|session| session.launch_id.as_deref() == Some(launch_id))
        {
            return Err(anyhow::Error::new(AppError::coded_with_params(
                "LAUNCH_DUPLICATE",
                format!("A terminal session for launch id '{launch_id}' already exists"),
                HashMap::from([(String::from("launchId"), launch_id.to_string())]),
            )));
        }
        active_launches.insert(launch_id.to_string());
        Ok(Some(LaunchReservation {
            active_launches: &self.active_launches,
            launch_id: launch_id.to_string(),
        }))
    }

    /// Cancel a launch before or after it has registered its session. The cancellation marker and
    /// session lookup use the same lock order as registration, closing the late-response race.
    pub fn cancel_launch(&self, launch_id: &str) -> AppResult<()> {
        let launch_id = launch_id.trim();
        if launch_id.is_empty() {
            return Ok(());
        }

        let session_ids = {
            let mut cancelled_launches = self
                .cancelled_launches
                .lock()
                .map_err(|_| AppError::from("cancelled launches lock poisoned"))?;
            let cutoff = Instant::now() - Duration::from_secs(300);
            cancelled_launches.retain(|_, created_at| *created_at >= cutoff);
            cancelled_launches.insert(launch_id.to_string(), Instant::now());

            let sessions = self
                .sessions
                .lock()
                .map_err(|_| AppError::from("sessions lock poisoned"))?;
            let session_ids = sessions
                .iter()
                .filter(|(_, session)| session.launch_id.as_deref() == Some(launch_id))
                .map(|(session_id, _)| session_id.clone())
                .collect::<Vec<_>>();
            if !session_ids.is_empty() {
                cancelled_launches.remove(launch_id);
            }
            session_ids
        };

        for session_id in session_ids {
            match self.kill_with_reason(&session_id, KillReason::LaunchTimeout) {
                Ok(()) | Err(AppError::NotFound(_)) => Ok(()),
                Err(error) => Err(error),
            }?;
        }
        Ok(())
    }

    pub fn find_session_id_by_launch_id(&self, launch_id: &str) -> Option<String> {
        if launch_id.trim().is_empty() {
            return None;
        }
        let sessions = self.sessions.lock().ok()?;
        sessions.iter().find_map(|(session_id, session)| {
            (session.launch_id.as_deref() == Some(launch_id)).then(|| session_id.clone())
        })
    }

    /// 目标是否是跑 TUI composer 的 CLI agent（而非纯 shell）。
    ///
    /// 会话查不到时返回 `false`：宁可退回原行为，也不要凭空给未知目标加括号粘贴。
    fn session_runs_tui_composer(&self, session_id: &str) -> bool {
        self.sessions
            .lock()
            .ok()
            .and_then(|sessions| sessions.get(session_id).map(|s| s.cli_tool))
            .is_some_and(|cli_tool| cli_tool != CliTool::None)
    }

    pub fn is_paste_ready(&self, session_id: &str) -> AppResult<bool> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| AppError::from("sessions lock poisoned"))?;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| AppError::from(format!("Session not found: {session_id}")))?;
        Ok(session.paste_ready.load(Ordering::Acquire))
    }

    /// 获取所有会话状态
    ///
    /// 附带清理过期 dead_buffers（搭便车，前端周期性调用此方法）
    pub fn get_all_status(&self) -> Result<Vec<SessionStatusInfo>> {
        // 主动清理过期 dead_buffers（>5 分钟），防止内存泄漏
        if let Ok(mut dead) = self.dead_buffers.lock() {
            dead.retain(|_, entry| entry.created_at.elapsed().as_secs() < 300);
        }

        let sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("sessions lock poisoned"))?;
        Ok(sessions
            .iter()
            .map(|(id, session)| {
                let status = *session.status.lock().unwrap_or_else(|e| e.into_inner());
                let elapsed = session
                    .last_output_at
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .elapsed();

                // 基于时间的状态修正
                // 阶段 2.8：8s 超时降级仅作用于 PTY 推断出的 legacy Active，
                // 不覆盖 ToolRunning/Compacting/WaitingInput/Error/Idle/Exited
                // （这些状态由 hook 主导，由状态机定夺）。
                let adjusted_status = match status {
                    SessionStatus::Active if elapsed.as_secs() > 8 => SessionStatus::Idle,
                    other => other,
                };

                build_session_status_info(
                    id.clone(),
                    adjusted_status,
                    current_epoch_millis().saturating_sub(elapsed.as_millis() as u64),
                    Some(session.process.pid()),
                    session
                        .exit_code
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .to_owned(),
                    self.state_machine
                        .lock()
                        .ok()
                        .and_then(|guard| guard.as_ref().cloned())
                        .as_ref(),
                )
            })
            .collect())
    }

    /// 获取单个会话状态；退出后 5 分钟内可从 dead buffer 查询最终状态。
    pub fn get_session_status(&self, session_id: &str) -> Result<Option<SessionStatusInfo>> {
        if let Ok(sessions) = self.sessions.lock() {
            if let Some(session) = sessions.get(session_id) {
                let status = *session.status.lock().unwrap_or_else(|e| e.into_inner());
                let elapsed = session
                    .last_output_at
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .elapsed();
                let adjusted_status = match status {
                    SessionStatus::Active if elapsed.as_secs() > 8 => SessionStatus::Idle,
                    other => other,
                };
                return Ok(Some(build_session_status_info(
                    session_id.to_string(),
                    adjusted_status,
                    current_epoch_millis().saturating_sub(elapsed.as_millis() as u64),
                    Some(session.process.pid()),
                    session
                        .exit_code
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .to_owned(),
                    self.state_machine
                        .lock()
                        .ok()
                        .and_then(|guard| guard.as_ref().cloned())
                        .as_ref(),
                )));
            }
        }

        let mut dead = self
            .dead_buffers
            .lock()
            .map_err(|_| anyhow!("dead_buffers lock poisoned"))?;
        dead.retain(|_, entry| entry.created_at.elapsed().as_secs() < 300);
        Ok(dead.get(session_id).map(|entry| {
            build_session_status_info(
                session_id.to_string(),
                SessionStatus::Exited,
                entry.last_output_at,
                entry.pid,
                entry
                    .exit_code
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .to_owned(),
                self.state_machine
                    .lock()
                    .ok()
                    .and_then(|guard| guard.as_ref().cloned())
                    .as_ref(),
            )
        }))
    }

    pub fn terminal_link_context(
        &self,
        session_id: &str,
    ) -> AppResult<Option<TerminalLinkContext>> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| AppError::from("sessions lock poisoned"))?;
        let Some(session) = sessions.get(session_id) else {
            return Ok(None);
        };
        let status = session
            .status
            .lock()
            .map_err(|_| AppError::from("session status lock poisoned"))?;
        if status.is_terminal() {
            return Ok(None);
        }
        Ok(Some(TerminalLinkContext {
            project_path: session.project_path.clone(),
            runtime_kind: session.runtime_kind.clone(),
        }))
    }

    /// 返回所有活跃（非 Exited）session 的根 PID
    pub fn get_active_pids(&self) -> Vec<u32> {
        let sessions = match self.sessions.lock() {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        sessions
            .values()
            .filter_map(|session| {
                let status = *session.status.lock().unwrap_or_else(|e| e.into_inner());
                if status != SessionStatus::Exited {
                    Some(session.process.pid())
                } else {
                    None
                }
            })
            .collect()
    }

    /// 向终端写入数据（分块写入防止 ConPTY/ink 丢字符）
    ///
    /// 写入由每个 session 独立 writer 线程执行，避免一个假死 SSH 写入
    /// 阻塞全局 sessions 锁并拖住其他窗口。
    /// 写入前端**代答**的终端查询回复（CPR / DA / kitty keyboard / OSC 颜色）。
    ///
    /// 与用户按键的区别只有一条，但很关键：回显开着时，按键**应该**被回显，代答回复
    /// 则必须抑制——它会变成屏幕上的可见垃圾，还会进入 slave 的输入队列，污染下一个
    /// 读 stdin 的程序。所以这条路径先同步查一次 ECHO。
    ///
    /// 抑制条件是**真 cooked**（ECHO 且 ICANON）：那种模式下回复既变成屏幕垃圾、
    /// 程序又读不到（行缓冲在等换行）。只看 ECHO 不够——ECHO 开而 ICANON 关时程序
    /// 确实收得到，那里抑制就是把它正等着的回复吞掉，等于制造永久阻塞。
    ///
    /// 查不到就照写（`cooked_echo_enabled` 返回 `None`）：不拿"不知道"当"是"。
    pub fn write_reply(&self, session_id: &str, data: &str) -> Result<()> {
        if self.tty_cooked_echo(session_id) == Some(true) {
            debug!(
                session_id = %session_id,
                input = %summarize_input_bytes(data.as_bytes()),
                "terminal-input.trace service.write_reply suppressed (tty in cooked echo)"
            );
            return Ok(());
        }
        self.write(session_id, data)
    }

    fn tty_cooked_echo(&self, session_id: &str) -> Option<bool> {
        let sessions = self.sessions.lock().ok()?;
        sessions.get(session_id)?.process.cooked_echo_enabled()
    }

    pub fn write(&self, session_id: &str, data: &str) -> Result<()> {
        // 记一次按键时刻：合批线程据此把紧随其后的小批输出判为回显、绕过 16ms
        // 窗口立即刷出。回显延迟是用户直接可感知的（Stage 5 交互快路）。
        if let Ok(sessions) = self.sessions.lock() {
            if let Some(session) = sessions.get(session_id) {
                session.output_flow.note_input();
            }
        }
        let mutex = self
            .input_mutex_for_session(session_id)
            .map_err(|error| anyhow!(error.to_string()))?;
        let _guard = mutex
            .lock()
            .map_err(|_| anyhow!("terminal input lock poisoned"))?;
        self.write_unlocked(session_id, data)
    }

    fn write_unlocked(&self, session_id: &str, data: &str) -> Result<()> {
        let bytes = data.as_bytes();
        let chunks: Vec<&[u8]> = bytes.chunks(TERMINAL_WRITE_CHUNK_SIZE).collect();
        debug!(
            session_id = %session_id,
            chunk_count = chunks.len(),
            input = %summarize_input_bytes(bytes),
            "terminal-input.trace service.write"
        );
        let writer_tx = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| anyhow!("sessions lock poisoned"))?;
            sessions
                .get(session_id)
                .map(|session| session.writer_tx.clone())
                .ok_or_else(|| anyhow!("Session not found: {}", session_id))?
        };

        for (i, chunk) in chunks.iter().enumerate() {
            write_via_writer_tx(&writer_tx, chunk.to_vec())?;

            // 多 chunk 时，非最后一个 chunk 后添加延迟，让 ConPTY 消化输入
            if chunks.len() > 1 && i < chunks.len() - 1 {
                std::thread::sleep(TERMINAL_WRITE_INTER_CHUNK_DELAY);
            }
        }
        Ok(())
    }

    fn input_mutex_for_session(&self, session_id: &str) -> AppResult<Arc<Mutex<()>>> {
        let mut mutexes = self
            .input_mutexes
            .lock()
            .map_err(|_| AppError::from("terminal input mutexes lock poisoned"))?;
        Ok(mutexes
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone())
    }

    /// 原子提交一条用户消息：终端声明支持时使用 bracketed paste，否则发送原始文本；
    /// 持有输入锁等待适配延迟后，再单独发送 Enter。
    pub fn submit_text_to_session(&self, session_id: &str, text: &str) -> AppResult<()> {
        if text.len() > SUBMIT_TEXT_MAX_BYTES {
            // fix(H1) review: submit 文本后端限制 256KB。
            return Err(AppError::from(format!(
                "submit_to_session text must be <= {} bytes",
                SUBMIT_TEXT_MAX_BYTES
            )));
        }

        let paste_ready = self.is_paste_ready(session_id)?;
        // `paste_ready` 的含义只是「我们**观察到**了 DECSET 2004」，观察不到不等于对面
        // 不支持：Windows ConPTY 从不转发这个序列，而 dispatch_task 注入 prompt 常常
        // 发生在 TUI 刚起、还没来得及宣告之前（启动期没有任何等待 paste_ready 的逻辑，
        // 它只在进程退出时被置回 false）。
        //
        // 此时把带换行的多行文本原样写下去，每个 `\n` 到 TUI 就是一次 Enter——消息被
        // 拆成几条是轻的，**composer 里停着的用户草稿会被第一个换行直接提交出去**。
        // `submit_delay_ms` 在这条路径上只是等更久，解决的是时序，解决不了语义。
        //
        // 故判据不看「有没有观察到」，而看**目标是不是带 composer 的 TUI**：是且文本
        // 跨行，就照样包括号粘贴。纯 shell 不适用——它本就该逐行执行，包上反而会让它
        // 把 `[200~` 当字面输入。万一某个 TUI 确实不支持，最坏是屏幕上多出字面标记，
        // 比丢掉用户草稿轻得多。
        let needs_paste_guard =
            !paste_ready && text.contains('\n') && self.session_runs_tui_composer(session_id);
        let wrapped_text = (paste_ready || needs_paste_guard).then(|| wrap_bracketed_paste(text));
        let submitted_text = wrapped_text.as_deref().unwrap_or(text);
        if needs_paste_guard {
            debug!(
                session_id = %session_id,
                "terminal-input.trace submit wrapped without observed DECSET 2004 (multiline to TUI)"
            );
        }
        let mutex = self.input_mutex_for_session(session_id)?;
        let _guard = mutex
            .lock()
            .map_err(|_| AppError::from("terminal input lock poisoned"))?;

        // fix(C2) review: 持有 per-session 锁覆盖“写文本 + sleep + 写 Enter”的完整序列。
        self.write_unlocked(session_id, submitted_text)
            .map_err(AppError::from)?;
        let delay_ms = submit_delay_ms(text.len(), paste_ready);
        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
        self.write_unlocked(session_id, "\r")
            .map_err(AppError::from)?;
        Ok(())
    }

    /// 调整终端大小
    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<()> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("sessions lock poisoned"))?;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| anyhow!("Session not found: {}", session_id))?;

        session.process.resize(cols, rows)?;
        Ok(())
    }

    /// 关闭终端会话（来源未标注，reason 记为 Unknown）
    pub fn kill(&self, session_id: &str) -> AppResult<()> {
        self.kill_with_reason(session_id, KillReason::Unknown)
    }

    /// 关闭终端会话并标注 kill 来源，随 `session-killed` 事件广播
    pub fn kill_with_reason(&self, session_id: &str, reason: KillReason) -> AppResult<()> {
        info!(session_id = %session_id, reason = %reason.as_str(), "Terminal kill requested");
        // 在 sessions lock 外 drop session，避免进程终止阻塞全局会话锁
        let session = {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| AppError::from("sessions lock poisoned"))?;
            sessions.remove(session_id)
        }; // sessions lock 在此释放

        // 提前广播 kill 事件：`sessions.remove` 之后 `get_session_status` 已查不到本会话，
        // 若拖到 cleanup + `process.kill()`（Windows 杀进程树可达数百 ms）之后才 emit，
        // daemon 事件桥接的 500ms 状态轮询会抢先判定会话消失、只发静默 terminal-exit(-1)
        // 并退出 → socket 被 drop，队列里的 session-killed 永远读不到 → 标签关不掉。
        // 前端据 reason 决定关标签还是保留显示退出；输出已存入 dead_buffers，提前关标签不丢日志。
        if session.is_some() {
            if let Some(emitter) = self.emitter.read().as_ref() {
                let _ = emitter.emit(
                    EV::SESSION_KILLED,
                    serde_json::json!({ "sessionId": session_id, "reason": reason }),
                );
            }
        }

        if let Ok(mut input_mutexes) = self.input_mutexes.lock() {
            input_mutexes.remove(session_id);
        }
        wsl_codex::cleanup_session_mcp_configs(self.app_paths.data_dir(), session_id);

        if let Some(session) = session {
            session.paste_ready.store(false, Ordering::Release);
            // 保存 output_buffer 到 dead_buffers，供事后读取
            // 保留足够输出供用户在关闭/断连后短时间回看。
            if let Ok(mut buf) = session.output_buffer.lock() {
                buf.shrink(DEAD_OUTPUT_MAX_LINES, DEAD_OUTPUT_MAX_BYTES);
            }
            if let Ok(mut replay) = session.replay_buffer.lock() {
                replay.shrink(DEAD_REPLAY_MAX_BYTES);
            }
            if let Ok(mut dead) = self.dead_buffers.lock() {
                dead.insert(
                    session_id.to_string(),
                    DeadBufferEntry {
                        output_buffer: Arc::clone(&session.output_buffer),
                        replay_buffer: Arc::clone(&session.replay_buffer),
                        created_at: Instant::now(),
                        exit_code: Arc::clone(&session.exit_code),
                        pid: Some(session.process.pid()),
                        last_output_at: current_epoch_millis(),
                    },
                );
            }
            // 设置取消标志，通知 reader 线程停止 emit 事件
            session.cancelled.store(true, Ordering::Relaxed);
            // 拆除释放（B-1）：唤醒可能正 park 的 reader。**必须在置 cancelled 之后**
            // ——被唤醒的 reader 立刻看到取消位并退出，而不是回头再去 read() 一个
            // 正在拆的 PTY。漏掉这一步，park 中的本地 PTY 会永远卡住。
            session.output_flow.release();
            // 标记为已退出，防止等待线程在 kill 后重复发送事件
            {
                let mut s = session.status.lock().unwrap_or_else(|e| e.into_inner());
                *s = SessionStatus::Exited;
            }
            if let Some(state_machine) = self
                .state_machine
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .as_ref()
                .cloned()
            {
                state_machine.force_exited(session_id);
            }
            let _ = session.process.kill();
            if let Some(cleanup) = session.managed_pi_state_cleanup.as_ref() {
                cleanup.cleanup();
            }
            if let Some(cleanup) = session.managed_wsl_pi_state_cleanup.as_ref() {
                cleanup.cleanup();
            }
            // session-killed 已在 sessions.remove 后立即广播（见上），此处不再重复 emit
            // session 在此 drop，不再持有 sessions lock
            Ok(())
        } else {
            // fix(H2) review: kill 缺失 session 返回 typed NotFound，由命令层判定幂等成功。
            Err(AppError::NotFound(format!(
                "Session not found: {}",
                session_id
            )))
        }
    }

    /// 获取所有活跃会话的输出缓冲区内容（用于退出时持久化）
    ///
    /// 返回 `HashMap<session_id, Vec<行>>`，包含活跃会话和 dead_buffers 中的内容。
    pub fn get_all_session_outputs(&self) -> std::collections::HashMap<String, Vec<String>> {
        let mut result = std::collections::HashMap::new();

        // 活跃会话
        if let Ok(sessions) = self.sessions.lock() {
            for (id, session) in sessions.iter() {
                if let Ok(buf) = session.output_buffer.lock() {
                    let lines = buf.get_recent(0);
                    if !lines.is_empty() {
                        result.insert(id.clone(), lines);
                    }
                }
            }
        }

        // 已退出但尚未过期的会话
        if let Ok(dead) = self.dead_buffers.lock() {
            for (id, entry) in dead.iter() {
                if !result.contains_key(id) {
                    if let Ok(buf) = entry.output_buffer.lock() {
                        let lines = buf.get_recent(0);
                        if !lines.is_empty() {
                            result.insert(id.clone(), lines);
                        }
                    }
                }
            }
        }

        result
    }

    /// 清理所有终端会话（应用退出时调用）
    pub fn cleanup_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            let count = sessions.len();
            for (session_id, session) in sessions.drain() {
                // 先设置取消标志，通知 reader 线程停止（与 kill() 保持一致）
                session.cancelled.store(true, Ordering::Relaxed);
                // 拆除释放（B-1）：同 kill 路径——留在 park 的 reader 会拖住退出。
                session.output_flow.release();
                {
                    let mut s = session.status.lock().unwrap_or_else(|e| e.into_inner());
                    *s = SessionStatus::Exited;
                }
                let _ = session.process.kill();
                if let Some(cleanup) = session.managed_pi_state_cleanup.as_ref() {
                    cleanup.cleanup();
                }
                if let Some(cleanup) = session.managed_wsl_pi_state_cleanup.as_ref() {
                    cleanup.cleanup();
                }
                wsl_codex::cleanup_session_mcp_configs(self.app_paths.data_dir(), &session_id);
            }
            if count > 0 {
                info!("[cleanup] cleaned up {} terminal sessions", count);
            }
        }
    }

    /// 读取终端会话的最近输出（纯文本，ANSI 已剥离）
    ///
    /// 先查活跃会话，未找到则查 dead_buffers（已退出会话保留 5 分钟）。
    /// `lines` 为 0 时返回缓冲区全部内容。
    pub fn get_session_output(&self, session_id: &str, lines: usize) -> Result<SessionOutput> {
        // 1. 从活跃会话中查找（clone Arc 后立即释放 sessions 锁）
        let buf_arc = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| anyhow!("sessions lock poisoned"))?;
            sessions
                .get(session_id)
                .map(|s| Arc::clone(&s.output_buffer))
        };

        // 2. 未找到则查 dead_buffers（懒清理过期条目）
        let buf_arc = match buf_arc {
            Some(arc) => arc,
            None => {
                let mut dead = self
                    .dead_buffers
                    .lock()
                    .map_err(|_| anyhow!("dead_buffers lock poisoned"))?;
                // 懒清理：移除超过 5 分钟的条目
                dead.retain(|_, entry| entry.created_at.elapsed().as_secs() < 300);
                dead.get(session_id)
                    .map(|entry| Arc::clone(&entry.output_buffer))
                    .ok_or_else(|| anyhow!("Session not found: {}", session_id))?
            }
        };

        // 3. 单独锁 buffer 读取
        let buf = buf_arc
            .lock()
            .map_err(|_| anyhow!("output_buffer lock poisoned"))?;
        Ok(SessionOutput {
            session_id: session_id.to_string(),
            lines: buf.get_recent(lines),
        })
    }

    /// 读取终端会话的原始 VT replay 快照，用于 attach-existing 首屏恢复。
    ///
    /// 会话存在但尚无输出时返回空快照；会话不存在时返回 None。
    pub fn get_session_replay_snapshot(
        &self,
        session_id: &str,
    ) -> Result<Option<TerminalReplaySnapshot>> {
        let replay_arc = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| anyhow!("sessions lock poisoned"))?;
            sessions
                .get(session_id)
                .map(|session| Arc::clone(&session.replay_buffer))
        };

        let replay_arc = match replay_arc {
            Some(arc) => arc,
            None => {
                let mut dead = self
                    .dead_buffers
                    .lock()
                    .map_err(|_| anyhow!("dead_buffers lock poisoned"))?;
                dead.retain(|_, entry| entry.created_at.elapsed().as_secs() < 300);
                match dead.get(session_id) {
                    Some(entry) => Arc::clone(&entry.replay_buffer),
                    None => return Ok(None),
                }
            }
        };

        let replay = replay_arc
            .lock()
            .map_err(|_| anyhow!("replay_buffer lock poisoned"))?;
        Ok(Some(replay.snapshot()))
    }

    /// 记录前端的输出投递回执（B-5）。
    ///
    /// `processed_end_seq` 是累计值：max-merge + 夹到已发送量，所以重复投递不重复
    /// 计费、乱序不倒退、丢一条下次自愈。未知会话静默忽略——会话销毁与在途 ACK
    /// 天生会赛跑，为此报错只会在日志里刷噪音。
    pub fn ack_terminal_output(&self, session_id: &str, processed_end_seq: u64) -> AppResult<()> {
        let flow = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| AppError::from("sessions lock poisoned"))?;
            sessions
                .get(session_id)
                .map(|session| Arc::clone(&session.output_flow))
        };
        if let Some(flow) = flow {
            flow.note_acked(processed_end_seq);
        }
        Ok(())
    }

    /// scrollback 设置变更后重算所有活跃会话的 replay 上限。
    ///
    /// 调小会立刻 front-drop 到新上限（`ReplayBuffer::shrink`）；调大只抬上限，
    /// 已经淘汰掉的历史不会回来——这与用户预期一致（设置对"往后"生效）。
    pub fn apply_scrollback_setting(&self, scrollback_rows: u32) -> AppResult<()> {
        let max_bytes = live_replay_max_bytes(scrollback_rows);
        let buffers: Vec<Arc<Mutex<ReplayBuffer>>> = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| AppError::from("sessions lock poisoned"))?;
            sessions
                .values()
                .map(|session| Arc::clone(&session.replay_buffer))
                .collect()
        };
        // 逐个上锁而不是攥着 sessions 锁做——replay 锁被 reader 线程高频争用，
        // 在这里嵌套持有会把整张会话表卡在洪流的节奏上。
        for buffer in buffers {
            if let Ok(mut replay) = buffer.lock() {
                replay.shrink(max_bytes);
            }
        }
        Ok(())
    }

    /// 每会话的投递水位快照（诊断用；Stage 3 的闸门与 Stage 4 的看门狗同源读它）。
    pub fn output_flow_stats(&self) -> AppResult<Vec<TerminalOutputFlowStat>> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| AppError::from("sessions lock poisoned"))?;
        Ok(sessions
            .iter()
            .map(|(session_id, session)| TerminalOutputFlowStat {
                session_id: session_id.clone(),
                sent_seq: session.output_flow.sent_seq(),
                acked_seq: session.output_flow.acked_seq(),
                in_flight_bytes: session.output_flow.in_flight(),
                ever_acked: session.output_flow.ever_acked(),
                ack_silence_ms: session
                    .output_flow
                    .ack_silence()
                    .map(|elapsed| elapsed.as_millis() as u64),
            })
            .collect())
    }

    /// 活跃会话与 dead_buffers 双查 replay_buffer（懒清理过期条目）。
    fn find_replay_buffer(&self, session_id: &str) -> AppResult<Option<Arc<Mutex<ReplayBuffer>>>> {
        let replay_arc = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| AppError::from("sessions lock poisoned"))?;
            sessions
                .get(session_id)
                .map(|session| Arc::clone(&session.replay_buffer))
        };
        if replay_arc.is_some() {
            return Ok(replay_arc);
        }
        let mut dead = self
            .dead_buffers
            .lock()
            .map_err(|_| AppError::from("dead_buffers lock poisoned"))?;
        dead.retain(|_, entry| entry.created_at.elapsed().as_secs() < 300);
        Ok(dead
            .get(session_id)
            .map(|entry| Arc::clone(&entry.replay_buffer)))
    }

    /// 存储前端上传的画面照片（M3b-1：daemon 内部存储，不裁剪 chunks）。
    ///
    /// 会话不存在（活跃 + dead 双查均未命中）返回 Err；拒收原因以
    /// `StoreCheckpointOutcome` 结构化返回而非错误。
    pub fn store_session_checkpoint(
        &self,
        session_id: &str,
        cp: TerminalCheckpoint,
    ) -> AppResult<StoreCheckpointOutcome> {
        let replay_arc = self
            .find_replay_buffer(session_id)?
            .ok_or_else(|| AppError::NotFound(format!("Session not found: {session_id}")))?;
        let mut replay = replay_arc
            .lock()
            .map_err(|_| AppError::from("replay_buffer lock poisoned"))?;
        Ok(replay.store_checkpoint(cp))
    }

    /// 需要补拍照片的活跃会话（daemon 周期扫描用，M3b-2）：
    /// 有效照片的 anchor 与 pushed_seq 差超过 `threshold_bytes`。
    /// **无照片不催**（首拍由前端边沿触发）；dead 会话不催（前端已不在看）。
    pub fn sessions_needing_checkpoint(&self, threshold_bytes: u64) -> Vec<String> {
        let replay_arcs: Vec<(String, Arc<Mutex<ReplayBuffer>>)> = match self.sessions.lock() {
            Ok(sessions) => sessions
                .iter()
                .map(|(session_id, session)| {
                    (session_id.clone(), Arc::clone(&session.replay_buffer))
                })
                .collect(),
            Err(_) => return Vec::new(),
        };
        replay_arcs
            .into_iter()
            .filter(|(_, replay_arc)| {
                replay_arc
                    .lock()
                    .map(|replay| replay.needs_checkpoint(threshold_bytes))
                    .unwrap_or(false)
            })
            .map(|(session_id, _)| session_id)
            .collect()
    }

    /// 读取 checkpoint+delta 结构化恢复快照。会话不存在时返回 None。
    pub fn get_session_recovery_snapshot(
        &self,
        session_id: &str,
    ) -> AppResult<Option<TerminalRecoverySnapshot>> {
        let Some(replay_arc) = self.find_replay_buffer(session_id)? else {
            return Ok(None);
        };
        let replay = replay_arc
            .lock()
            .map_err(|_| AppError::from("replay_buffer lock poisoned"))?;
        Ok(Some(replay.recovery_snapshot()))
    }

    pub fn get_available_shells(&self) -> Vec<ShellInfo> {
        detect_shells()
    }

    /// POSIX shell 安全转义：单引号包裹，内部单引号用 '\'' 处理
    fn shell_escape(s: &str) -> String {
        format!("'{}'", s.replace('\'', "'\\''"))
    }

    /// 检查环境变量 key 是否符合 `^[A-Z_][A-Z0-9_]*$` 格式（白名单）
    fn is_valid_env_key(key: &str) -> bool {
        if key.is_empty() {
            return false;
        }
        let mut chars = key.chars();
        // 首字符必须是 A-Z 或 _
        match chars.next() {
            Some(c) if c.is_ascii_uppercase() || c == '_' => {}
            _ => return false,
        }
        // 后续字符必须是 A-Z, 0-9 或 _
        chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
    }

    /// Managed-state directory name for the Pi family; `None` for every
    /// other CLI. The name is adapter-owned, so cleanup paths can never be
    /// pointed at a caller-supplied directory.
    fn pi_family_managed_state_dir_name(cli_tool: CliTool) -> Option<&'static str> {
        match cli_tool {
            CliTool::Pi => Some(cc_cli_adapters::PI_MANAGED_STATE_DIR_NAME),
            CliTool::Omp => Some(cc_cli_adapters::OMP_MANAGED_STATE_DIR_NAME),
            _ => None,
        }
    }

    /// Pi-family managed Providers own the complete provider environment.
    /// Remove request/shell values for every credential or endpoint variable
    /// the CLI owns before the adapter injects the selected value, so
    /// extra_env cannot bypass the adapter's endpoint and authentication
    /// validation.
    fn clear_managed_pi_environment(env_vars: &mut HashMap<String, String>, cli_tool: CliTool) {
        for key in managed_provider_conflict_env_keys(cli_tool) {
            env_vars.remove(*key);
        }
    }

    /// 新会话是否由 CC-Panes 预发确定性 session id：由 adapter 的
    /// `supports_issued_session_id` 能力决定（claude/grok = true），resume 场景不发号。
    fn should_issue_session_id(
        registry: &CliToolRegistry,
        cli_tool: CliTool,
        resume_id: Option<&str>,
    ) -> bool {
        resume_id.is_none()
            && registry
                .get(cli_tool.as_id())
                .map(|adapter| adapter.capabilities().supports_issued_session_id)
                .unwrap_or(false)
    }

    /// 远端 CLI 启动命令（含 YOLO 语义）。
    ///
    /// SSH 下 Codex 的语义需特别注意：
    /// - 非 YOLO：`codex --full-auto`（自动批准，但仍受沙箱约束）。
    /// - YOLO：`codex --dangerously-bypass-approvals-and-sandbox`（绕过审批与沙箱，
    ///   已蕴含 full-auto 行为，故有意不叠加 `--full-auto`）。
    ///
    /// Claude：非 YOLO 不加标志；YOLO 加 `--dangerously-skip-permissions`。
    ///
    /// **这张表刻意不下沉到 `CliToolAdapter`**（0.12.5 评估后否决）：adapter 承载的是
    /// **本地**启动知识——`resolve_launch` 会做本地可执行解析、用户 `executable_override`、
    /// Windows `.cmd` shim 改写、本地绝对路径。而这里跑的是**远端机器上**的命令，
    /// 两者同名不同物。放进 adapter 后极易有人顺手返回本地解析出来的绝对路径，
    /// 而那条路径在远端根本不存在；返回裸 `&str` 也会绕开调用方的统一转义。
    /// 新增 CLI 在这里加一行即可，成本本来就低。
    fn ssh_remote_cli_command(cli_tool: CliTool, yolo_mode: bool) -> &'static str {
        match cli_tool {
            CliTool::None => "exec $SHELL -l",
            CliTool::Claude if yolo_mode => "claude --dangerously-skip-permissions",
            CliTool::Claude => "claude",
            CliTool::Codex if yolo_mode => "codex --dangerously-bypass-approvals-and-sandbox",
            CliTool::Codex => "codex --full-auto",
            CliTool::Gemini => "gemini",
            CliTool::Kimi => "kimi",
            CliTool::Glm => "crush",
            CliTool::Opencode => "opencode",
            CliTool::Cursor => "cursor-agent",
            CliTool::Grok if yolo_mode => "grok --always-approve",
            CliTool::Grok => "grok",
            // create_session rejects the Pi family over SSH before this fallback is used.
            CliTool::Pi => "pi",
            CliTool::Omp => "omp",
        }
    }

    fn build_ssh_remote_command(
        ssh: &SshConnectionInfo,
        cli_tool: CliTool,
        provider_env: &HashMap<String, String>,
        provider: Option<&CliProvider>,
        yolo_mode: bool,
    ) -> String {
        let mut remote_parts: Vec<String> = Vec::new();
        let mut provider_env = provider_env.clone();
        let mut codex_provider_args = Vec::new();
        if cli_tool == CliTool::Codex {
            cc_cli_adapters::CodexAdapter::push_provider_overrides(
                &mut codex_provider_args,
                &mut provider_env,
                provider,
            );
        }

        // Provider 环境变量注入（白名单 key 格式 + value 转义）
        if cli_tool != CliTool::None {
            for (k, v) in &provider_env {
                if Self::is_valid_env_key(k) {
                    remote_parts.push(format!("export {}={}", k, Self::shell_escape(v)));
                } else {
                    warn!("Skipping env var with invalid key: {}", k);
                }
            }
        }

        // ~ 或 ~/ 表示 home 目录，SSH 登录默认就在 home，跳过 cd
        if ssh.remote_path != "~" && ssh.remote_path != "~/" {
            let escaped_path = Self::shell_escape(&ssh.remote_path);
            remote_parts.push(format!("cd {}", escaped_path));
        }
        let mut remote_cli = Self::ssh_remote_cli_command(cli_tool, yolo_mode).to_string();
        for arg in codex_provider_args {
            remote_cli.push(' ');
            remote_cli.push_str(&Self::shell_escape(&arg));
        }
        remote_parts.push(remote_cli);
        remote_parts.join(" && ")
    }

    /// 兼容旧 SSH 配置的系统 OpenSSH 回退命令。
    fn build_ssh_command(
        &self,
        ssh: &SshConnectionInfo,
        remote_command: &str,
    ) -> Result<(String, Vec<String>)> {
        let ssh_path = cached_which("ssh").map_err(|_| anyhow!("ssh not found in PATH"))?;

        let mut args = vec!["-tt".to_string()];
        append_ssh_session_options(&mut args);
        if ssh.port != 22 {
            args.extend(["-p".to_string(), ssh.port.to_string()]);
        }
        if let Some(ref id) = ssh.identity_file {
            args.extend(["-i".to_string(), id.clone()]);
        }

        let target = match &ssh.user {
            Some(user) => format!("{}@{}", user, ssh.host),
            None => ssh.host.clone(),
        };
        args.push(target);
        args.push(remote_command.to_string());

        Ok((ssh_path.to_string_lossy().into_owned(), args))
    }

    /// 获取 CLI 工具注册表
    pub fn cli_registry(&self) -> &Arc<CliToolRegistry> {
        &self.cli_registry
    }

    /// 设置 Orchestrator 连接信息（setup 阶段调用）
    pub fn set_orchestrator_info(&self, port: u16, token: String) {
        if let Ok(mut info) = self.orchestrator_info.lock() {
            *info = Some(OrchestratorInfo { port, token });
            info!("[terminal] Orchestrator info set: port={}", port);
        }
    }

    fn healthy_orchestrator_info(&self) -> Option<OrchestratorInfo> {
        let manifest_info = orchestrator_manifest::read_endpoint(self.app_paths.data_dir())
            .map(|(port, token)| OrchestratorInfo { port, token });
        let cached_info = self.orchestrator_info.lock().ok().and_then(|g| g.clone());
        let mut candidates = Vec::with_capacity(2);
        if let Some(info) = manifest_info {
            candidates.push(("manifest", info));
        }
        if let Some(info) = cached_info {
            let duplicate = candidates
                .iter()
                .any(|(_, existing)| existing.port == info.port && existing.token == info.token);
            if !duplicate {
                candidates.push(("cache", info));
            }
        }

        for (source, info) in candidates {
            if local_orchestrator_endpoint_reachable(info.port) {
                if let Ok(mut guard) = self.orchestrator_info.lock() {
                    *guard = Some(info.clone());
                }
                info!(
                    source,
                    port = info.port,
                    "orchestrator endpoint is reachable; using ccpanes MCP injection"
                );
                return Some(info);
            }
            warn!(
                source,
                port = info.port,
                "orchestrator endpoint is not reachable; trying next ccpanes MCP candidate"
            );
        }

        if let Ok(mut guard) = self.orchestrator_info.lock() {
            *guard = None;
        }
        warn!("no reachable orchestrator endpoint; skipping ccpanes MCP injection");
        None
    }

    /// 注入 SessionStateMachine 引用（setup 阶段调用）。
    ///
    /// 阶段 2.8：用于 ANSI 推断降级判定 —— hook 在 30s 内有上报时，
    /// PTY 输出 ANSI 推断不再覆盖状态机维护的细分 status（Thinking/ToolRunning 等）。
    pub fn set_state_machine(&self, sm: Arc<crate::services::SessionStateMachine>) {
        if let Ok(mut guard) = self.state_machine.lock() {
            *guard = Some(sm);
            info!("[terminal] SessionStateMachine reference injected");
        }
    }

    /// 由 SessionStateMachine listener 调用，把 hook 决定的新 status 写回
    /// 该 session 的 status Mutex 并通过 `TERMINAL_STATUS` 事件推给前端。
    ///
    /// 这是端到端能通的关键：状态机内部更新后必须落到 session 上，前端才能看到。
    /// 找不到 session（已退出 / 不存在）静默忽略。
    pub fn apply_hook_status(&self, session_id: &str, new_status: SessionStatus) {
        let pid = {
            let Ok(sessions) = self.sessions.lock() else {
                return;
            };
            let Some(session) = sessions.get(session_id) else {
                return;
            };
            // 写入 status Mutex（沿用 PTY read 线程的 lock 模式）
            if let Ok(mut s) = session.status.lock() {
                *s = new_status;
            }
            session.process.pid()
        };

        // 推给前端（仿 PTY read 线程的 emit 节流块，但这里不节流，hook 事件本身就是节点）
        if let Some(emitter) = self.emitter.read().as_ref() {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _ = emitter.emit(
                    EV::TERMINAL_STATUS,
                    serde_json::to_value(build_session_status_info(
                        session_id.to_string(),
                        new_status,
                        current_epoch_millis(),
                        Some(pid),
                        None,
                        self.state_machine
                            .lock()
                            .ok()
                            .and_then(|guard| guard.as_ref().cloned())
                            .as_ref(),
                    ))
                    .unwrap_or_default(),
                );
            }));
        }
    }

    /// 生成 Spec 注入 prompt（终端启动时调用）
    /// 成功时先 sync_tasks → 返回提示文本；失败时返回 None（不阻塞启动）
    fn generate_spec_prompt(&self, project_path: &str) -> Option<String> {
        let spec_svc = self.spec_service.lock().ok()?.as_ref()?.clone();

        // 先同步 Tasks 段
        if let Some(active) = spec_svc
            .list_specs(project_path, Some(crate::models::spec::SpecStatus::Active))
            .ok()
            .and_then(|specs| specs.into_iter().next())
        {
            if let Err(e) = spec_svc.sync_tasks(project_path, &active.id) {
                warn!("[spec] sync_tasks failed before prompt injection: {}", e);
            }
        }

        match spec_svc.get_active_spec_summary(project_path) {
            Ok(Some(summary)) => {
                let prompt = format!(
                    "This project has an active spec: \"{}\". Read the spec file at: {} ({}). \
                     Update task checkboxes in the spec file as you complete them.",
                    summary.title, summary.file_path, summary.tasks_summary,
                );
                info!("[spec] Injecting spec prompt for project: {}", project_path);
                Some(prompt)
            }
            Ok(None) => None,
            Err(e) => {
                warn!("[spec] get_active_spec_summary failed: {}", e);
                None
            }
        }
    }
}

/// 剥离 ANSI 转义序列，保留纯文本
///
/// 处理以下序列类型：
/// - CSI: `ESC[` 后跟参数字节 (0x30-0x3F)、中间字节 (0x20-0x2F)、终止字节 (0x40-0x7E)
/// - OSC: `ESC]` 后跟内容直到 ST (`ESC\`) 或 BEL (0x07)
/// - 其他双字符 ESC 序列: `ESC` + 0x40-0x5F 范围字符
fn strip_ansi_escapes(s: &str) -> String {
    let bytes = s.as_bytes();
    let len = bytes.len();
    let mut result = Vec::with_capacity(len);
    let mut i = 0;

    while i < len {
        if bytes[i] == 0x1B {
            // ESC
            if i + 1 < len {
                match bytes[i + 1] {
                    b'[' => {
                        // CSI sequence: ESC[ params intermediate final
                        i += 2;
                        // 跳过参数字节 0x30-0x3F
                        while i < len && (0x30..=0x3F).contains(&bytes[i]) {
                            i += 1;
                        }
                        // 跳过中间字节 0x20-0x2F
                        while i < len && (0x20..=0x2F).contains(&bytes[i]) {
                            i += 1;
                        }
                        // 跳过终止字节 0x40-0x7E
                        if i < len && (0x40..=0x7E).contains(&bytes[i]) {
                            i += 1;
                        }
                    }
                    b']' => {
                        // OSC sequence: ESC] ... (ST or BEL)
                        i += 2;
                        while i < len {
                            if bytes[i] == 0x07 {
                                // BEL terminates OSC
                                i += 1;
                                break;
                            }
                            if bytes[i] == 0x1B && i + 1 < len && bytes[i + 1] == b'\\' {
                                // ST (ESC\) terminates OSC
                                i += 2;
                                break;
                            }
                            i += 1;
                        }
                    }
                    0x40..=0x5F => {
                        // 其他双字符 ESC 序列 (Fe sequences)
                        i += 2;
                    }
                    _ => {
                        // 未知 ESC 序列，跳过 ESC 本身
                        i += 1;
                    }
                }
            } else {
                // 末尾孤立 ESC
                i += 1;
            }
        } else {
            result.push(bytes[i]);
            i += 1;
        }
    }

    String::from_utf8_lossy(&result).to_string()
}

/// OSC 状态信号 → 状态机事件（PTY 读线程回调）。
///
/// 状态更新与前端广播由 orchestrator 注册在状态机上的 listener 完成，
/// 这里只负责映射并投递；OSC 通道不携带 task_binding_id（HTTP 通道会补）。
fn apply_osc_signal(
    sm: &Arc<crate::services::SessionStateMachine>,
    session_id: &str,
    signal: osc_state_detect::OscSignal,
) {
    use crate::services::session_state_machine::{parse_cc_pane_event_name, EventChannel};
    use cc_cli_adapters::CcPaneEvent;
    use osc_state_detect::OscSignal;

    let (event, payload) = match signal {
        OscSignal::Started { agent } => (
            CcPaneEvent::SessionInit,
            serde_json::json!({"agent": agent, "source": "osc"}),
        ),
        OscSignal::Event { name } => {
            let Some(event) = parse_cc_pane_event_name(&name) else {
                debug!(
                    session_id,
                    event = %name,
                    "unknown cc-pane event name in OSC marker, dropped"
                );
                return;
            };
            (event, serde_json::json!({"source": "osc"}))
        }
        // 133;D 只发生在 shell 标签页（launch_task 直启的 CLI 没有 shell）：
        // agent 命令结束但 shell 还活着，映射 SessionEnd 会把活会话标成
        // Exited 并触发退出通知（审阅发现）。按退出码映射为 Idle / Error。
        OscSignal::CommandExited { exit_code } => match exit_code {
            Some(code) if code != 0 => (
                CcPaneEvent::Error,
                serde_json::json!({
                    "error_type": "agent-exit",
                    "exit_code": code,
                    "source": "osc"
                }),
            ),
            _ => (
                CcPaneEvent::TurnEnd,
                serde_json::json!({"exit_code": exit_code, "source": "osc"}),
            ),
        },
    };
    sm.on_event_with_channel(session_id, &event, None, &payload, EventChannel::Osc);
}

/// 从输出内容推断终端状态
fn infer_status(output: &str) -> SessionStatus {
    // 先剥离 ANSI 转义序列，得到纯文本
    let clean = strip_ansi_escapes(output);
    let trimmed = clean.trim();
    let tail_lower = terminal_tail_lower(trimmed, 2048);

    // 优先级：waitingInput > toolRunning > thinking > 通用 prompt
    // Cursor chrome 只匹配稳定文案，不碰 spinner 单帧（会抖动）。
    if cursor_agent_waiting_input(&tail_lower) {
        return SessionStatus::WaitingInput;
    }
    if cursor_agent_tool_running(&tail_lower) {
        return SessionStatus::ToolRunning;
    }
    if cursor_agent_thinking(&tail_lower) {
        return SessionStatus::Thinking;
    }

    if let Some(last_line) = trimmed.lines().last() {
        let line = last_line.trim();

        // Claude Code 权限提示：Yes/No 确认
        if line.ends_with("[Y/n]") || line.ends_with("[y/N]") {
            return SessionStatus::WaitingInput;
        }

        // Claude Code 提问：以 "?" 结尾
        if line.ends_with('?') {
            return SessionStatus::WaitingInput;
        }

        // Claude Code ink UI 提示符（剥离 ANSI 后就是 ">"）
        if line == ">" {
            return SessionStatus::WaitingInput;
        }

        // 检测 shell prompt 特征（等待输入）
        let prompt_patterns = ["$ ", "# ", "> ", "❯ ", "λ ", "PS>", ">>> ", "... "];
        for pattern in &prompt_patterns {
            if line.ends_with(pattern) || line.ends_with(pattern.trim()) {
                return SessionStatus::WaitingInput;
            }
        }
    }

    // 默认为活跃
    SessionStatus::Active
}

/// PTY 推断的 WaitingInput 是否值得打扰（弹桌面/IM 通知）。
///
/// 强判据 = 显式等待文案（Workspace Trust / needs your approval / [Y/n] 确认）；
/// 弱判据 = `?` 结尾、裸 `>`、shell 提示符——那些只用于状态徽章。TUI 的
/// spinner/底栏每帧重绘会让弱判据反复翻边沿，通知必须只认强判据
///（对齐 Orca：waiting 不从输出猜，例行形态一律不打扰）。
fn inferred_waiting_is_strong(output: &str) -> bool {
    let clean = strip_ansi_escapes(output);
    let trimmed = clean.trim();
    let tail_lower = terminal_tail_lower(trimmed, 2048);
    if cursor_agent_waiting_input(&tail_lower) {
        return true;
    }
    if let Some(last_line) = trimmed.lines().last() {
        let line = last_line.trim();
        if line.ends_with("[Y/n]") || line.ends_with("[y/N]") {
            return true;
        }
    }
    false
}

fn terminal_tail_lower(clean: &str, max_bytes: usize) -> String {
    let bytes = clean.as_bytes();
    let start = bytes.len().saturating_sub(max_bytes);
    let mut i = start;
    while i < bytes.len() && (bytes[i] & 0b1100_0000) == 0b1000_0000 {
        i += 1;
    }
    clean.get(i..).unwrap_or(clean).to_ascii_lowercase()
}

/// Cursor Agent TUI 等人提示（Workspace Trust / shell 审批 / 输入框）。
fn cursor_agent_waiting_input(tail_lower: &str) -> bool {
    const MARKERS: &[&str] = &[
        "workspace trust",
        "trust this workspace",
        "trust the workspace",
        "run everything",
        "add to allowlist",
        "command approval",
        "needs your approval",
        "waiting for approval",
        "press a to trust",
        "waiting for input",
        "type a message",
    ];
    MARKERS.iter().any(|m| tail_lower.contains(m))
}

/// Cursor 工具执行中：只认完整短语，不认单独 "running"。
fn cursor_agent_tool_running(tail_lower: &str) -> bool {
    const MARKERS: &[&str] = &[
        "running tool",
        "calling tool",
        "tool call",
        "executing command",
        "running command",
        "shell: ",
        "running shell",
    ];
    MARKERS.iter().any(|m| tail_lower.contains(m))
}

/// Cursor 思考中：避免单字 "thinking" 帧动画；要成短语。
fn cursor_agent_thinking(tail_lower: &str) -> bool {
    const MARKERS: &[&str] = &[
        "thinking…",
        "thinking...",
        "reasoning…",
        "reasoning...",
        "planning next",
        "considering",
    ];
    MARKERS.iter().any(|m| tail_lower.contains(m))
}

/// 获取 Windows Build Number（用于 xterm.js windowsPty 配置）
#[cfg(windows)]
pub fn get_windows_build_number() -> u32 {
    use std::mem::{self, MaybeUninit};
    use windows::Win32::System::SystemInformation::{GetVersionExW, OSVERSIONINFOW};
    unsafe {
        let mut info: OSVERSIONINFOW = MaybeUninit::zeroed().assume_init();
        info.dwOSVersionInfoSize = mem::size_of::<OSVERSIONINFOW>() as u32;
        let _ = GetVersionExW(&mut info);
        info.dwBuildNumber
    }
}

#[cfg(not(windows))]
pub fn get_windows_build_number() -> u32 {
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::provider::{Provider, ProviderModel, ProviderType};
    use crate::models::settings::CliLauncherOverride;
    use crate::services::SharedMcpService;

    /// PTY 是字节流，转义序列会被切在任意位置。`strip_ansi_escapes` 对未终止的序列是
    /// **整段吞掉**（连 ESC 一起），所以前半不可恢复、后半丢了前缀就当正文留下——
    /// 实测残渣形如 `8;248;242m`。必须在剥离**之前**把尾巴切出来 carry 到下个 chunk。
    #[test]
    fn carries_an_escape_sequence_split_across_chunks() {
        let mut buffer = OutputBuffer::new(64, 65536);

        // 同一个 \x1b[38;2;248;248;242m 被切成两半分别到达。
        buffer.push("hello\u{1b}[38;2;24");
        buffer.push("8;248;242mworld\n");

        let output = buffer.get_recent(0).join("\n");
        assert_eq!(output.trim_end(), "helloworld");
        assert!(
            !output.contains("8;248;242m"),
            "转义序列的后半被当成正文留下了：{output:?}"
        );
    }

    #[test]
    fn does_not_hold_output_hostage_for_a_stray_escape() {
        let mut buffer = OutputBuffer::new(64, 65536);

        // 孤立 ESC 后面跟着大量正文：攒满上限就该放行，不能无限扣着不吐。
        buffer.push("\u{1b}");
        buffer.push(&"x".repeat(MAX_CSI_CARRY * 2));
        buffer.push("\n");

        assert!(buffer.get_recent(0).join("\n").contains(&"x".repeat(64)));
    }

    /// OSC 可以很长：OSC 8 超链接带一条百余字符的 URL 就逼近旧的 128 上限，
    /// OSC 52 往剪贴板塞 1KB 更是 1300+ 字节。超限会退回「前半被吞、后半裸奔」，
    /// 所以字符串型转义必须单独给一档。
    #[test]
    fn carries_long_osc_sequences_that_would_bust_the_csi_limit() {
        let url = "x".repeat(600);
        let head = format!("\u{1b}]8;;https://example.com/{url}");
        assert_eq!(
            split_trailing_incomplete_escape(&head),
            ("", head.as_str()),
            "长 OSC 未终止时应整段 carry"
        );

        let mut buffer = OutputBuffer::new(64, 1 << 20);
        buffer.push(&format!("before{head}"));
        buffer.push("\u{7}link\n");

        let output = buffer.get_recent(0).join("\n");
        assert!(output.contains("beforelink"), "{output:?}");
        assert!(
            !output.contains("example.com"),
            "OSC 载荷漏成正文：{output:?}"
        );
    }

    #[test]
    fn still_bounds_the_carry_for_oversized_string_escapes() {
        let huge = format!("\u{1b}]52;c;{}", "A".repeat(MAX_STRING_ESCAPE_CARRY));
        assert_eq!(
            split_trailing_incomplete_escape(&huge).1,
            "",
            "超档应放行而非无限扣留"
        );
    }

    #[test]
    fn splits_only_genuinely_incomplete_escapes() {
        // 完整序列不该被切走——切了就会平白延迟一个 chunk 才输出。
        assert_eq!(
            split_trailing_incomplete_escape("a\u{1b}[0mb"),
            ("a\u{1b}[0mb", "")
        );
        assert_eq!(
            split_trailing_incomplete_escape("a\u{1b}[38;2;24"),
            ("a", "\u{1b}[38;2;24")
        );
        assert_eq!(split_trailing_incomplete_escape("a\u{1b}"), ("a", "\u{1b}"));
        // OSC 终止于 BEL 或 ST，没等到就是未完成。
        assert_eq!(
            split_trailing_incomplete_escape("a\u{1b}]0;title"),
            ("a", "\u{1b}]0;title")
        );
        assert_eq!(
            split_trailing_incomplete_escape("a\u{1b}]0;title\u{7}b"),
            ("a\u{1b}]0;title\u{7}b", "")
        );
        // 多字节字符不能被误切（ESC 是 ASCII，不会落在字符内部）。
        assert_eq!(
            split_trailing_incomplete_escape("中文测试"),
            ("中文测试", "")
        );
    }

    /// 前端会代答终端查询（CPR / DA / OSC 颜色）。回显开着时把回复写下去，它会变成
    /// 屏幕上的可见垃圾（`^[[1;1R` 这类），**并且**进入 slave 的输入队列污染下一个读
    /// stdin 的程序——Orca 那边的症状是 `gh auth login` 直接报 escape-sequence error 死掉。
    #[test]
    fn suppresses_a_query_reply_while_the_tty_echoes() {
        let (service, _temp_dir) = terminal_service_for_test();
        let writes = Arc::new(Mutex::new(Vec::new()));
        install_recording_session_with_echo(
            &service,
            "echo-on",
            writes.clone(),
            None,
            None,
            Some(true),
        );

        service
            .write_reply("echo-on", "\u{1b}[1;1R")
            .expect("write_reply");

        assert!(
            writes.lock().expect("writes").is_empty(),
            "回显开着时代答回复必须被抑制"
        );
    }

    /// ECHO 开而 ICANON 关时程序**读得到**回复（实测 slave 侧拿到完整 `\x1b[1;1R`），
    /// 那里抑制就是把它正等着的东西吞掉 —— 制造永久阻塞，比一串可见垃圾严重得多。
    /// 判据因此是 ECHO && ICANON，由 `cooked_echo_enabled` 一并判定。
    #[test]
    fn still_writes_query_replies_when_echo_is_off_or_unknown() {
        for (label, echo) in [("echo-off", Some(false)), ("echo-unknown", None)] {
            let (service, _temp_dir) = terminal_service_for_test();
            let writes = Arc::new(Mutex::new(Vec::new()));
            install_recording_session_with_echo(&service, label, writes.clone(), None, None, echo);

            service
                .write_reply(label, "\u{1b}[1;1R")
                .expect("write_reply");

            // 判不出来就照写：拿"不知道"当"是"会把子进程等着的 CPR 吞掉、令其永久阻塞。
            assert!(
                !writes.lock().expect("writes").is_empty(),
                "{label}: 回复不该被抑制"
            );
        }
    }

    /// 用户按键**不受**回显判定影响——cooked 提示符下打字本来就该被回显。
    #[test]
    fn user_input_is_never_suppressed_by_echo() {
        let (service, _temp_dir) = terminal_service_for_test();
        let writes = Arc::new(Mutex::new(Vec::new()));
        install_recording_session_with_echo(
            &service,
            "typing",
            writes.clone(),
            None,
            None,
            Some(true),
        );

        service.write("typing", "ls\r").expect("write");

        assert!(!writes.lock().expect("writes").is_empty());
    }

    /// `paste_ready` 只代表「观察到了 DECSET 2004」。Windows ConPTY 从不转发它，
    /// TUI 启动早期也来不及宣告——而 dispatch_task 注入 prompt 正是最常见路径。
    /// 那时把多行文本原样写下去，第一个换行就会把 composer 里停着的用户草稿提交出去。
    #[test]
    fn wraps_multiline_submit_for_a_tui_even_without_observed_paste_ready() {
        let (service, _temp_dir) = terminal_service_for_test();
        let writes = Arc::new(Mutex::new(Vec::new()));
        install_recording_session_full(
            &service,
            "agent",
            writes.clone(),
            None,
            None,
            None,
            CliTool::Claude,
        );

        service
            .submit_text_to_session("agent", "first line\nsecond line")
            .expect("submit");

        let joined = writes.lock().expect("writes").join("");
        assert!(joined.contains("\u{1b}[200~"), "未包括号粘贴：{joined:?}");
        assert!(joined.contains("\u{1b}[201~"), "缺结束标记：{joined:?}");
    }

    /// 纯 shell 期待的恰恰相反：多行就是多条命令，逐行执行才对。包上括号粘贴
    /// 只会让它把 `[200~` 当字面输入。
    #[test]
    fn leaves_multiline_submit_raw_for_a_plain_shell() {
        let (service, _temp_dir) = terminal_service_for_test();
        let writes = Arc::new(Mutex::new(Vec::new()));
        install_recording_session_full(
            &service,
            "shell",
            writes.clone(),
            None,
            None,
            None,
            CliTool::None,
        );

        service
            .submit_text_to_session("shell", "echo a\necho b")
            .expect("submit");

        let joined = writes.lock().expect("writes").join("");
        assert!(
            !joined.contains("\u{1b}[200~"),
            "纯 shell 不该被包裹：{joined:?}"
        );
    }

    /// 单行没有这个问题——没有内嵌换行就不会提前提交，保持原行为避免多余标记。
    #[test]
    fn leaves_single_line_submit_raw_without_paste_ready() {
        let (service, _temp_dir) = terminal_service_for_test();
        let writes = Arc::new(Mutex::new(Vec::new()));
        install_recording_session_full(
            &service,
            "agent",
            writes.clone(),
            None,
            None,
            None,
            CliTool::Claude,
        );

        service
            .submit_text_to_session("agent", "just one line")
            .expect("submit");

        let joined = writes.lock().expect("writes").join("");
        assert!(
            !joined.contains("\u{1b}[200~"),
            "单行不该被包裹：{joined:?}"
        );
    }

    /// spinner 帧靠光标控制原地刷新，ANSI 剥离后光标控制没了、帧首尾相接堆成巨行，
    /// 直到 partial 超 4KB 才 flush——漏一个词的后果是「要 200 行拿回上百万字符」。
    #[test]
    fn filters_the_simmering_spinner_frame() {
        assert!(is_spinner_line(
            "✻ Simmering… (12s · ↑ 1.2k tokens · esc to interrupt)"
        ));
        assert!(is_spinner_line("✽ Simmering…"));
        // 归一化后是 simering；词表里写原词 simmering 会永远匹配不上。
        // 词表比对走 starts_with；省略号不算装饰字符会被保留，故不是全等。
        assert_eq!(normalize_spinner_line("✻ Simmering…"), "simering…");
    }

    /// waitFor 参数的 schema 是 `Vec<String>`，客户端只能猜大小写——实测两个
    /// 不同的 agent 第一次都发了 `"Idle"`。alias 让两种写法都过；序列化端
    /// 必须保持 camelCase 不变（前端与 hook 通道都按它匹配）。
    #[test]
    fn session_status_accepts_both_cases_but_serializes_camel() {
        for (input, expected) in [
            ("\"idle\"", SessionStatus::Idle),
            ("\"Idle\"", SessionStatus::Idle),
            ("\"waitingInput\"", SessionStatus::WaitingInput),
            ("\"WaitingInput\"", SessionStatus::WaitingInput),
            ("\"toolRunning\"", SessionStatus::ToolRunning),
            ("\"ToolRunning\"", SessionStatus::ToolRunning),
            ("\"active\"", SessionStatus::Active),
            ("\"Active\"", SessionStatus::Active),
        ] {
            let parsed: SessionStatus = serde_json::from_str(input).unwrap();
            assert_eq!(parsed, expected, "input {input}");
        }
        assert_eq!(
            serde_json::to_string(&SessionStatus::WaitingInput).unwrap(),
            "\"waitingInput\""
        );
        assert_eq!(
            serde_json::to_string(&SessionStatus::Active).unwrap(),
            "\"active\""
        );
    }
    use crate::models::shared_mcp::{BridgeMode, SharedMcpServerConfig};
    use crate::services::{ProjectCliHooksService, ProviderService, SettingsService};
    use crate::utils::orchestrator_manifest::ORCHESTRATOR_MANIFEST_FILE;
    use crate::utils::AppPaths;
    use std::io;

    #[test]
    fn create_session_outcome_exposes_provider_default_model() {
        let provider = Provider {
            id: "anthropic-proxy".to_string(),
            name: "Anthropic Proxy".to_string(),
            provider_type: ProviderType::Anthropic,
            api_key: Some("test-secret".to_string()),
            base_url: Some("https://example.test".to_string()),
            region: None,
            project_id: None,
            aws_profile: None,
            config_dir: None,
            models: vec![ProviderModel {
                id: "provider-default".to_string(),
                label: None,
                default_effort: None,
                context_window_tokens: Some(200_000),
                context_size: None,
            }],
            default_model_id: Some("provider-default".to_string()),
            is_default: true,
        };
        let provider_plan = resolve_provider_plan(
            ProviderResolutionInput {
                cli_tool: CliTool::Claude,
                selection: LaunchProviderSelection::Inherit,
                requested_provider_id: None,
                requested_model_id: None,
                profile_provider_id: None,
                profile_model_id: None,
                workspace_provider_id: None,
                default_provider_id: Some("anthropic-proxy"),
                adapter_options: None,
            },
            &[provider],
            &CliToolRegistry::with_builtin_adapters(),
        )
        .expect("resolve provider default model");

        let outcome = create_session_outcome("session-1".to_string(), false, &provider_plan);

        assert_eq!(
            outcome.resolved_model_id.as_deref(),
            Some("provider-default")
        );
    }

    fn pi_rpc_test_service() -> (Arc<TerminalService>, tempfile::TempDir) {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let app_paths = Arc::new(AppPaths::new(Some(
            temp_dir.path().to_string_lossy().to_string(),
        )));
        let settings_service = Arc::new(SettingsService::new_with_config_path(
            temp_dir.path().join("config.toml"),
        ));
        let mut settings = settings_service.get_settings();
        settings.cli_launchers.overrides.insert(
            "pi".to_string(),
            CliLauncherOverride {
                command: "pi-test".to_string(),
            },
        );
        settings_service
            .update_settings(settings)
            .expect("configure Pi test launcher");
        let registry = Arc::new(CliToolRegistry::with_builtin_adapters());
        let service = Arc::new(TerminalService::new(
            settings_service,
            Arc::new(ProviderService::new(app_paths.providers_path())),
            app_paths,
            registry.clone(),
            Arc::new(ProjectCliHooksService::new(registry)),
            Arc::new(SshCredentialService::new_memory()),
        ));
        (service, temp_dir)
    }

    fn pi_rpc_request(project_path: &std::path::Path) -> CreateSessionRequest {
        CreateSessionRequest {
            launch_id: Some("launch-pi-rpc".to_string()),
            project_path: project_path.to_string_lossy().to_string(),
            cols: 120,
            rows: 32,
            workspace_name: None,
            provider_id: None,
            model_id: None,
            provider_selection: LaunchProviderSelection::None,
            launch_profile_id: None,
            workspace_path: None,
            workspace_snapshot_id: None,
            origin_layout_id: None,
            origin_tab_id: None,
            origin_terminal_pane_id: None,
            expected_saved_session_id: None,
            launch_claude: false,
            cli_tool: CliTool::Pi,
            resume_id: None,
            skip_mcp: false,
            append_system_prompt: Some("Use the project conventions.".to_string()),
            initial_prompt: Some("Do not put this in argv.".to_string()),
            yolo_mode: Some(true),
            adapter_options: Some(HashMap::from([
                ("piTransport".to_string(), serde_json::json!("rpc")),
                (
                    "piNativeProvider".to_string(),
                    serde_json::json!("anthropic"),
                ),
                (
                    "piNativeModel".to_string(),
                    serde_json::json!("claude-sonnet"),
                ),
                ("piProjectTrust".to_string(), serde_json::json!("approve")),
                ("piSessionName".to_string(), serde_json::json!("RPC test")),
            ])),
            extra_env: None,
            ssh: None,
            wsl: None,
        }
    }

    #[test]
    fn pi_rpc_launch_spec_uses_adapter_resolution_without_prompt_in_argv() {
        let (service, temp_dir) = pi_rpc_test_service();
        let request = pi_rpc_request(temp_dir.path());

        let spec = service
            .build_pi_rpc_launch_spec(&request)
            .expect("build local Pi RPC launch spec");

        assert_eq!(spec.command, "pi-test");
        assert_eq!(spec.cwd, temp_dir.path().to_string_lossy());
        assert_eq!(
            spec.args,
            vec![
                "--mode",
                "rpc",
                "--provider",
                "anthropic",
                "--model",
                "claude-sonnet",
                "--append-system-prompt",
                "Use the project conventions.",
                "--name",
                "RPC test",
                "--approve",
            ]
        );
        assert!(!spec
            .args
            .iter()
            .any(|arg| arg.contains("Do not put this in argv.")));
        assert_eq!(
            spec.env.get("CC_PANES_LAUNCH_ID").map(String::as_str),
            Some("launch-pi-rpc")
        );
        assert!(!spec.args.iter().any(|arg| arg == "--api-key"));
        assert!(spec.managed_state_cleanup.is_none());
    }

    #[test]
    fn pi_rpc_launch_spec_injects_managed_credentials_only_into_environment() {
        let (service, temp_dir) = pi_rpc_test_service();
        service
            .provider_service
            .add_provider(Provider {
                id: "openai-pi".to_string(),
                name: "OpenAI for Pi".to_string(),
                provider_type: ProviderType::OpenAI,
                api_key: Some("test-managed-secret".to_string()),
                base_url: None,
                region: None,
                project_id: None,
                aws_profile: None,
                config_dir: None,
                models: vec![ProviderModel {
                    id: "gpt-5-test".to_string(),
                    label: None,
                    default_effort: None,
                    context_window_tokens: None,
                    context_size: None,
                }],
                default_model_id: Some("gpt-5-test".to_string()),
                is_default: false,
            })
            .expect("add managed provider");
        let mut request = pi_rpc_request(temp_dir.path());
        request.provider_selection = LaunchProviderSelection::Explicit;
        request.provider_id = Some("openai-pi".to_string());
        request.model_id = None;
        request.adapter_options = Some(HashMap::from([(
            "piTransport".to_string(),
            serde_json::json!("rpc"),
        )]));
        request.extra_env = Some(HashMap::from([
            ("CODEX_API_KEY".to_string(), "wrong-extra-key".to_string()),
            (
                "OPENAI_BASE_URL".to_string(),
                "https://wrong-extra-endpoint.example/v1".to_string(),
            ),
            ("OPENAI_API_KEY".to_string(), "wrong-extra-key".to_string()),
        ]));

        let spec = service
            .build_pi_rpc_launch_spec(&request)
            .expect("build managed Pi RPC launch spec");

        assert!(spec
            .args
            .windows(2)
            .any(|pair| pair == ["--provider", "openai"]));
        assert!(spec
            .args
            .windows(2)
            .any(|pair| pair == ["--model", "gpt-5-test"]));
        assert_eq!(
            spec.env.get("OPENAI_API_KEY").map(String::as_str),
            Some("test-managed-secret")
        );
        assert!(!spec.env.contains_key("CODEX_API_KEY"));
        assert!(!spec.env.contains_key("OPENAI_BASE_URL"));
        assert!(spec.env_remove.iter().any(|key| key == "OPENAI_API_KEY"));
        assert!(!spec
            .args
            .iter()
            .any(|arg| arg.contains("test-managed-secret")));
        assert!(spec.managed_state_cleanup.is_some());
    }

    #[test]
    fn pi_rpc_launch_publishes_explicit_skills_to_the_managed_agent_root() {
        let (service, temp_dir) = pi_rpc_test_service();
        let templates_dir = temp_dir
            .path()
            .join("resource")
            .join("resources")
            .join("claude-bundle")
            .join("default-skills");
        std::fs::create_dir_all(&templates_dir).expect("create Pi skill templates");
        std::fs::write(
            templates_dir.join("manifest.json"),
            r#"{
                "schemaVersion": 2,
                "namespace": "ccpanes",
                "skills": [{
                    "name": "pi-check",
                    "file": "pi-check.md",
                    "delivery": {
                        "portable": true,
                        "modes": ["piSkill"],
                        "requiresCcpanesMcp": false
                    }
                }]
            }"#,
        )
        .expect("write Pi skill manifest");
        std::fs::write(
            templates_dir.join("pi-check.md"),
            "---\nname: ccpanes-pi-check\ndescription: Verify managed Pi Skill publication.\n---\n# Pi check\n",
        )
        .expect("write Pi skill template");
        service.set_sidecar_resource_dir(temp_dir.path().join("resource"));
        service
            .provider_service
            .add_provider(Provider {
                id: "openai-pi".to_string(),
                name: "OpenAI for Pi".to_string(),
                provider_type: ProviderType::OpenAI,
                api_key: Some("test-managed-secret".to_string()),
                base_url: None,
                region: None,
                project_id: None,
                aws_profile: None,
                config_dir: None,
                models: vec![ProviderModel {
                    id: "gpt-5-test".to_string(),
                    label: None,
                    default_effort: None,
                    context_window_tokens: None,
                    context_size: None,
                }],
                default_model_id: Some("gpt-5-test".to_string()),
                is_default: false,
            })
            .expect("add managed provider");
        let mut request = pi_rpc_request(temp_dir.path());
        request.provider_selection = LaunchProviderSelection::Explicit;
        request.provider_id = Some("openai-pi".to_string());
        request.adapter_options = Some(HashMap::from([(
            "piTransport".to_string(),
            serde_json::json!("rpc"),
        )]));

        let spec = service
            .build_pi_rpc_launch_spec(&request)
            .expect("build managed Pi RPC launch spec");
        let agent_root = spec
            .env
            .get(cc_cli_adapters::PI_CODING_AGENT_DIR_ENV)
            .expect("managed Pi agent root");

        assert_eq!(
            std::path::PathBuf::from(agent_root),
            cc_cli_adapters::pi_managed_state_dir(temp_dir.path(), "launch-pi-rpc")
        );
        assert!(std::path::Path::new(agent_root)
            .join("skills")
            .join("ccpanes-pi-check")
            .join("SKILL.md")
            .is_file());
    }

    #[test]
    fn pi_rpc_rejects_non_local_and_pty_transports() {
        let (service, temp_dir) = pi_rpc_test_service();
        let mut wsl_request = pi_rpc_request(temp_dir.path());
        wsl_request.wsl = Some(WslLaunchInfo {
            remote_path: "/workspace/pi".to_string(),
            workspace_remote_path: None,
            distro: Some("Ubuntu".to_string()),
        });
        let error = service
            .build_pi_rpc_launch_spec(&wsl_request)
            .expect_err("WSL RPC must be rejected explicitly");
        assert_eq!(error.code(), Some("PI_RPC_LOCAL_ONLY"));

        let mut pty_request = pi_rpc_request(temp_dir.path());
        pty_request.adapter_options = Some(HashMap::from([(
            "piTransport".to_string(),
            serde_json::json!("rpc"),
        )]));
        let error =
            match <TerminalService as crate::services::TerminalBackend>::create_session_with_outcome(
                service.as_ref(),
                pty_request,
            ) {
                Ok(_) => panic!("Pi RPC transport must not start a PTY session"),
                Err(error) => error,
            };
        assert_eq!(error.code(), Some("PI_RPC_PTY_UNSUPPORTED"));
    }

    #[test]
    fn portable_bundled_skills_fall_back_to_session_prompt_only_without_native_delivery() {
        let registry = CliToolRegistry::with_builtin_adapters();

        assert!(uses_portable_skill_session_prompt_fallback(
            &registry,
            CliTool::Grok
        ));
        assert!(uses_portable_skill_session_prompt_fallback(
            &registry,
            CliTool::Opencode
        ));
        for cli_tool in [
            CliTool::Claude,
            CliTool::Codex,
            CliTool::Gemini,
            CliTool::Kimi,
            CliTool::Glm,
            CliTool::Cursor,
            CliTool::None,
        ] {
            assert!(
                !uses_portable_skill_session_prompt_fallback(&registry, cli_tool),
                "{cli_tool:?} should not use the session-prompt fallback"
            );
        }
    }

    #[test]
    fn session_only_adapter_receives_selected_portable_bundled_skills() {
        let (service, temp_dir) = terminal_service_for_test_with_registry(Arc::new(
            CliToolRegistry::with_builtin_adapters(),
        ));
        let resource_dir = temp_dir.path().join("resource");
        let templates_dir = resource_dir
            .join("resources")
            .join("claude-bundle")
            .join("default-skills");
        std::fs::create_dir_all(&templates_dir).unwrap();
        std::fs::write(
            templates_dir.join("manifest.json"),
            r#"{
                "schemaVersion": 2,
                "namespace": "ccpanes",
                "skills": [{
                    "name": "dispatch-task",
                    "file": "dispatch-task.md",
                    "delivery": {
                        "portable": true,
                        "modes": ["sessionPrompt"],
                        "requiresCcpanesMcp": true
                    }
                }]
            }"#,
        )
        .unwrap();
        std::fs::write(
            templates_dir.join("dispatch-task.md"),
            "---\nname: ccpanes-dispatch-task\n---\n# Dispatch\nUse the shared protocol.",
        )
        .unwrap();
        service.set_sidecar_resource_dir(resource_dir);

        let prompt = service
            .portable_bundled_skill_prompt(CliTool::Grok, None, true)
            .expect("Grok should receive the session-prompt fallback");
        assert!(prompt.contains("## ccpanes-dispatch-task\n# Dispatch"));
        assert!(service
            .portable_bundled_skill_prompt(CliTool::Grok, None, false)
            .is_none());
        assert!(service
            .portable_bundled_skill_prompt(CliTool::Codex, None, true)
            .is_none());
    }

    #[test]
    fn ssh_remote_cli_command_applies_yolo_and_codex_semantics() {
        // Claude：非 YOLO 不加标志；YOLO 加 skip-permissions。
        assert_eq!(
            TerminalService::ssh_remote_cli_command(CliTool::Claude, false),
            "claude"
        );
        assert_eq!(
            TerminalService::ssh_remote_cli_command(CliTool::Claude, true),
            "claude --dangerously-skip-permissions"
        );
        // Codex：非 YOLO 用 --full-auto；YOLO 换成 bypass（已蕴含 full-auto，故有意不叠加）。
        assert_eq!(
            TerminalService::ssh_remote_cli_command(CliTool::Codex, false),
            "codex --full-auto"
        );
        assert_eq!(
            TerminalService::ssh_remote_cli_command(CliTool::Codex, true),
            "codex --dangerously-bypass-approvals-and-sandbox"
        );
        // None 走交互 shell；YOLO 对其他 CLI 不追加未知参数。
        assert_eq!(
            TerminalService::ssh_remote_cli_command(CliTool::None, false),
            "exec $SHELL -l"
        );
        assert_eq!(
            TerminalService::ssh_remote_cli_command(CliTool::Gemini, true),
            "gemini"
        );
        // Grok：非 YOLO 不加标志；YOLO 加 --always-approve。
        assert_eq!(
            TerminalService::ssh_remote_cli_command(CliTool::Grok, false),
            "grok"
        );
        assert_eq!(
            TerminalService::ssh_remote_cli_command(CliTool::Grok, true),
            "grok --always-approve"
        );
    }

    #[test]
    fn should_issue_session_id_follows_adapter_capability() {
        let registry = CliToolRegistry::with_builtin_adapters();

        // claude / grok 声明支持发号；codex 走 OSC 捕获通道，不发号。
        assert!(TerminalService::should_issue_session_id(
            &registry,
            CliTool::Claude,
            None
        ));
        assert!(TerminalService::should_issue_session_id(
            &registry,
            CliTool::Grok,
            None
        ));
        assert!(!TerminalService::should_issue_session_id(
            &registry,
            CliTool::Codex,
            None
        ));
        // resume 场景复用原 id，一律不发号。
        assert!(!TerminalService::should_issue_session_id(
            &registry,
            CliTool::Claude,
            Some("existing-id")
        ));
        // 未注册的 CLI（None）不发号。
        assert!(!TerminalService::should_issue_session_id(
            &registry,
            CliTool::None,
            None
        ));
    }

    /// `echo` = 「真 cooked（ECHO && ICANON）」。`None` 表示无从判断——非 Unix /
    /// SSH 通道就是这种，
    /// 抑制逻辑此时必须放行，不能拿"不知道"当"回显开着"。
    #[derive(Default)]
    struct FakePtyProcess {
        echo: Option<bool>,
    }

    impl PtyProcess for FakePtyProcess {
        fn resize(&self, _cols: u16, _rows: u16) -> Result<()> {
            Ok(())
        }

        fn pid(&self) -> u32 {
            1
        }

        fn wait(&self) -> Result<std::process::ExitStatus> {
            Err(anyhow!("fake process does not wait"))
        }

        fn kill(&self) -> Result<()> {
            Ok(())
        }

        fn cooked_echo_enabled(&self) -> Option<bool> {
            self.echo
        }
    }

    struct RecordingWriter {
        writes: Arc<Mutex<Vec<String>>>,
    }

    impl Write for RecordingWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.writes
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(String::from_utf8_lossy(buf).to_string());
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn terminal_service_for_test() -> (Arc<TerminalService>, tempfile::TempDir) {
        terminal_service_for_test_with_registry(Arc::new(CliToolRegistry::new()))
    }

    fn terminal_service_for_test_with_registry(
        cli_registry: Arc<CliToolRegistry>,
    ) -> (Arc<TerminalService>, tempfile::TempDir) {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let app_paths = Arc::new(AppPaths::new(Some(
            temp_dir.path().to_string_lossy().to_string(),
        )));
        let service = Arc::new(TerminalService::new(
            Arc::new(SettingsService::new()),
            Arc::new(ProviderService::new(app_paths.providers_path())),
            app_paths,
            cli_registry.clone(),
            Arc::new(ProjectCliHooksService::new(cli_registry)),
            Arc::new(SshCredentialService::new_memory()),
        ));
        (service, temp_dir)
    }

    #[test]
    fn effective_shared_mcp_urls_prefer_override_and_preserve_empty_state() {
        let (service, temp_dir) = terminal_service_for_test();
        let shared_paths = AppPaths::new(Some(temp_dir.path().to_string_lossy().to_string()));
        let shared_service = Arc::new(SharedMcpService::new(&shared_paths));
        service.set_shared_mcp_service(shared_service.clone());

        let fallback = service.resolve_effective_shared_mcp_urls(
            Some(shared_service.as_ref()),
            None,
            None,
            CliTool::Claude,
            "local",
            false,
        );
        assert!(
            fallback.is_empty(),
            "empty running map should be the fallback"
        );

        let pushed = HashMap::from([
            (
                "wechat".to_string(),
                "http://127.0.0.1:3100/mcp".to_string(),
            ),
            (
                "chrome".to_string(),
                "http://127.0.0.1:3106/mcp".to_string(),
            ),
        ]);
        service.set_shared_mcp_url_override(Some(pushed.clone()));
        assert_eq!(
            service.resolve_effective_shared_mcp_urls(
                Some(shared_service.as_ref()),
                None,
                None,
                CliTool::Claude,
                "local",
                false,
            ),
            pushed
        );

        service.set_shared_mcp_url_override(Some(HashMap::new()));
        assert!(service
            .resolve_effective_shared_mcp_urls(
                Some(shared_service.as_ref()),
                None,
                None,
                CliTool::Claude,
                "local",
                false,
            )
            .is_empty());
    }

    #[test]
    fn effective_shared_mcp_urls_keep_profile_filtering_for_override() {
        let (service, temp_dir) = terminal_service_for_test();
        let profile_service = Arc::new(LaunchProfileService::new(
            temp_dir.path().join("launch-profiles.json"),
        ));
        let profile = profile_service
            .create_profile(crate::models::launch_profile::LaunchProfileDraft {
                name: Some("Disable one shared MCP".to_string()),
                alias: None,
                description: None,
                provider_id: None,
                model_id: None,
                adapter_options: HashMap::new(),
                target_tools: vec!["claude".to_string()],
                target_runtime: None,
                yolo_mode: false,
                mcp_policy: crate::models::launch_profile::LaunchProfileMcpPolicy {
                    disabled_server_ids: vec!["disabled".to_string()],
                    ..Default::default()
                },
                skill_policy: Default::default(),
                is_default: false,
            })
            .expect("create launch profile");
        service.set_launch_profile_service(profile_service);
        service.set_shared_mcp_url_override(Some(HashMap::from([
            (
                "enabled-a".to_string(),
                "http://127.0.0.1:3100/mcp".to_string(),
            ),
            (
                "disabled".to_string(),
                "http://127.0.0.1:3101/mcp".to_string(),
            ),
            (
                "enabled-b".to_string(),
                "http://127.0.0.1:3102/mcp".to_string(),
            ),
        ])));

        let resolved = service.resolve_effective_shared_mcp_urls(
            None,
            Some(&profile.id),
            None,
            CliTool::Claude,
            "local",
            false,
        );
        assert_eq!(resolved.len(), 2);
        assert!(!resolved.contains_key("disabled"));
        assert!(resolved.contains_key("enabled-a"));
        assert!(resolved.contains_key("enabled-b"));
    }

    #[test]
    fn kill_reason_serde_roundtrip_and_unknown_fallback() {
        assert_eq!(
            serde_json::to_string(&KillReason::OrphanReclaim).unwrap(),
            r#""orphan-reclaim""#
        );
        assert_eq!(
            serde_json::from_str::<KillReason>(r#""daemon-reaper""#).unwrap(),
            KillReason::DaemonReaper
        );
        // 未来新增的 reason 字符串必须落 Unknown 而不是反序列化失败
        assert_eq!(
            serde_json::from_str::<KillReason>(r#""provider-switch""#).unwrap(),
            KillReason::Unknown
        );

        assert_eq!(KillReason::parse(Some("mcp")), KillReason::Mcp);
        assert_eq!(KillReason::parse(Some("user-close")), KillReason::UserClose);
        assert_eq!(KillReason::parse(Some("bogus")), KillReason::Unknown);
        assert_eq!(KillReason::parse(None), KillReason::Unknown);
        assert_eq!(KillReason::OrphanReclaim.as_str(), "orphan-reclaim");
    }

    /// 合批规格模拟：与 `spawn_pty` 里的批量合并线程同构（16KB 阈值 / 超时 /
    /// 断开三条刷出路径），返回每次 emit 的 `(data, end_seq)`。
    ///
    /// 真身是 `spawn_pty` 内联的 `thread::spawn` 闭包，取不出来单测，故在这里
    /// 锁规格，另配一条扫源码守卫盯住接线。
    fn simulate_output_batching(chunks: Vec<(&str, Option<u64>)>) -> Vec<(String, Option<u64>)> {
        const BATCH_SIZE_THRESHOLD: usize = 16384;

        let mut emits = Vec::new();
        let mut batch = String::new();
        let mut batch_end_seq: Option<u64> = None;

        for (data, end_seq) in chunks {
            batch.push_str(data);
            batch_end_seq = end_seq;
            if batch.len() >= BATCH_SIZE_THRESHOLD {
                emits.push((std::mem::take(&mut batch), batch_end_seq.take()));
            }
        }
        // 收尾等价于 timeout / disconnected 两条路径
        if !batch.is_empty() {
            emits.push((std::mem::take(&mut batch), batch_end_seq.take()));
        }
        emits
    }

    /// 不变式：`batch_end_seq` 恒等于**批内最后一个 chunk** 的 end seq。
    ///
    /// 这是「前端见到的任何 endSeq 必落 chunk 边界」的上游保证——checkpoint
    /// 的 anchor 就锚在这个 seq 上。若合批取成了首个 chunk 的 seq（或不更新），
    /// anchor 会指到批中段的字节位置：daemon 侧按 anchor 裁 delta 时要么少发
    /// （画面缺一段）要么多发（重复渲染），且**只在一批装进多个 chunk 时**发生
    /// ——低吞吐时一批一 chunk，测不出来，正好躲过日常使用。
    #[test]
    fn batch_end_seq_is_always_the_last_chunk_in_the_batch() {
        // 低吞吐：每个 chunk 各自成批，end seq 逐一对应
        let emits = simulate_output_batching(vec![("a", Some(1)), ("b", Some(2))]);
        assert_eq!(
            emits,
            vec![("ab".to_string(), Some(2))],
            "同批多 chunk 必须取最后一个 chunk 的 seq"
        );

        // 跨越 16KB 阈值：第一批在阈值处刷出，其 end seq 是让它越线的那个 chunk
        let big = "x".repeat(16384);
        let emits = simulate_output_batching(vec![
            ("head", Some(10)),
            (big.as_str(), Some(11)),
            ("tail", Some(12)),
        ]);
        assert_eq!(emits.len(), 2);
        assert_eq!(emits[0].1, Some(11), "阈值批的 seq 必须是越线的那个 chunk");
        assert_eq!(emits[1].1, Some(12), "残留批的 seq 是最后一个 chunk");
        assert_eq!(
            emits.iter().map(|(data, _)| data.len()).sum::<usize>(),
            "head".len() + big.len() + "tail".len(),
            "合批不得丢字节"
        );

        // 旧 daemon 不发 seq：末位为 None 时整批就是 None，不得回退到前一个
        // chunk 的 seq——那会让 anchor 指向本批没覆盖到的位置。
        let emits = simulate_output_batching(vec![("a", Some(1)), ("b", None)]);
        assert_eq!(emits, vec![("ab".to_string(), None)]);
    }

    /// 接线守卫：三条刷出路径都必须 `batch_end_seq.take()`。
    /// 少 take 一处，下一批会带着上一批的 seq 发出（陈旧 anchor）。
    #[test]
    fn all_three_batch_flush_paths_take_the_batch_end_seq() {
        let source = include_str!("terminal_service.rs");
        // 切的是**测试模块**的起点，不是任意 `#[cfg(test)]`——production 段里
        // 允许有 `#[cfg(test)]` 的测试辅助方法（如 `*_for_test` 读取器），
        // 用裸属性切会在第一个辅助方法处提前截断，让本守卫报
        // 「batching thread must exist」而看着像批处理线程被删了。
        let production = source
            .split("#[cfg(test)]\nmod tests {")
            .next()
            .expect("production section");
        let batching = production
            .split("let mut batch_end_seq: Option<u64> = None;")
            .nth(1)
            .expect("batching thread must exist")
            .split("// Codex 会话")
            .next()
            .expect("batching thread body");

        assert_eq!(
            batching.matches("batch_end_seq.take()").count(),
            3,
            "三条刷出路径（16KB 阈值 / 超时 / 断开）都必须 take，少一处就发陈旧 anchor"
        );
        assert_eq!(
            batching.matches("batch_end_seq = ").count(),
            2,
            "recv 与排空 try_recv 两处都必须更新为最新 chunk 的 seq"
        );
    }

    /// KillReason 穷举守卫（同 boundary_events 的 origin 表手法）。
    ///
    /// `parse` 的 `_ => Unknown` 兜底会把**漏接的新变体**静默吞成 Unknown：
    /// 加了变体、`as_str` 也写了，但忘了在 `parse` 加分支——kill 事件带着
    /// 正确的字符串跨进程发出去，收端解析成 Unknown，前端于是按「来源不明」
    /// 处理（该关的标签不关 / 该留的留不住），全程零报错。
    /// 这张表逼着新增变体时同步两侧：往枚举加一项而不更表，穷举检查即失败。
    #[test]
    fn kill_reason_parse_and_as_str_round_trip_for_every_variant() {
        let all = [
            (KillReason::UserClose, "user-close"),
            (KillReason::Mcp, "mcp"),
            (KillReason::OrphanReclaim, "orphan-reclaim"),
            (KillReason::DaemonReaper, "daemon-reaper"),
            (KillReason::LaunchTimeout, "launch-timeout"),
            (KillReason::Unknown, "unknown"),
        ];

        for (reason, text) in all {
            assert_eq!(reason.as_str(), text, "{reason:?} 的 as_str 不匹配");
            // Unknown 的 as_str 是 "unknown"，但它不是可解析的输入词——
            // 它就是兜底本身，parse 回来仍是 Unknown，往返闭合。
            assert_eq!(
                KillReason::parse(Some(text)),
                reason,
                "{reason:?} 的 parse↔as_str 往返断裂：新变体八成漏加 parse 分支"
            );
            // serde 侧同款往返（kebab-case 与 as_str 必须一致，跨进程靠它）
            assert_eq!(
                serde_json::to_string(&reason).unwrap(),
                format!("\"{text}\""),
                "{reason:?} 的 serde 表示与 as_str 不一致"
            );
            assert_eq!(
                serde_json::from_str::<KillReason>(&format!("\"{text}\"")).unwrap(),
                reason
            );
        }

        // 穷举性检查：`match` 覆盖全部变体，新增变体不更新上表就编译不过。
        fn assert_exhaustive(reason: KillReason) -> &'static str {
            match reason {
                KillReason::UserClose => "user-close",
                KillReason::Mcp => "mcp",
                KillReason::OrphanReclaim => "orphan-reclaim",
                KillReason::DaemonReaper => "daemon-reaper",
                KillReason::LaunchTimeout => "launch-timeout",
                KillReason::Unknown => "unknown",
            }
        }
        for (reason, text) in all {
            assert_eq!(assert_exhaustive(reason), text);
        }
        assert_eq!(
            all.len(),
            6,
            "新增了 KillReason 变体：请同步补进本表与 parse/as_str 两侧"
        );
    }

    #[test]
    fn kill_with_reason_keeps_not_found_semantics_for_missing_session() {
        let (service, _temp_dir) = terminal_service_for_test();

        let error = service
            .kill_with_reason("missing-session", KillReason::OrphanReclaim)
            .expect_err("missing session must error");

        assert!(matches!(error, AppError::NotFound(_)));
    }

    #[test]
    fn kill_with_reason_forces_state_machine_to_exited() {
        let (service, _temp_dir) = terminal_service_for_test();
        let state_machine = Arc::new(crate::services::SessionStateMachine::new());
        service.set_state_machine(state_machine.clone());
        install_recording_session(&service, "session-kill", Arc::new(Mutex::new(Vec::new())));
        state_machine.on_event(
            "session-kill",
            &cc_cli_adapters::CcPaneEvent::PromptBefore,
            None,
            &serde_json::json!({}),
        );

        service
            .kill_with_reason("session-kill", KillReason::Mcp)
            .expect("kill session");

        assert_eq!(
            state_machine
                .snapshot("session-kill")
                .expect("state entry")
                .status,
            SessionStatus::Exited
        );
    }

    fn managed_pi_state_cleanup_for_test(
        data_dir: &std::path::Path,
        session_id: &str,
    ) -> (PiManagedStateCleanup, PathBuf) {
        let state_dir = cc_cli_adapters::pi_managed_state_dir(data_dir, session_id);
        std::fs::create_dir_all(&state_dir).expect("create managed Pi state directory");
        std::fs::write(state_dir.join("state.json"), "test").expect("write managed Pi state");
        (
            PiManagedStateCleanup::new(data_dir.to_path_buf(), session_id),
            state_dir,
        )
    }

    #[test]
    fn pending_pi_managed_state_cleanup_removes_pre_registration_state() {
        let (_service, temp_dir) = terminal_service_for_test();
        let (cleanup, state_dir) =
            managed_pi_state_cleanup_for_test(temp_dir.path(), "pending-pi-state");

        {
            let _pending = PendingPiManagedStateCleanup::new(Some(cleanup));
            assert!(state_dir.is_dir());
        }

        assert!(!state_dir.exists());
    }

    #[test]
    fn kill_with_reason_cleans_managed_pi_state() {
        let (service, temp_dir) = terminal_service_for_test();
        let (cleanup, state_dir) = managed_pi_state_cleanup_for_test(temp_dir.path(), "pi-kill");
        install_recording_session_with_launch_id_and_cleanup(
            &service,
            "pi-kill",
            Arc::new(Mutex::new(Vec::new())),
            None,
            Some(cleanup),
        );

        service
            .kill_with_reason("pi-kill", KillReason::UserClose)
            .expect("kill managed Pi session");

        assert!(!state_dir.exists());
    }

    #[test]
    fn cleanup_all_cleans_managed_pi_state() {
        let (service, temp_dir) = terminal_service_for_test();
        let (cleanup, state_dir) =
            managed_pi_state_cleanup_for_test(temp_dir.path(), "pi-cleanup-all");
        install_recording_session_with_launch_id_and_cleanup(
            &service,
            "pi-cleanup-all",
            Arc::new(Mutex::new(Vec::new())),
            None,
            Some(cleanup),
        );

        service.cleanup_all();

        assert!(!state_dir.exists());
    }

    fn write_orchestrator_manifest(data_dir: &std::path::Path, port: u16, token: &str) {
        std::fs::write(
            data_dir.join(ORCHESTRATOR_MANIFEST_FILE),
            format!(
                r#"{{"mcpServers":{{"ccpanes":{{"type":"http","url":"http://127.0.0.1:{port}/mcp?token={token}","headers":{{"Authorization":"Bearer {token}"}}}}}}}}"#
            ),
        )
        .expect("write orchestrator manifest");
    }

    #[test]
    fn healthy_orchestrator_info_drops_unreachable_port() {
        let (service, _temp_dir) = terminal_service_for_test();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind test port");
        let port = listener.local_addr().expect("listener addr").port();
        drop(listener);

        service.set_orchestrator_info(port, "token".to_string());

        assert!(service.healthy_orchestrator_info().is_none());
        assert!(service
            .orchestrator_info
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .is_none());
    }

    /// 起一个只回 `/api/health` → `{"status":"ok"}` 的极简 HTTP 监听器，
    /// 供 reachability 探针把它识别为「我们自己的 orchestrator」。线程随进程存活。
    fn spawn_health_listener() -> u16 {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind health port");
        let port = listener.local_addr().expect("listener addr").port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut buf = [0_u8; 512];
                let _ = stream.read(&mut buf);
                let body = "{\"status\":\"ok\"}";
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes());
            }
        });
        port
    }

    #[test]
    fn healthy_orchestrator_info_keeps_reachable_port() {
        let (service, _temp_dir) = terminal_service_for_test();
        let port = spawn_health_listener();

        service.set_orchestrator_info(port, "token".to_string());

        let info = service
            .healthy_orchestrator_info()
            .expect("reachable orchestrator info");
        assert_eq!(info.port, port);
        assert_eq!(info.token, "token");
    }

    #[test]
    fn healthy_orchestrator_info_falls_back_to_manifest() {
        let (service, temp_dir) = terminal_service_for_test();
        let port = spawn_health_listener();
        write_orchestrator_manifest(temp_dir.path(), port, "manifest-token");

        let info = service
            .healthy_orchestrator_info()
            .expect("manifest orchestrator info");
        assert_eq!(info.port, port);
        assert_eq!(info.token, "manifest-token");
        assert_eq!(
            service
                .orchestrator_info
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .as_ref()
                .map(|info| info.token.as_str()),
            Some("manifest-token")
        );
    }

    #[test]
    fn healthy_orchestrator_info_prefers_fresh_manifest_over_stale_cache() {
        let (service, temp_dir) = terminal_service_for_test();
        let stale_listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind stale port");
        let stale_port = stale_listener.local_addr().expect("listener addr").port();
        drop(stale_listener);
        service.set_orchestrator_info(stale_port, "stale-token".to_string());

        let port = spawn_health_listener();
        write_orchestrator_manifest(temp_dir.path(), port, "manifest-token");

        let info = service
            .healthy_orchestrator_info()
            .expect("manifest orchestrator info");
        assert_eq!(info.port, port);
        assert_eq!(info.token, "manifest-token");
    }

    #[test]
    fn healthy_orchestrator_info_manifest_wins_same_port_token_rotation() {
        let (service, temp_dir) = terminal_service_for_test();
        let port = spawn_health_listener();
        service.set_orchestrator_info(port, "old-token".to_string());
        write_orchestrator_manifest(temp_dir.path(), port, "new-token");

        let info = service
            .healthy_orchestrator_info()
            .expect("manifest orchestrator info");
        assert_eq!(info.port, port);
        assert_eq!(info.token, "new-token");
    }

    fn install_recording_session(
        service: &TerminalService,
        session_id: &str,
        writes: Arc<Mutex<Vec<String>>>,
    ) {
        install_recording_session_with_launch_id(service, session_id, writes, None);
    }

    fn set_recording_session_paste_ready(service: &TerminalService, session_id: &str) {
        let sessions = service
            .sessions
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        sessions
            .get(session_id)
            .expect("recording session")
            .paste_ready
            .store(true, Ordering::Release);
    }

    fn install_recording_session_with_launch_id(
        service: &TerminalService,
        session_id: &str,
        writes: Arc<Mutex<Vec<String>>>,
        launch_id: Option<&str>,
    ) {
        install_recording_session_with_launch_id_and_cleanup(
            service, session_id, writes, launch_id, None,
        );
    }

    fn install_recording_session_with_launch_id_and_cleanup(
        service: &TerminalService,
        session_id: &str,
        writes: Arc<Mutex<Vec<String>>>,
        launch_id: Option<&str>,
        managed_pi_state_cleanup: Option<PiManagedStateCleanup>,
    ) {
        install_recording_session_with_echo(
            service,
            session_id,
            writes,
            launch_id,
            managed_pi_state_cleanup,
            None,
        );
    }

    fn install_recording_session_with_echo(
        service: &TerminalService,
        session_id: &str,
        writes: Arc<Mutex<Vec<String>>>,
        launch_id: Option<&str>,
        managed_pi_state_cleanup: Option<PiManagedStateCleanup>,
        pty_echo: Option<bool>,
    ) {
        install_recording_session_full(
            service,
            session_id,
            writes,
            launch_id,
            managed_pi_state_cleanup,
            pty_echo,
            CliTool::None,
        );
    }

    /// `session_cli_tool` 决定 submit 时是否把目标当作带 composer 的 TUI。
    fn install_recording_session_full(
        service: &TerminalService,
        session_id: &str,
        writes: Arc<Mutex<Vec<String>>>,
        launch_id: Option<&str>,
        managed_pi_state_cleanup: Option<PiManagedStateCleanup>,
        pty_echo: Option<bool>,
        session_cli_tool: CliTool,
    ) {
        let writer_tx =
            spawn_terminal_writer(session_id.to_string(), Box::new(RecordingWriter { writes }));
        service
            .sessions
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(
                session_id.to_string(),
                TerminalSession {
                    launch_id: launch_id.map(str::to_string),
                    project_path: "/repo".to_string(),
                    runtime_kind: "local".to_string(),
                    cli_tool: session_cli_tool,
                    process: Arc::new(FakePtyProcess { echo: pty_echo }),
                    writer_tx,
                    status: Arc::new(Mutex::new(SessionStatus::Idle)),
                    exit_code: Arc::new(Mutex::new(None)),
                    last_output_at: Arc::new(Mutex::new(Instant::now())),
                    cancelled: Arc::new(AtomicBool::new(false)),
                    output_buffer: Arc::new(Mutex::new(OutputBuffer::new(10, 1024))),
                    replay_buffer: Arc::new(Mutex::new(ReplayBuffer::new(1024))),
                    paste_ready: Arc::new(AtomicBool::new(false)),
                    output_flow: Arc::new(OutputFlowGate::new()),
                    managed_pi_state_cleanup,
                    managed_wsl_pi_state_cleanup: None,
                },
            );
    }

    #[test]
    fn terminal_link_context_only_uses_live_session_metadata() {
        let (service, _temp_dir) = terminal_service_for_test();
        install_recording_session(
            &service,
            "session-context",
            Arc::new(Mutex::new(Vec::new())),
        );

        let context = service
            .terminal_link_context("session-context")
            .expect("context query")
            .expect("live context");
        assert_eq!(context.project_path, "/repo");
        assert_eq!(context.runtime_kind, "local");
        assert!(service
            .terminal_link_context("missing")
            .expect("missing query")
            .is_none());

        {
            let sessions = service.sessions.lock().expect("sessions lock");
            let session = sessions.get("session-context").expect("installed session");
            *session.status.lock().expect("status lock") = SessionStatus::Exited;
        }
        assert!(service
            .terminal_link_context("session-context")
            .expect("exited query")
            .is_none());
    }

    #[test]
    fn cancel_launch_before_session_registration_is_consumed_at_next_phase() {
        let (service, _temp_dir) = terminal_service_for_test();
        service
            .cancel_launch("launch-before-session")
            .expect("cancel launch");

        let error = service
            .ensure_launch_active(Some("launch-before-session"), "launch.pty.begin")
            .expect_err("cancel marker must stop the launch");
        let app_error = error
            .downcast_ref::<AppError>()
            .expect("structured launch cancellation");
        assert_eq!(app_error.code(), Some("LAUNCH_CANCELLED"));
        assert!(service
            .ensure_launch_active(Some("launch-before-session"), "launch.pty.begin")
            .is_ok());
    }

    #[test]
    fn cancel_launch_kills_registered_session_once() {
        let (service, _temp_dir) = terminal_service_for_test();
        install_recording_session_with_launch_id(
            &service,
            "session-cancel",
            Arc::new(Mutex::new(Vec::new())),
            Some("launch-cancel"),
        );

        service
            .cancel_launch("launch-cancel")
            .expect("cancel launch");
        assert!(service
            .find_session_id_by_launch_id("launch-cancel")
            .is_none());
        assert!(service.cancel_launch("launch-cancel").is_ok());
    }

    #[test]
    fn duplicate_launch_id_is_rejected_before_second_pty() {
        let (service, _temp_dir) = terminal_service_for_test();
        let first = service
            .reserve_launch(Some("launch-duplicate"))
            .expect("reserve first launch")
            .expect("reservation");
        let error = match service.reserve_launch(Some("launch-duplicate")) {
            Ok(_) => panic!("duplicate launch must be rejected"),
            Err(error) => error,
        };
        let app_error = error
            .downcast_ref::<AppError>()
            .expect("structured duplicate error");
        assert_eq!(app_error.code(), Some("LAUNCH_DUPLICATE"));
        drop(first);
        assert!(service.reserve_launch(Some("launch-duplicate")).is_ok());
    }

    #[test]
    fn test_infer_status_empty() {
        assert_eq!(infer_status(""), SessionStatus::Active);
    }

    #[test]
    fn pty_fallback_recovers_stale_non_terminal_status_when_hooks_are_silent() {
        assert!(should_apply_pty_status_fallback(
            false,
            SessionStatus::WaitingInput
        ));
        assert!(should_apply_pty_status_fallback(
            false,
            SessionStatus::ToolRunning
        ));
        assert!(!should_apply_pty_status_fallback(
            true,
            SessionStatus::WaitingInput
        ));
        assert!(!should_apply_pty_status_fallback(
            false,
            SessionStatus::Exited
        ));
        assert!(!should_apply_pty_status_fallback(
            false,
            SessionStatus::Error
        ));
    }

    #[test]
    fn write_passes_control_bytes_through_unmodified() {
        // 回归：写入链路必须字节透明，Esc / Shift+Tab 不能被转义或规范化。
        // （容错 unescape 只在 MCP 边界做，见 orchestrator_service::decode_terminal_escapes）
        let (service, _temp_dir) = terminal_service_for_test();
        let writes = Arc::new(Mutex::new(Vec::new()));
        install_recording_session(&service, "session-1", writes.clone());

        for payload in ["\u{1b}", "\u{1b}[Z", "\u{3}", "\\x03"] {
            service.write("session-1", payload).expect("write");
        }

        let start = Instant::now();
        loop {
            let len = writes
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .len();
            if len == 4 {
                break;
            }
            assert!(
                start.elapsed() < Duration::from_secs(2),
                "writer thread did not flush control bytes"
            );
            thread::sleep(Duration::from_millis(10));
        }

        let writes = writes
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        assert_eq!(writes, vec!["\u{1b}", "\u{1b}[Z", "\u{3}", "\\x03"]);
    }

    #[test]
    fn submit_to_session_serializes_text_and_enter_per_session() {
        let (service, _temp_dir) = terminal_service_for_test();
        let writes = Arc::new(Mutex::new(Vec::new()));
        install_recording_session(&service, "session-1", writes.clone());

        let first = {
            let service = service.clone();
            thread::spawn(move || service.submit_text_to_session("session-1", "alpha"))
        };
        let second = {
            let service = service.clone();
            thread::spawn(move || service.submit_text_to_session("session-1", "beta"))
        };

        first
            .join()
            .expect("first submit thread")
            .expect("first submit");
        second
            .join()
            .expect("second submit thread")
            .expect("second submit");

        let writes = writes
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        // fix(C2) review: 并发 submit 不能交错成 text/text/Enter/Enter。
        assert!(
            writes == vec!["alpha", "\r", "beta", "\r"]
                || writes == vec!["beta", "\r", "alpha", "\r"],
            "unexpected submit write order: {writes:?}"
        );
    }

    #[test]
    fn wrap_bracketed_paste_preserves_multiline_and_removes_embedded_end_markers() {
        assert_eq!(
            wrap_bracketed_paste("line 1\nline 2"),
            "\x1b[200~line 1\nline 2\x1b[201~"
        );
        assert_eq!(
            wrap_bracketed_paste("before\x1b[201~middle\x1b[201~after"),
            "\x1b[200~beforemiddleafter\x1b[201~"
        );
        let assembled_from_fragments = ["before", "\x1b[20", "1~after"].concat();
        assert_eq!(
            wrap_bracketed_paste(&assembled_from_fragments),
            "\x1b[200~beforeafter\x1b[201~"
        );
        assert_eq!(wrap_bracketed_paste(""), "\x1b[200~\x1b[201~");
        assert_eq!(wrap_bracketed_paste("\n"), "\x1b[200~\n\x1b[201~");
    }

    #[test]
    fn submit_delay_uses_ready_and_length_tiers() {
        assert_eq!(submit_delay_ms(64 * 1024, true), 200);
        assert_eq!(submit_delay_ms(64 * 1024, false), 4040);
        assert_eq!(submit_delay_ms(1024 * 1024, false), 5000);
    }

    #[test]
    fn submit_to_session_writes_multiline_paste_then_cr() {
        let (service, _temp_dir) = terminal_service_for_test();
        let writes = Arc::new(Mutex::new(Vec::new()));
        install_recording_session(&service, "session-multiline", writes.clone());
        set_recording_session_paste_ready(&service, "session-multiline");

        service
            .submit_text_to_session("session-multiline", "first\nsecond\nthird")
            .expect("submit multiline text");

        assert_eq!(
            writes
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .as_slice(),
            ["\x1b[200~first\nsecond\nthird\x1b[201~", "\r"]
        );
    }

    #[test]
    fn submit_to_session_writes_slash_command_then_cr() {
        let (service, _temp_dir) = terminal_service_for_test();
        let writes = Arc::new(Mutex::new(Vec::new()));
        install_recording_session(&service, "session-slash", writes.clone());
        set_recording_session_paste_ready(&service, "session-slash");

        service
            .submit_text_to_session("session-slash", "/clear")
            .expect("submit slash command");

        assert_eq!(
            writes
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .as_slice(),
            ["\x1b[200~/clear\x1b[201~", "\r"]
        );
    }

    #[test]
    fn write_waits_for_in_flight_submit_enter() {
        let (service, _temp_dir) = terminal_service_for_test();
        let writes = Arc::new(Mutex::new(Vec::new()));
        install_recording_session(&service, "session-1", writes.clone());
        set_recording_session_paste_ready(&service, "session-1");

        let submit = {
            let service = service.clone();
            thread::spawn(move || service.submit_text_to_session("session-1", "alpha"))
        };

        let start = Instant::now();
        loop {
            let has_text = writes
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .as_slice()
                == ["\x1b[200~alpha\x1b[201~"];
            if has_text {
                break;
            }
            assert!(
                start.elapsed() < Duration::from_secs(2),
                "submit did not write initial text"
            );
            thread::sleep(Duration::from_millis(5));
        }

        service.write("session-1", "z").expect("keyboard write");
        submit
            .join()
            .expect("submit thread")
            .expect("submit should finish");

        let writes = writes
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        assert_eq!(writes, vec!["\x1b[200~alpha\x1b[201~", "\r", "z"]);
    }

    #[test]
    fn selected_shared_mcp_config_toml_for_codex_only_includes_allowed_servers() {
        let mut shared_mcp = SharedMcpConfig::default();
        shared_mcp.servers.insert(
            "fetch".to_string(),
            SharedMcpServerConfig {
                command: "uvx".to_string(),
                args: vec!["mcp-server-fetch".to_string()],
                env: HashMap::new(),
                shared: true,
                port: 3104,
                bridge_mode: BridgeMode::McpProxy,
            },
        );
        shared_mcp.servers.insert(
            "Playwright".to_string(),
            SharedMcpServerConfig {
                command: "npx".to_string(),
                args: vec!["-y".to_string(), "@playwright/mcp@latest".to_string()],
                env: HashMap::new(),
                shared: true,
                port: 3101,
                bridge_mode: BridgeMode::McpProxy,
            },
        );

        let config_toml =
            selected_shared_mcp_config_toml_for_codex(&["fetch".to_string()], &shared_mcp);
        let parsed = config_toml.parse::<toml::Value>().unwrap();
        let servers = parsed
            .get("mcp_servers")
            .and_then(toml::Value::as_table)
            .unwrap();

        assert_eq!(servers.len(), 1);
        assert_eq!(
            servers
                .get("fetch")
                .and_then(|server| server.get("command"))
                .and_then(toml::Value::as_str),
            Some("uvx")
        );
        assert!(!servers.contains_key("Playwright"));
    }

    #[test]
    fn test_infer_status_waiting_prompt() {
        assert_eq!(infer_status("Continue? [Y/n]"), SessionStatus::WaitingInput);
    }

    // 强/弱分级：只有强判据（显式等待文案 / Y/n 确认）才弹通知；
    // `?` 结尾、裸 `>`、shell 提示符是弱判据——grok TUI 底栏常驻 `>`，
    // 每帧重绘翻边沿，弱判据弹通知就是通知洪水（2026-08 实测）。
    #[test]
    fn inferred_waiting_strength_strong_signals_notify() {
        assert!(inferred_waiting_is_strong("Continue? [Y/n]"));
        assert!(inferred_waiting_is_strong("Overwrite file? [y/N]"));
        assert!(inferred_waiting_is_strong("Waiting for input..."));
        assert!(inferred_waiting_is_strong(
            "This command needs your approval"
        ));
    }

    #[test]
    fn inferred_waiting_strength_weak_signals_stay_silent() {
        // 这些仍会把状态徽章翻成 WaitingInput（infer_status 不变），但不打扰。
        assert!(!inferred_waiting_is_strong("需要补扫码吗?"));
        assert!(!inferred_waiting_is_strong(">"));
        assert!(!inferred_waiting_is_strong("PS>"));
        assert!(!inferred_waiting_is_strong("user@host $ "));
    }

    #[test]
    fn test_replay_buffer_tracks_alternate_screen_mode() {
        let mut replay = ReplayBuffer::new(1024);

        replay.push("hello");
        assert_eq!(replay.snapshot().buffer_mode, TerminalBufferMode::Normal);

        replay.push("\x1b[?1049h");
        assert_eq!(replay.snapshot().buffer_mode, TerminalBufferMode::Alternate);

        replay.push("\x1b[?1049l");
        assert_eq!(replay.snapshot().buffer_mode, TerminalBufferMode::Normal);
    }

    #[test]
    fn test_replay_buffer_trims_oldest_chunks_by_size() {
        let mut replay = ReplayBuffer::new(8);

        replay.push("1234");
        replay.push("5678");
        replay.push("90");

        let snapshot = replay.snapshot();
        assert_eq!(snapshot.data, "567890");
        assert_eq!(snapshot.buffer_mode, TerminalBufferMode::Normal);
    }

    // --- M3b-1: checkpoint 存储与 seq 记账 ---

    fn test_checkpoint(replay: &ReplayBuffer, anchor_seq: u64) -> TerminalCheckpoint {
        TerminalCheckpoint {
            checkpoint_epoch: replay.epoch,
            anchor_seq,
            snapshot_ansi: "PHOTO".to_string(),
            buffer_mode: TerminalBufferMode::Normal,
            cols: 80,
            rows: 24,
            checkpointed_at_ms: 0,
        }
    }

    #[test]
    fn checkpoint_store_accepts_valid_anchor() {
        let mut replay = ReplayBuffer::new(1024);
        replay.push("hello");
        replay.push("world");

        let outcome = replay.store_checkpoint(test_checkpoint(&replay, 5));
        assert_eq!(outcome, StoreCheckpointOutcome::Accepted { anchor_seq: 5 });

        let recovery = replay.recovery_snapshot();
        let cp = recovery.checkpoint.expect("stored checkpoint");
        assert_eq!(cp.anchor_seq, 5);
        assert_eq!(cp.snapshot_ansi, "PHOTO");
        assert_eq!(recovery.delta, "world");
        assert_eq!(recovery.end_seq, 10);
        assert_eq!(recovery.checkpoint_epoch, replay.epoch);
    }

    #[test]
    fn anchoring_trims_chunks_before_anchor_and_memory_shrinks() {
        // M3b-4：photo 接受后 anchor 之前的整段 chunk 被裁掉，内存不再随
        // 历史线性涨；照片经裁剪永不失效，恢复语义不变。
        let mut replay = ReplayBuffer::new(1024);
        replay.push("hello");
        replay.push("world");
        assert_eq!(replay.total_bytes, 10);

        let outcome = replay.store_checkpoint(test_checkpoint(&replay, 5));
        assert_eq!(outcome, StoreCheckpointOutcome::Accepted { anchor_seq: 5 });
        // "hello"（整段位于 anchor 之前）被裁；"world" 保留
        assert_eq!(replay.total_bytes, 5);
        assert_eq!(replay.window_start_seq, 5);

        let recovery = replay.recovery_snapshot();
        assert!(recovery.checkpoint.is_some());
        assert_eq!(recovery.delta, "world");
        // 旧端点：photo + 保留字节拼接串，画面完整
        assert_eq!(replay.snapshot().data, "PHOTOworld");
    }

    // --- B-4：查询序列在丢弃后能否经 desync 重放自愈（docs/71 §9.2）---

    #[test]
    fn recovery_delta_retains_query_sequences_the_emitter_dropped() {
        // 为什么这条能自愈：reader 线程先 replay.push()（terminal_service.rs:3588）
        // 再 batch_tx.send()（:3600），ReplayBuffer 完全不经过 emitter。所以 WS 有界
        // 队列整段跳过 / 前端 pendingBuffers 溢出丢掉的字节，**仍然在 ReplayBuffer
        // 里**——desync 后的 recovery delta 会把它们原样重放，前端 xterm 的
        // registerCsiHandler({final:"n"})（TerminalView.tsx:1110）随即补发 CPR，
        // 阻塞在 read 上的子进程得以解除。Orca 必须逐条丢弃路径打捞，是因为它的
        // keep-tail 丢弃层背后没有等价的 ReplayBuffer。
        let mut replay = ReplayBuffer::new(1024);
        replay.push("before");
        // 这一段假设已被 emitter 整段跳过（desync），前端从未见过
        replay.push("\x1b[6n");
        replay.push("after");

        let recovery = replay.recovery_snapshot();
        assert!(
            recovery.delta.contains("\x1b[6n"),
            "被丢弃的 CPR 查询必须留在 recovery delta 里，否则子进程永久阻塞"
        );
    }

    #[test]
    fn checkpoint_anchoring_never_trims_an_unanswered_query() {
        // 锚定裁剪（M3b-4）会丢掉 anchor 之前的整段 chunk，但不会丢掉“未被回答的
        // 查询”：前端只在 anchorCandidate() 非 null 时拍照，而它要求
        // received === written（terminalOutputSeqTracker.ts:109）——即 anchor 之前的
        // 每个字节都已写进 xterm、查询早已回过。所以被裁掉的查询必然是已回答的。
        let mut replay = ReplayBuffer::new(1024);
        replay.push("\x1b[6n"); // 已被前端解析并回复过
        replay.push("tail");
        let anchor = replay.pushed_seq - "tail".len() as u64;

        let outcome = replay.store_checkpoint(test_checkpoint(&replay, anchor));
        assert_eq!(
            outcome,
            StoreCheckpointOutcome::Accepted { anchor_seq: anchor }
        );
        // 查询被裁走了，但它对应的画面效果已烘进 photo，且回复早已送达
        assert_eq!(replay.recovery_snapshot().delta, "tail");
    }

    #[test]
    fn replay_eviction_is_the_only_path_that_loses_query_sequences() {
        // 残余挂起窗口：查询字节之后又产生了超过 LIVE_REPLAY_MAX_BYTES 的输出时，
        // evict_front（:814）把它挤出窗口 —— 这是全链路唯一让字节永久消失的地方。
        // 触发条件苛刻（发查询的程序此时正阻塞、产不出这些字节，需要第二个生产者），
        // 但不为零；若要加固，打捞逻辑只需挂在 evict_front 这一处，而非每条丢弃路径。
        let mut replay = ReplayBuffer::new(8);
        replay.push("\x1b[6n");
        replay.push("0123456789");

        let recovery = replay.recovery_snapshot();
        assert!(
            !recovery.delta.contains("\x1b[6n"),
            "本测试用于记录 evict 会丢查询这一事实；行为若变化需同步更新 docs/71 §9.2 B-4"
        );
    }

    #[test]
    fn anchoring_never_splits_chunks_across_anchor() {
        // anchor 落 chunk 边界（seq 按 chunk 累加）；跨界 chunk 整段保留
        // ——「丢弃只能整段」不变式。
        let mut replay = ReplayBuffer::new(1024);
        replay.push("abc");
        replay.push("defgh");
        // anchor = 3（第一段末尾）：裁 "abc" 留 "defgh"
        let outcome = replay.store_checkpoint(test_checkpoint(&replay, 3));
        assert_eq!(outcome, StoreCheckpointOutcome::Accepted { anchor_seq: 3 });
        assert_eq!(replay.recovery_snapshot().delta, "defgh");
        assert_eq!(replay.window_start_seq, 3);
    }

    #[test]
    fn checkpoint_store_rejects_epoch_mismatch() {
        let mut replay = ReplayBuffer::new(1024);
        replay.push("hello");

        let mut cp = test_checkpoint(&replay, 5);
        cp.checkpoint_epoch = replay.epoch.wrapping_add(1);
        assert_eq!(
            replay.store_checkpoint(cp),
            StoreCheckpointOutcome::RejectedEpochMismatch
        );
        assert!(replay.recovery_snapshot().checkpoint.is_none());
    }

    #[test]
    fn checkpoint_store_rejects_stale_anchor() {
        let mut replay = ReplayBuffer::new(1024);
        replay.push("hello");
        replay.push("world");
        assert_eq!(
            replay.store_checkpoint(test_checkpoint(&replay, 8)),
            StoreCheckpointOutcome::Accepted { anchor_seq: 8 }
        );

        // 等于现有锚点与小于现有锚点都算 stale。
        assert_eq!(
            replay.store_checkpoint(test_checkpoint(&replay, 8)),
            StoreCheckpointOutcome::RejectedStaleAnchor
        );
        assert_eq!(
            replay.store_checkpoint(test_checkpoint(&replay, 3)),
            StoreCheckpointOutcome::RejectedStaleAnchor
        );
    }

    #[test]
    fn checkpoint_store_rejects_anchor_gap_after_front_drop() {
        let mut replay = ReplayBuffer::new(8);
        replay.push("1234");
        replay.push("5678");
        replay.push("90");
        // front-drop 丢掉 "1234"，窗口起点推到 4。
        assert_eq!(replay.window_start_seq, 4);

        assert_eq!(
            replay.store_checkpoint(test_checkpoint(&replay, 2)),
            StoreCheckpointOutcome::RejectedAnchorGap
        );
    }

    #[test]
    fn checkpoint_store_rejects_future_anchor() {
        let mut replay = ReplayBuffer::new(1024);
        replay.push("hello");
        assert_eq!(
            replay.store_checkpoint(test_checkpoint(&replay, 6)),
            StoreCheckpointOutcome::RejectedFutureAnchor
        );
    }

    #[test]
    fn checkpoint_store_rejects_oversized_photo() {
        let mut replay = ReplayBuffer::new(1024);
        replay.push("hello");
        let mut cp = test_checkpoint(&replay, 5);
        cp.snapshot_ansi = "x".repeat(CHECKPOINT_SNAPSHOT_MAX_BYTES + 1);
        assert_eq!(
            replay.store_checkpoint(cp),
            StoreCheckpointOutcome::RejectedTooLarge
        );
    }

    #[test]
    fn recovery_snapshot_without_checkpoint_returns_full_window() {
        let mut replay = ReplayBuffer::new(8);
        replay.push("1234");
        replay.push("5678");
        replay.push("90");

        let recovery = replay.recovery_snapshot();
        assert!(recovery.checkpoint.is_none());
        assert_eq!(recovery.delta, "567890");
        assert_eq!(recovery.delta, replay.snapshot().data);
        assert_eq!(recovery.end_seq, 10);
        assert_eq!(recovery.buffer_mode, TerminalBufferMode::Normal);
    }

    #[test]
    fn checkpoint_invalidated_when_front_drop_passes_anchor() {
        let mut replay = ReplayBuffer::new(8);
        replay.push("abcd");
        assert_eq!(
            replay.store_checkpoint(test_checkpoint(&replay, 4)),
            StoreCheckpointOutcome::Accepted { anchor_seq: 4 }
        );

        // 窗口起点推到 4 == anchor：照片仍有效（delta 无缝）。
        replay.push("efgh");
        replay.push("ijkl");
        assert_eq!(replay.window_start_seq, 4);
        let recovery = replay.recovery_snapshot();
        assert!(recovery.checkpoint.is_some());
        assert_eq!(recovery.delta, "efghijkl");

        // 窗口起点推过 anchor：照片作废，回落纯窗口 delta。
        replay.push("mnop");
        assert_eq!(replay.window_start_seq, 8);
        let recovery = replay.recovery_snapshot();
        assert!(recovery.checkpoint.is_none());
        assert_eq!(recovery.delta, "ijklmnop");
    }

    #[test]
    fn checkpoint_invalidated_when_shrink_passes_anchor() {
        let mut replay = ReplayBuffer::new(1024);
        replay.push("abcd");
        replay.push("efgh");
        replay.push("ijkl");
        assert_eq!(
            replay.store_checkpoint(test_checkpoint(&replay, 4)),
            StoreCheckpointOutcome::Accepted { anchor_seq: 4 }
        );

        // dead 转移路径就是 shrink：先缩到 anchor 边界（仍有效）。
        replay.shrink(8);
        assert_eq!(replay.window_start_seq, 4);
        assert!(replay.recovery_snapshot().checkpoint.is_some());

        // 再缩推过 anchor：照片作废。
        replay.shrink(4);
        assert_eq!(replay.window_start_seq, 8);
        let recovery = replay.recovery_snapshot();
        assert!(recovery.checkpoint.is_none());
        assert_eq!(recovery.delta, "ijkl");
    }

    #[test]
    fn checkpoint_epochs_are_unique_across_buffers() {
        let first = ReplayBuffer::new(1024);
        let second = ReplayBuffer::new(1024);
        assert_ne!(first.epoch, second.epoch);
    }

    #[test]
    fn checkpoint_seeded_reassembly_matches_reference_stream() {
        // seeded table-driven 重组测试（评审修订 5：不引 proptest）。
        struct Lcg(u64);
        impl Lcg {
            fn next(&mut self) -> u64 {
                self.0 = self
                    .0
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                self.0 >> 33
            }
        }

        let mut rng = Lcg(0x5eed_2026);
        let mut replay = ReplayBuffer::new(16 * 1024);
        let mut reference = String::new();
        let mut anchor: Option<u64> = None;

        for round in 0..40 {
            let chunk_count = 1 + (rng.next() % 3) as usize;
            for _ in 0..chunk_count {
                // 偶发超大 chunk 触发 front-drop（可能推过锚点）。
                let len = if rng.next().is_multiple_of(7) {
                    8 * 1024 + (rng.next() % 4096) as usize
                } else {
                    1 + (rng.next() % 4096) as usize
                };
                let byte = b'a' + (rng.next() % 26) as u8;
                let chunk = String::from_utf8(vec![byte; len]).expect("ascii chunk");
                replay.push(&chunk);
                reference.push_str(&chunk);
            }

            // 随机时点拍照：anchor 取当时 pushed_seq（每轮至少 push 1 字节，
            // anchor 严格递增，必被接受）。
            if rng.next().is_multiple_of(3) {
                let anchor_seq = replay.pushed_seq;
                assert_eq!(
                    replay.store_checkpoint(test_checkpoint(&replay, anchor_seq)),
                    StoreCheckpointOutcome::Accepted { anchor_seq },
                    "round {round}: photo at pushed_seq must be accepted"
                );
                anchor = Some(anchor_seq);
            }

            // seq 记账不变式。
            assert_eq!(replay.pushed_seq, reference.len() as u64, "round {round}");
            assert_eq!(
                replay.pushed_seq - replay.window_start_seq,
                replay.total_bytes as u64,
                "round {round}: window accounting"
            );

            let window_start = replay.window_start_seq as usize;
            // M3b-4 锚定后旧端点语义 = photo + 保留字节拼接串（画面完整）；
            // 无有效照片时仍是纯窗口。
            let photo_prefix = replay
                .checkpoint
                .as_ref()
                .filter(|cp| cp.anchor_seq >= replay.window_start_seq)
                .map(|cp| cp.snapshot_ansi.as_str())
                .unwrap_or("");
            assert_eq!(
                replay.snapshot().data,
                format!("{photo_prefix}{}", &reference[window_start..]),
                "round {round}: legacy snapshot == photo + window suffix"
            );

            let recovery = replay.recovery_snapshot();
            assert_eq!(recovery.end_seq, replay.pushed_seq, "round {round}");
            match (&recovery.checkpoint, anchor) {
                (Some(cp), Some(anchor_seq)) => {
                    assert_eq!(cp.anchor_seq, anchor_seq, "round {round}");
                    assert_eq!(
                        recovery.delta,
                        &reference[anchor_seq as usize..],
                        "round {round}: photo + delta 重组必须等于参考全流后缀"
                    );
                }
                (None, stored) => {
                    if let Some(anchor_seq) = stored {
                        assert!(
                            anchor_seq < replay.window_start_seq,
                            "round {round}: valid photo must be returned"
                        );
                        // 照片被 front-drop 推过锚点后失效，后续轮次按无照片对待。
                        anchor = None;
                    }
                    assert_eq!(
                        recovery.delta,
                        &reference[window_start..],
                        "round {round}: fallback delta == window"
                    );
                }
                (Some(_), None) => {
                    panic!("round {round}: photo returned before any was stored")
                }
            }
        }
    }

    #[test]
    fn store_session_checkpoint_reaches_live_and_missing_sessions() {
        let (service, _temp_dir) = terminal_service_for_test();
        install_recording_session(&service, "session-cp", Arc::new(Mutex::new(Vec::new())));

        let epoch = {
            let sessions = service.sessions.lock().expect("sessions lock");
            let session = sessions.get("session-cp").expect("installed session");
            let mut replay = session.replay_buffer.lock().expect("replay lock");
            replay.push("hello");
            replay.epoch
        };

        let outcome = service
            .store_session_checkpoint(
                "session-cp",
                TerminalCheckpoint {
                    checkpoint_epoch: epoch,
                    anchor_seq: 5,
                    snapshot_ansi: "PHOTO".to_string(),
                    buffer_mode: TerminalBufferMode::Normal,
                    cols: 80,
                    rows: 24,
                    checkpointed_at_ms: 0,
                },
            )
            .expect("store on live session");
        assert_eq!(outcome, StoreCheckpointOutcome::Accepted { anchor_seq: 5 });

        let recovery = service
            .get_session_recovery_snapshot("session-cp")
            .expect("recovery query")
            .expect("live session snapshot");
        assert!(recovery.checkpoint.is_some());
        assert_eq!(recovery.delta, "");
        assert_eq!(recovery.end_seq, 5);

        // 会话不存在：store 报 NotFound，get 返回 None。
        let error = service
            .store_session_checkpoint(
                "missing",
                TerminalCheckpoint {
                    checkpoint_epoch: epoch,
                    anchor_seq: 0,
                    snapshot_ansi: String::new(),
                    buffer_mode: TerminalBufferMode::Normal,
                    cols: 80,
                    rows: 24,
                    checkpointed_at_ms: 0,
                },
            )
            .expect_err("missing session must error");
        assert_eq!(error.code(), Some("NOT_FOUND"));
        assert!(service
            .get_session_recovery_snapshot("missing")
            .expect("missing query")
            .is_none());
    }

    #[test]
    fn checkpoint_methods_reach_dead_buffers() {
        let (service, _temp_dir) = terminal_service_for_test();
        let replay_buffer = Arc::new(Mutex::new(ReplayBuffer::new(1024)));
        let epoch = {
            let mut replay = replay_buffer.lock().expect("replay lock");
            replay.push("bye");
            replay.epoch
        };
        service
            .dead_buffers
            .lock()
            .expect("dead_buffers lock")
            .insert(
                "session-dead".to_string(),
                DeadBufferEntry {
                    output_buffer: Arc::new(Mutex::new(OutputBuffer::new(10, 1024))),
                    replay_buffer,
                    created_at: Instant::now(),
                    exit_code: Arc::new(Mutex::new(Some(0))),
                    pid: None,
                    last_output_at: 0,
                },
            );

        let outcome = service
            .store_session_checkpoint(
                "session-dead",
                TerminalCheckpoint {
                    checkpoint_epoch: epoch,
                    anchor_seq: 3,
                    snapshot_ansi: "PHOTO".to_string(),
                    buffer_mode: TerminalBufferMode::Normal,
                    cols: 80,
                    rows: 24,
                    checkpointed_at_ms: 0,
                },
            )
            .expect("store on dead session");
        assert_eq!(outcome, StoreCheckpointOutcome::Accepted { anchor_seq: 3 });

        let recovery = service
            .get_session_recovery_snapshot("session-dead")
            .expect("recovery query")
            .expect("dead session snapshot");
        assert!(recovery.checkpoint.is_some());
        assert_eq!(recovery.delta, "");
        assert_eq!(recovery.end_seq, 3);
    }

    // --- M3b-2: 补拍扫描（needs_checkpoint / sessions_needing_checkpoint） ---

    #[test]
    fn needs_checkpoint_requires_valid_photo_and_threshold_excess() {
        let mut replay = ReplayBuffer::new(1024);
        replay.push("12345");

        // 无照片不催——首拍由前端边沿触发。
        assert!(!replay.needs_checkpoint(0));

        assert_eq!(
            replay.store_checkpoint(test_checkpoint(&replay, 5)),
            StoreCheckpointOutcome::Accepted { anchor_seq: 5 }
        );
        // 锚点即最新：无新增字节，不催。
        assert!(!replay.needs_checkpoint(0));

        replay.push("abc");
        // 差 3 字节：阈值 3 不催（严格大于），阈值 2 催。
        assert!(!replay.needs_checkpoint(3));
        assert!(replay.needs_checkpoint(2));
    }

    #[test]
    fn needs_checkpoint_false_after_window_pushes_past_anchor() {
        let mut replay = ReplayBuffer::new(8);
        replay.push("1234");
        assert_eq!(
            replay.store_checkpoint(test_checkpoint(&replay, 4)),
            StoreCheckpointOutcome::Accepted { anchor_seq: 4 }
        );
        // anchor == 窗口起点仍有效（delta 从锚点起完整保留），此时该催。
        replay.push("5678");
        replay.push("90ab");
        assert!(replay.needs_checkpoint(0));
        // front-drop 真正推过锚点 → 照片作废 → 回到"无照片不催"。
        replay.push("cdef");
        assert!(!replay.needs_checkpoint(0));
    }

    #[test]
    fn sessions_needing_checkpoint_scans_active_sessions_only() {
        let (service, _temp_dir) = terminal_service_for_test();
        install_recording_session(&service, "session-hot", Arc::new(Mutex::new(Vec::new())));
        install_recording_session(&service, "session-cold", Arc::new(Mutex::new(Vec::new())));

        {
            let sessions = service.sessions.lock().expect("sessions lock");
            let hot = sessions.get("session-hot").expect("hot session");
            let mut replay = hot.replay_buffer.lock().expect("replay lock");
            replay.push("base");
            let cp = test_checkpoint(&replay, 4);
            assert_eq!(
                replay.store_checkpoint(cp),
                StoreCheckpointOutcome::Accepted { anchor_seq: 4 }
            );
            replay.push("lots-of-new-bytes");
            // cold：有输出但没有照片 → 不该被催。
            let cold = sessions.get("session-cold").expect("cold session");
            cold.replay_buffer
                .lock()
                .expect("cold replay lock")
                .push("plenty of output without a photo");
        }

        assert_eq!(
            service.sessions_needing_checkpoint(8),
            vec!["session-hot".to_string()]
        );
        // 阈值大于差值：谁都不催。
        assert!(service.sessions_needing_checkpoint(1024).is_empty());
    }

    /// 阈值语义是**严格大于**，且该语义必须一路传到 service 层。
    ///
    /// ReplayBuffer 那层已有对照用例，但 service 是 daemon 周期扫描真正调的入口；
    /// 若这里的比较写成 `>=`，每轮扫描都会把"差值恰好等于阈值"的会话算进候选，
    /// 而重拍后差值归零、再涨回同一水位又被算进去——形成稳态的重复催拍。
    /// 前端每 60s（节流下限）被迫做一次全屏序列化，纯属白烧 CPU。
    #[test]
    fn sessions_needing_checkpoint_threshold_is_strictly_greater() {
        let (service, _temp_dir) = terminal_service_for_test();
        install_recording_session(&service, "session-1", Arc::new(Mutex::new(Vec::new())));

        {
            let sessions = service.sessions.lock().expect("sessions lock");
            let session = sessions.get("session-1").expect("session");
            let mut replay = session.replay_buffer.lock().expect("replay lock");
            replay.push("base");
            let cp = test_checkpoint(&replay, 4);
            assert_eq!(
                replay.store_checkpoint(cp),
                StoreCheckpointOutcome::Accepted { anchor_seq: 4 }
            );
            replay.push("abc"); // 锚点之后恰好 3 字节
        }

        assert!(
            service.sessions_needing_checkpoint(3).is_empty(),
            "差值 == 阈值不该催（严格大于）；写成 >= 会造成稳态重复催拍"
        );
        assert_eq!(
            service.sessions_needing_checkpoint(2),
            vec!["session-1".to_string()],
            "差值 > 阈值必须催"
        );
    }

    #[test]
    fn test_spinner_line_filters_claude_dynamic_status() {
        assert!(is_spinner_line("✶ Boondoggling… (44s · ↓ 1.5k tokens)"));
        assert!(is_spinner_line("✻thinking more"));
        assert!(is_spinner_line("almost done thinking"));
        assert!(is_spinner_line(
            "◦Waiting for background terminal(15m 35s • esc to interrupt)"
        ));
    }

    #[test]
    fn test_spinner_line_filters_garbled_status_fragments() {
        assert!(is_spinner_line("WWoorrkkiinWngWogorrkkiin1ngg"));
    }

    #[test]
    fn test_spinner_line_keeps_real_content() {
        assert!(!is_spinner_line("可以开工 M-1 Spike。"));
        assert!(!is_spinner_line("Maven 进程还有 CPU 活动，先继续等。"));
    }

    // --- strip_ansi_escapes 单元测试 ---

    #[test]
    fn test_strip_ansi_escapes_plain_text() {
        assert_eq!(strip_ansi_escapes("hello world"), "hello world");
    }

    #[test]
    fn test_strip_ansi_escapes_csi_color() {
        // ESC[38;5;14m (256色前景) + ">" + ESC[0m (重置)
        assert_eq!(strip_ansi_escapes("\x1b[38;5;14m>\x1b[0m"), ">");
    }

    #[test]
    fn test_strip_ansi_escapes_claude_prompt() {
        // Claude Code ink UI 实际输出的 ">" 提示符
        let raw = "\x1b[?25l\x1b[2K\x1b[G\x1b[38;5;14m>\x1b[0m \x1b[?25h";
        assert_eq!(strip_ansi_escapes(raw), "> ");
    }

    #[test]
    fn test_strip_ansi_escapes_osc_sequence() {
        // OSC 序列：ESC]0;title BEL
        let input = "\x1b]0;window title\x07some text";
        assert_eq!(strip_ansi_escapes(input), "some text");
    }

    #[test]
    fn test_strip_ansi_escapes_osc_st_terminator() {
        // OSC 序列以 ST (ESC\) 终止
        let input = "\x1b]0;title\x1b\\text";
        assert_eq!(strip_ansi_escapes(input), "text");
    }

    #[test]
    fn test_strip_ansi_escapes_mixed() {
        let input = "\x1b[1mBold\x1b[0m \x1b[32mGreen\x1b[0m Normal";
        assert_eq!(strip_ansi_escapes(input), "Bold Green Normal");
    }

    // --- infer_status 增强测试 ---

    #[test]
    fn test_infer_status_claude_ansi_prompt() {
        // Claude Code ink UI 渲染的 ">" 提示符（含 ANSI 转义）
        let raw = "\x1b[?25l\x1b[2K\x1b[G\x1b[38;5;14m>\x1b[0m \x1b[?25h";
        assert_eq!(infer_status(raw), SessionStatus::WaitingInput);
    }

    #[test]
    fn test_infer_status_bare_angle_bracket() {
        // 剥离 ANSI 后只剩 ">"
        assert_eq!(infer_status(">"), SessionStatus::WaitingInput);
    }

    #[test]
    fn test_infer_status_shell_dollar() {
        assert_eq!(infer_status("user@host:~$ "), SessionStatus::WaitingInput);
    }

    #[test]
    fn test_infer_status_question() {
        assert_eq!(
            infer_status("Do you want to continue?"),
            SessionStatus::WaitingInput
        );
    }

    #[test]
    fn test_infer_status_cursor_workspace_trust() {
        let raw = "Workspace Trust\nTrust this workspace to enable agent tools?\n  [a] Trust";
        assert_eq!(infer_status(raw), SessionStatus::WaitingInput);
    }

    #[test]
    fn test_infer_status_cursor_run_everything() {
        let raw = "Shell command needs approval\n  npm test\n  [y] Allow  [tab] allowlist  [shift+tab] Run Everything";
        assert_eq!(infer_status(raw), SessionStatus::WaitingInput);
    }

    #[test]
    fn test_infer_status_cursor_thinking_and_tool() {
        assert_eq!(
            infer_status("Still working\nThinking..."),
            SessionStatus::Thinking
        );
        assert_eq!(
            infer_status("Calling tool Shell\nrunning tool: Bash"),
            SessionStatus::ToolRunning
        );
    }

    #[test]
    fn test_infer_status_cursor_markers_do_not_fire_on_unrelated() {
        // 普通工作输出不应被 Cursor chrome 短语误判
        assert_eq!(
            infer_status("compiling cursor module...\nrunning tests"),
            SessionStatus::Active
        );
    }

    // --- strip_conpty_artifacts 单元测试 (不依赖 cfg(windows)) ---

    #[test]
    fn test_strip_pattern_a_backspace_char_cursor() {
        // 模式 A: \x08 <char> \x1b[7m <space>
        // 实际场景: ConPTY 光标重绘 → 退格 + 重绘字符 '2' + 反显空格
        let input = b"\x08\x32\x1b\x5b\x37\x6d\x20";
        let output = strip_conpty_artifacts(input);
        assert!(output.is_empty(), "pattern A should be fully stripped");
    }

    #[test]
    fn test_strip_pattern_a_with_surrounding_data() {
        // 有效数据 + 模式 A + 有效数据
        let mut input = Vec::new();
        input.extend_from_slice(b"hello");
        input.extend_from_slice(b"\x08\x32\x1b\x5b\x37\x6d\x20"); // 模式 A
        input.extend_from_slice(b"world");
        let output = strip_conpty_artifacts(&input);
        assert_eq!(output, b"helloworld");
    }

    #[test]
    fn test_strip_pattern_d_style_only() {
        // 模式 D: style-only 空闲帧
        let output = strip_conpty_artifacts(CONPTY_STYLE_ONLY);
        assert!(
            output.is_empty(),
            "pattern D (style-only) should be stripped"
        );
    }

    #[test]
    fn test_strip_full_cursor_redraw_sequence() {
        // 光标重绘: \x1b[27m + \x08 '2' \x1b[7m ' '
        // \x1b[27m 不再被剥离（它是合法的 SGR "关闭反显"），模式 A 仍会被剥离
        let mut input = Vec::new();
        input.extend_from_slice(b"\x1b\x5b\x32\x37\x6d"); // \x1b[27m — 透传
        input.extend_from_slice(b"\x08\x32\x1b\x5b\x37\x6d\x20"); // \x08 '2' \x1b[7m ' ' (模式 A — 剥离)
        let output = strip_conpty_artifacts(&input);
        assert_eq!(
            output, b"\x1b[27m",
            "ESC[27m should pass through, only pattern A stripped"
        );
    }

    #[test]
    fn test_strip_preserves_normal_data() {
        let input = b"echo hello world\r\n";
        let output = strip_conpty_artifacts(input);
        assert_eq!(output, input.to_vec());
    }

    #[test]
    fn test_strip_csi_with_cursor_style_suffix() {
        // ESC[21;6H + '2' + \x1b[7m + ' ' + style-only
        // \x1b[7m + ' ' 不再被剥离（合法 SGR 反显+空格），模式 D 仍会被剥离
        let mut input = Vec::new();
        input.extend_from_slice(b"\x1b[21;6H2");
        input.extend_from_slice(b"\x1b\x5b\x37\x6d\x20"); // 合法的 SGR 7 + 空格 — 透传
        input.extend_from_slice(CONPTY_STYLE_ONLY); // 模式 D — 剥离
        let output = strip_conpty_artifacts(&input);
        assert_eq!(output, b"\x1b[21;6H2\x1b[7m ");
    }

    #[test]
    fn test_strip_multiple_artifacts_in_sequence() {
        // 多个伪影连续出现，\x1b[27m 透传，模式 A 剥离
        let mut input = Vec::new();
        input.extend_from_slice(b"\x1b\x5b\x32\x37\x6d"); // \x1b[27m — 透传
        input.extend_from_slice(b"\x08\x61\x1b\x5b\x37\x6d\x20"); // 模式 A (char='a') — 剥离
        input.extend_from_slice(b"\x1b\x5b\x32\x37\x6d"); // \x1b[27m — 透传
        input.extend_from_slice(b"\x08\x62\x1b\x5b\x37\x6d\x20"); // 模式 A (char='b') — 剥离
        let output = strip_conpty_artifacts(&input);
        assert_eq!(output, b"\x1b[27m\x1b[27m");
    }

    #[test]
    fn test_preserve_legitimate_reverse_video() {
        // 合法反显序列不应被破坏：\x1b[7m text \x1b[27m
        // 这是 vim/less/htop 等 TUI 应用的标准用法
        let input = b"\x1b[7m highlighted text \x1b[27m normal text";
        let output = strip_conpty_artifacts(input);
        assert_eq!(
            output,
            input.to_vec(),
            "legitimate reverse video sequences must pass through unchanged"
        );
    }

    // --- trailing_partial_len 单元测试 ---

    #[test]
    fn test_trailing_partial_none() {
        assert_eq!(trailing_partial_len(b"hello"), 0);
    }

    #[test]
    fn test_trailing_partial_esc_start() {
        // 末尾是 \x1b — 可能是模式 B/C/D 的开头
        assert_eq!(trailing_partial_len(b"hello\x1b"), 1);
    }

    #[test]
    fn test_trailing_partial_backspace() {
        // 末尾 \x08 — 模式 A 的开头
        assert_eq!(trailing_partial_len(b"hello\x08"), 1);
    }

    #[test]
    fn test_trailing_partial_pattern_d_prefix() {
        // 末尾 \x1b[39m — 模式 D 的前 5 字节
        let mut input = Vec::new();
        input.extend_from_slice(b"data");
        input.extend_from_slice(b"\x1b\x5b\x33\x39\x6d");
        assert_eq!(trailing_partial_len(&input), 5);
    }

    // --- UTF-8 安全处理测试 ---

    #[test]
    fn test_utf8_safe_ascii() {
        let mut carry = Vec::new();
        let result = utf8_safe_process(b"hello", &mut carry);
        assert_eq!(result, Some("hello".to_string()));
        assert!(carry.is_empty());
    }

    #[test]
    fn test_utf8_safe_complete_multibyte() {
        let mut carry = Vec::new();
        let input = "你好".as_bytes();
        let result = utf8_safe_process(input, &mut carry);
        assert_eq!(result, Some("你好".to_string()));
        assert!(carry.is_empty());
    }

    #[test]
    fn test_utf8_safe_split_multibyte() {
        let mut carry = Vec::new();
        let full = "你".as_bytes(); // 3 bytes: E4 BD A0
                                    // 只发送前 2 字节
        let part1 = &full[..2];
        let result1 = utf8_safe_process(part1, &mut carry);
        assert_eq!(result1, None);
        assert_eq!(carry.len(), 2);

        // 发送剩余 1 字节
        let part2 = &full[2..];
        let result2 = utf8_safe_process(part2, &mut carry);
        assert_eq!(result2, Some("你".to_string()));
        assert!(carry.is_empty());
    }

    #[test]
    fn test_utf8_safe_decodes_gbk_output() {
        let mut carry = Vec::new();
        let result = utf8_safe_process(b"\xd6\xd0\xce\xc4 ABC", &mut carry);
        assert_eq!(result, Some("中文 ABC".to_string()));
        assert!(carry.is_empty());
    }

    #[test]
    fn test_utf8_safe_decodes_split_gbk_output() {
        let mut carry = Vec::new();
        let result1 = utf8_safe_process(b"\xd6", &mut carry);
        assert_eq!(result1, None);
        assert_eq!(carry, b"\xd6");

        let result2 = utf8_safe_process(b"\xd0\xce\xc4", &mut carry);
        assert_eq!(result2, Some("中文".to_string()));
        assert!(carry.is_empty());
    }

    // --- sanitize_windows_output 集成测试 (cfg(windows)) ---

    #[test]
    #[cfg(windows)]
    fn test_sanitize_strips_cursor_style() {
        // \x1b[7m + 空格 现在透传，模式 D 仍被剥离
        let mut state = WindowsOutputSanitizeState::default();
        let chunk = b"\x1b[21;6H2\x1b[7m \x1b[39m\x1b[49m\x1b[59m\x1b[0m\x1b[?25l";
        let output = sanitize_windows_output(chunk, &mut state, false);
        assert_eq!(output, b"\x1b[21;6H2\x1b[7m ");
    }

    #[test]
    #[cfg(windows)]
    fn test_sanitize_drops_style_noise() {
        let mut state = WindowsOutputSanitizeState::default();
        let output = sanitize_windows_output(CONPTY_STYLE_ONLY, &mut state, false);
        assert!(output.is_empty());
    }

    #[test]
    #[cfg(windows)]
    fn test_sanitize_disabled() {
        let mut state = WindowsOutputSanitizeState::default();
        let output = sanitize_windows_output(CONPTY_STYLE_ONLY, &mut state, true);
        assert_eq!(output, CONPTY_STYLE_ONLY);
    }

    #[test]
    #[cfg(windows)]
    fn test_sanitize_cross_chunk_artifacts() {
        let mut state = WindowsOutputSanitizeState::default();
        // 模式 D 被拆分到两个 chunk，\x1b[7m + 空格 现在透传
        let part1 = b"abc\x1b[7m \x1b[39m\x1b[49m";
        let part2 = b"\x1b[59m\x1b[0m\x1b[?25l";

        let out1 = sanitize_windows_output(part1, &mut state, false);
        let out2 = sanitize_windows_output(part2, &mut state, false);

        assert_eq!(out1, b"abc\x1b[7m ");
        assert!(out2.is_empty());
    }

    #[test]
    #[cfg(windows)]
    fn test_sanitize_cursor_redraw_with_variable_char() {
        // \x1b[27m 现在透传（合法 SGR），模式 A 仍被剥离
        let mut state = WindowsOutputSanitizeState::default();

        // 第一个 chunk: \x1b[27m — 透传
        let out = sanitize_windows_output(b"\x1b[27m", &mut state, false);
        assert_eq!(out, b"\x1b[27m");

        // 第二个 chunk: \x08 '2' \x1b[7m ' ' (模式 A) — 剥离
        let out = sanitize_windows_output(b"\x08\x32\x1b\x5b\x37\x6d\x20", &mut state, false);
        assert!(
            out.is_empty(),
            "cursor redraw with variable char '2' should be fully stripped"
        );
    }

    #[test]
    #[cfg(windows)]
    fn test_sanitize_repeated_cursor_redraw_no_leak() {
        // 模拟 ConPTY 对单次按键发送两轮光标重绘
        // \x1b[27m 透传，模式 A 剥离
        let mut state = WindowsOutputSanitizeState::default();

        // 第一轮
        let out = sanitize_windows_output(b"\x1b[27m", &mut state, false);
        assert_eq!(out, b"\x1b[27m");
        let out = sanitize_windows_output(b"\x08\x6b\x1b\x5b\x37\x6d\x20", &mut state, false);
        assert!(out.is_empty(), "first cursor redraw 'k' should be stripped");

        // 第二轮（重复）
        let out = sanitize_windows_output(b"\x1b[27m", &mut state, false);
        assert_eq!(out, b"\x1b[27m");
        let out = sanitize_windows_output(b"\x08\x6b\x1b\x5b\x37\x6d\x20", &mut state, false);
        assert!(
            out.is_empty(),
            "repeated cursor redraw 'k' should also be stripped"
        );
    }

    #[test]
    #[cfg(windows)]
    fn test_sanitize_real_data_with_valid_content() {
        // 有效 CSI 定位 + 字符 + \x1b[7m 空格（透传）+ 模式 D（剥离）
        let mut state = WindowsOutputSanitizeState::default();
        let mut chunk = Vec::new();
        chunk.extend_from_slice(b"\x1b[21;6H2"); // 有效：光标移动 + 字符 '2'
        chunk.extend_from_slice(b"\x1b\x5b\x37\x6d\x20"); // 合法 SGR 7 + 空格 — 透传
        chunk.extend_from_slice(CONPTY_STYLE_ONLY); // 模式 D — 剥离
        let output = sanitize_windows_output(&chunk, &mut state, false);
        assert_eq!(
            output, b"\x1b[21;6H2\x1b[7m ",
            "valid CSI + SGR preserved, only style-only frame stripped"
        );
    }

    // --- detect_shells 测试 ---

    #[test]
    fn test_detect_shells_not_empty() {
        let shells = detect_shells();
        assert!(!shells.is_empty(), "should detect at least one shell");
    }

    #[test]
    fn test_detects_ssh_password_prompt() {
        assert!(looks_like_ssh_password_prompt(
            "dev@devbox.local's password: "
        ));
        assert!(!looks_like_ssh_password_prompt(
            "Enter passphrase for key '/tmp/id_ed25519': "
        ));
        assert_eq!(ssh_password_response("secret"), b"secret\r");
    }

    #[test]
    fn temporary_ssh_password_is_available_to_terminal_auto_response() {
        let (service, _temp_dir) = terminal_service_for_test();
        service
            .ssh_credential_service
            .store_temporary_password("m1", "temporary-secret");
        let ssh = SshConnectionInfo {
            host: "example.com".to_string(),
            port: 22,
            user: Some("dev".to_string()),
            remote_path: "/root".to_string(),
            identity_file: None,
            machine_id: Some("m1".to_string()),
            auth_method: Some(crate::models::AuthMethod::Password),
        };

        let runtime = service
            .prepare_ssh_auth_runtime(Some(&ssh))
            .expect("prepare SSH auth")
            .expect("password runtime");
        assert_eq!(
            runtime.lock().expect("SSH auth runtime").saved_password,
            "temporary-secret"
        );
    }

    #[test]
    fn test_normalize_prompt_text_strips_ansi() {
        assert_eq!(
            normalize_prompt_text("\x1b[31mPassword:\x1b[0m\r"),
            "Password:\n"
        );
    }

    #[test]
    fn test_ssh_session_options_include_keepalive_and_timeout() {
        let mut args = vec!["-tt".to_string()];
        append_ssh_session_options(&mut args);

        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-o" && pair[1] == "ConnectTimeout=10"));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-o" && pair[1] == "ServerAliveInterval=15"));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-o" && pair[1] == "ServerAliveCountMax=2"));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-o" && pair[1] == "TCPKeepAlive=yes"));
    }
}
