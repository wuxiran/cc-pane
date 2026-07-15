use crate::constants::events as EV;
use crate::events::{EventEmitter, SessionNotifier};
use crate::models::shared_mcp::SharedMcpConfig;
use crate::models::{
    CliTool, LaunchProfile, LaunchProfileMcpMode, LaunchProviderSelection, SshConnectionInfo,
    TerminalBufferMode, TerminalExit, TerminalOutput, TerminalReplaySnapshot, WslLaunchInfo,
};
use crate::pty::{spawn_pty, PtyConfig, PtyProcess};
use crate::services::{
    LaunchProfileService, ProjectCliHooksService, ProviderService, SettingsService, SpecService,
    SshCredentialService, WorkspaceService,
};
use crate::utils::error::{AppError, AppResult};
use crate::utils::{orchestrator_manifest, AppPaths};
use anyhow::{anyhow, Result};
use cc_cli_adapters::{CliAdapterContext, CliProvider, CliToolRegistry};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tracing::{debug, error, info, warn};
use uuid::Uuid;

mod osc_resume_capture;
mod osc_state_detect;
mod shell_integration;
mod wsl_codex;

use self::wsl_codex::{strip_wsl_proxy_env_vars, windows_path_to_wsl, WSL_PROXY_ENV_KEYS};

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
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionStatus {
    /// 启动中（hook 还没上报第一个事件）
    Initializing,
    /// 真·空闲（TurnEnd hook 上报；或 PTY 输出超时的兜底降级）
    Idle,
    /// 思考中（PromptBefore 后、ToolBefore 前 / Stop 前）
    Thinking,
    /// 工具调用中（ToolBefore 上报；工具名见 SessionStateEntry）
    ToolRunning,
    /// 上下文压缩中（BeforeCompact 上报）
    Compacting,
    /// 等待用户输入（Notification permission_prompt / elicitation_*）
    WaitingInput,
    /// 出错（StopFailure 上报；error_type 由通知层附带）
    Error,
    /// 会话退出
    Exited,
    /// **已弃用**：留作 PTY ANSI 推断的退化值，新代码应使用具体细分状态
    #[serde(rename = "active")]
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
            _ => KillReason::Unknown,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            KillReason::UserClose => "user-close",
            KillReason::Mcp => "mcp",
            KillReason::OrphanReclaim => "orphan-reclaim",
            KillReason::DaemonReaper => "daemon-reaper",
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

/// 终端会话的输出环形缓冲区（存储 ANSI 已剥离的纯文本行）
struct OutputBuffer {
    lines: VecDeque<String>,
    /// 当前未完成行（未遇到换行符的尾部数据）
    partial: String,
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
            max_lines,
            total_bytes: 0,
            max_bytes,
        }
    }

    /// 追加终端输出文本到缓冲区
    fn push(&mut self, text: &str) {
        // 1. 剥离 ANSI 转义
        let clean = strip_ansi(text);
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

        while self.total_bytes > self.max_bytes {
            let Some(front) = self.chunks.pop_front() else {
                break;
            };
            self.total_bytes = self.total_bytes.saturating_sub(front.len());
        }
    }

    fn shrink(&mut self, max_bytes: usize) {
        self.max_bytes = max_bytes;
        while self.total_bytes > self.max_bytes {
            let Some(front) = self.chunks.pop_front() else {
                break;
            };
            self.total_bytes = self.total_bytes.saturating_sub(front.len());
        }
    }

    fn snapshot(&self) -> TerminalReplaySnapshot {
        let mut data = String::with_capacity(self.total_bytes);
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
    /// 共享 MCP 服务引用（setup 阶段注入）
    shared_mcp_service: parking_lot::RwLock<Option<Arc<crate::services::SharedMcpService>>>,
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
const DEAD_OUTPUT_MAX_LINES: usize = 20_000;
const DEAD_OUTPUT_MAX_BYTES: usize = 10 * 1024 * 1024;
const DEAD_REPLAY_MAX_BYTES: usize = 4 * 1024 * 1024;
const SUBMIT_TEXT_MAX_BYTES: usize = 256 * 1024;

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
    SessionStatusInfo {
        session_id,
        status,
        last_output_at,
        pid,
        exit_code,
        current_tool_name: snapshot
            .as_ref()
            .and_then(|entry| entry.current_tool_name.clone()),
        current_tool_use_id: snapshot
            .as_ref()
            .and_then(|entry| entry.current_tool_use_id.clone()),
        current_tool_summary: snapshot
            .as_ref()
            .and_then(|entry| entry.current_tool_summary.clone()),
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
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
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
            shared_mcp_service: parking_lot::RwLock::new(None),
            launch_profile_service: parking_lot::RwLock::new(None),
            workspace_service: parking_lot::RwLock::new(None),
            input_mutexes: Arc::new(Mutex::new(HashMap::new())),
        }
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

    pub fn set_launch_profile_service(&self, service: Arc<LaunchProfileService>) {
        *self.launch_profile_service.write() = Some(service);
        info!("[terminal] LaunchProfileService injected");
    }

    pub fn set_workspace_service(&self, service: Arc<WorkspaceService>) {
        *self.workspace_service.write() = Some(service);
        info!("[terminal] WorkspaceService injected");
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

        match self.ssh_credential_service.load_password(machine_id) {
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
        provider_selection: LaunchProviderSelection,
        launch_profile_id: Option<&str>,
        workspace_path: Option<&str>,
        workspace_snapshot_id: Option<&str>,
        cli_tool: CliTool,
        resume_id: Option<&str>,
        skip_mcp: bool,
        append_system_prompt: Option<&str>,
        initial_prompt: Option<&str>,
        extra_env: Option<&HashMap<String, String>>,
        ssh: Option<&SshConnectionInfo>,
        wsl: Option<&WslLaunchInfo>,
    ) -> Result<String> {
        // 归一化前端遗留哨兵："new"/空串都视为「新会话」（避免 `--resume new`，
        // 并让 Claude 发号分支正确生效）
        let resume_id = resume_id.filter(|rid| {
            let trimmed = rid.trim();
            !trimmed.is_empty() && trimmed != "new"
        });
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
        let profile_provider_id = resolved_profile
            .as_ref()
            .and_then(|profile| profile.provider_id.as_deref());
        let adapter_options = resolved_profile
            .as_ref()
            .map(|profile| profile.adapter_options.clone())
            .unwrap_or_default();
        let use_native_kimi_config = cli_tool == CliTool::Kimi
            && adapter_options
                .get("kimiConfigMode")
                .and_then(serde_json::Value::as_str)
                == Some("native");
        let requested_provider_id = provider_id.filter(|id| !id.trim().is_empty());
        let effective_provider_id = if use_native_kimi_config {
            None
        } else {
            match provider_selection {
                LaunchProviderSelection::None => None,
                LaunchProviderSelection::Explicit => requested_provider_id,
                LaunchProviderSelection::Inherit => requested_provider_id.or(profile_provider_id),
            }
        };
        let mut env_vars = self.settings_service.get_proxy_env_vars();
        let provider_vars = self.provider_service.get_env_vars(effective_provider_id);
        let provider = effective_provider_id
            .and_then(|id| self.provider_service.get_provider(id))
            .map(to_cli_provider);
        let effective_skip_mcp =
            LaunchProfileService::should_skip_mcp_for_profile(resolved_profile.as_ref(), skip_mcp);
        let shared_mcp_service = self.shared_mcp_service.read().clone();
        let shared_mcp_config = shared_mcp_service
            .as_ref()
            .map(|svc| svc.get_config())
            .unwrap_or_default();
        let effective_shared_mcp_urls = if effective_skip_mcp {
            HashMap::new()
        } else {
            let shared_mcp_urls = shared_mcp_service
                .as_ref()
                .map(|svc| svc.get_running_servers_urls())
                .unwrap_or_default();
            self.launch_profile_service
                .read()
                .as_ref()
                .map(|svc| {
                    svc.resolve_shared_mcp_urls_for_profile(
                        launch_profile_id,
                        resolved_workspace.as_ref(),
                        Some(cli_tool.as_id()),
                        Some(runtime_kind),
                        shared_mcp_urls.clone(),
                    )
                })
                .unwrap_or(shared_mcp_urls)
        };
        let allowed_mcp_server_ids =
            allowed_mcp_server_ids_for_profile(resolved_profile.as_ref(), &shared_mcp_config);
        let disable_unlisted_mcp_servers = launch_profile_isolates_mcp(resolved_profile.as_ref());
        let selected_mcp_config_toml =
            selected_shared_mcp_config_toml_for_codex(&allowed_mcp_server_ids, &shared_mcp_config);
        let sync_project_hooks =
            LaunchProfileService::should_sync_project_hooks_for_profile(resolved_profile.as_ref());
        let effective_yolo_mode = resolved_profile
            .as_ref()
            .map(|profile| profile.yolo_mode)
            .unwrap_or(false);
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
        let launch_append_system_prompt = merge_session_prompts([
            append_system_prompt.map(str::to_string),
            profile_skill_prompt.clone(),
        ]);
        let pure_wsl_codex_launch = wsl.is_some() && cli_tool == CliTool::Codex;
        if !pure_wsl_codex_launch {
            env_vars.extend(provider_vars.clone());
        }
        if let Some(extra_env) = extra_env {
            for (key, value) in extra_env {
                if Self::is_valid_env_key(key) {
                    env_vars.insert(key.clone(), value.clone());
                } else {
                    warn!("Skipping runner env var with invalid key: {}", key);
                }
            }
        }
        let emitter = self.emitter.read().clone().ok_or_else(|| {
            anyhow!("TerminalService not initialized: emitter not set (call set_emitter first)")
        })?;
        let notifier = self.notifier.read().clone().ok_or_else(|| {
            anyhow!("TerminalService not initialized: notifier not set (call set_notifier first)")
        })?;
        let settings_service = self.settings_service.clone();
        let session_id = Uuid::new_v4().to_string();
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
        // （Windows env 默认不进 WSL，必须列出 key；纯字符串用裸 key 即可，无需 /p）
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
            if env_vars.contains_key("CC_PANES_WORKSPACE_SNAPSHOT_ID") {
                wsl_keys.push("CC_PANES_WORKSPACE_SNAPSHOT_ID");
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

        // SSH 模式 vs 本地模式分支
        let (cwd, command, args, env_remove) = if let Some(ssh_info) = ssh {
            // SSH 模式：cwd 用本机 home dir，命令通过 ssh 连接远程
            // 跳过 MCP 注入、Orchestrator 信息注入、--add-dir、--resume、--append-system-prompt
            let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
            let (cmd, cmd_args) =
                self.build_ssh_command(ssh_info, cli_tool, &provider_vars, effective_yolo_mode)?;
            info!(
                session_id = %session_id,
                host = %ssh_info.host,
                remote_path = %ssh_info.remote_path,
                cli_tool = ?cli_tool,
                "create_session: SSH mode"
            );
            (home, cmd, cmd_args, vec![])
        } else if let Some(wsl_info) = wsl {
            let cwd = match workspace_path {
                Some(ws_path) => PathBuf::from(ws_path),
                None => PathBuf::from(project_path),
            };
            let cli_tool_id = cli_tool.as_id();
            let env_remove = WSL_PROXY_ENV_KEYS
                .iter()
                .map(|key| key.to_string())
                .collect::<Vec<_>>();
            strip_wsl_proxy_env_vars(&mut env_vars);
            let mut resolved_wsl = self.resolve_wsl_launch(wsl_info, &session_id)?;

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
                    // 收口 #7：清掉 WSL 内 ~/.codex/config.toml 残留的旧 CC-Panes ccpanes 段
                    // （本地迁移只动 Windows 侧，够不到 WSL Linux 侧这份）。best-effort。
                    if !effective_skip_mcp {
                        cc_cli_adapters::CodexAdapter::migrate_stale_wsl_ccpanes_mcp_config(
                            &resolved_wsl.wsl_path,
                            &resolved_wsl.distro,
                        );
                    }
                    self.ensure_wsl_codex_mcp_registered(
                        &session_id,
                        &resolved_wsl,
                        &env_vars,
                        effective_skip_mcp,
                    )?;
                    self.build_wsl_command(
                        &resolved_wsl,
                        &session_id,
                        &env_vars,
                        &provider_vars,
                        resume_id,
                        launch_append_system_prompt.as_deref(),
                        initial_prompt,
                        effective_skip_mcp,
                        &effective_shared_mcp_urls,
                        &allowed_mcp_server_ids,
                        disable_unlisted_mcp_servers,
                        &selected_mcp_config_toml,
                        effective_yolo_mode,
                    )?
                }
                CliTool::Claude
                | CliTool::Gemini
                | CliTool::Opencode
                | CliTool::Cursor
                | CliTool::Grok => self.build_wsl_supported_cli_command(
                    &resolved_wsl,
                    cli_tool,
                    &session_id,
                    &env_vars,
                    &provider_vars,
                    resume_id,
                    issued_session_id.as_deref(),
                    launch_append_system_prompt.as_deref(),
                    initial_prompt,
                    effective_skip_mcp,
                    effective_yolo_mode,
                )?,
                CliTool::Kimi | CliTool::Glm => self.build_wsl_supported_cli_command(
                    &resolved_wsl,
                    cli_tool,
                    &session_id,
                    &env_vars,
                    &provider_vars,
                    resume_id,
                    issued_session_id.as_deref(),
                    launch_append_system_prompt.as_deref(),
                    initial_prompt,
                    effective_skip_mcp,
                    effective_yolo_mode,
                )?,
            };

            info!(
                session_id = %session_id,
                distro = %resolved_wsl.distro,
                remote_path = %resolved_wsl.remote_path,
                cli_tool = ?cli_tool,
                "create_session: WSL mode"
            );

            (cwd, cmd, cmd_args, env_remove)
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

                // 自动注入 Spec prompt（仅 CLI 工具模式，且无显式 prompt/运行配置 Skill 时）
                let spec_prompt = if launch_append_system_prompt.is_none() {
                    self.generate_spec_prompt(project_path)
                } else {
                    None
                };
                let effective_prompt =
                    merge_session_prompts([launch_append_system_prompt.clone(), spec_prompt]);

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
                    adapter_options: adapter_options.clone(),
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
                };

                let result = adapter.build_command(&ctx)?;
                env_vars.extend(result.env_inject);
                (result.command, result.args, result.env_remove)
            };
            (cwd, cmd, cmd_args, cmd_env_remove)
        };
        let launch_claude = cli_tool != CliTool::None;
        let ssh_auth_runtime = self.prepare_ssh_auth_runtime(ssh)?;

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

        let config = PtyConfig {
            cols,
            rows,
            cwd,
            command,
            args,
            env: env_vars,
            env_remove,
        };

        let spawn_result = match spawn_pty(config) {
            Ok(result) => {
                info!(
                    session_id = %session_id,
                    command = %command_for_log,
                    launch_claude,
                    "create_session: PTY spawned successfully"
                );
                result
            }
            Err(e) => {
                error!(
                    session_id = %session_id,
                    command = %command_for_log,
                    cwd = %cwd_for_log,
                    err = %e,
                    "create_session: PTY spawn FAILED"
                );
                return Err(e);
            }
        };
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
        let replay_buffer = Arc::new(Mutex::new(ReplayBuffer::new(LIVE_REPLAY_MAX_BYTES)));

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

        // 保存会话
        {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| anyhow!("sessions lock poisoned"))?;
            sessions.insert(
                session_id.clone(),
                TerminalSession {
                    launch_id: launch_id.map(str::to_string),
                    process,
                    writer_tx,
                    status: status.clone(),
                    exit_code: exit_code.clone(),
                    last_output_at: last_output_at.clone(),
                    cancelled: cancelled.clone(),
                    output_buffer: output_buffer.clone(),
                    replay_buffer: replay_buffer.clone(),
                },
            );
        }

        // 启动输出批量合并线程（减少 IPC 事件频率，防止 WKWebView 主线程死锁）
        // 策略：累积数据，满足任一条件时刷出：≥16KB 或 ≥16ms 超时
        let (batch_tx, batch_rx) = std::sync::mpsc::channel::<String>();
        let batch_emitter = emitter.clone();
        let batch_sid = session_id.clone();
        thread::spawn(move || {
            const BATCH_SIZE_THRESHOLD: usize = 16384; // 16KB
            const BATCH_TIMEOUT: Duration = Duration::from_millis(16); // ~60fps

            let mut batch = String::with_capacity(BATCH_SIZE_THRESHOLD);
            loop {
                match batch_rx.recv_timeout(BATCH_TIMEOUT) {
                    Ok(data) => {
                        batch.push_str(&data);
                        // 排空通道中已有的数据
                        while let Ok(more) = batch_rx.try_recv() {
                            batch.push_str(&more);
                            if batch.len() >= BATCH_SIZE_THRESHOLD {
                                break;
                            }
                        }
                        // 达到大小阈值则立即刷出
                        if batch.len() >= BATCH_SIZE_THRESHOLD {
                            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                let _ = batch_emitter.emit(
                                    EV::TERMINAL_OUTPUT,
                                    serde_json::to_value(&TerminalOutput {
                                        session_id: batch_sid.clone(),
                                        data: std::mem::take(&mut batch),
                                    })
                                    .unwrap_or_default(),
                                );
                            }));
                            batch = String::with_capacity(BATCH_SIZE_THRESHOLD);
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        // 超时：刷出累积的数据（保证低吞吐场景下数据不滞留）
                        if !batch.is_empty() {
                            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                let _ = batch_emitter.emit(
                                    EV::TERMINAL_OUTPUT,
                                    serde_json::to_value(&TerminalOutput {
                                        session_id: batch_sid.clone(),
                                        data: std::mem::take(&mut batch),
                                    })
                                    .unwrap_or_default(),
                                );
                            }));
                            batch = String::with_capacity(BATCH_SIZE_THRESHOLD);
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        // 读取线程退出，刷出残留数据
                        if !batch.is_empty() {
                            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                let _ = batch_emitter.emit(
                                    EV::TERMINAL_OUTPUT,
                                    serde_json::to_value(&TerminalOutput {
                                        session_id: batch_sid.clone(),
                                        data: batch,
                                    })
                                    .unwrap_or_default(),
                                );
                            }));
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
            loop {
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
                        if !hook_active {
                            let mut prev = prev_status.lock().unwrap_or_else(|e| {
                                warn!("prev_status lock poisoned, using fallback value");
                                e.into_inner()
                            });
                            if *prev != SessionStatus::WaitingInput
                                && new_status == SessionStatus::WaitingInput
                            {
                                read_notifier.notify_waiting_input(&sid);
                            }
                            *prev = new_status;
                        }

                        let normalized_prompt = normalize_prompt_text(&data);

                        // 追加到原始 VT 回放缓冲区
                        if let Ok(mut replay) = read_replay_buffer.lock() {
                            replay.push(&data);
                        }

                        // 追加到纯文本输出缓冲区
                        if let Ok(mut buf) = read_output_buffer.lock() {
                            buf.push(&data);
                        }

                        // 发送到批量合并线程（替代直接 emit，降低 IPC 频率）
                        let _ = batch_tx.send(data.clone());

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
                                        let password = format!("{}\n", runtime.saved_password);
                                        if write_via_writer_tx(
                                            &read_writer_tx,
                                            password.into_bytes(),
                                        )
                                        .is_ok()
                                        {
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
                }
            }

            // 标记为已退出
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

        info!(session_id = %session_id, project = %project_path, launch_claude, "Terminal session created");
        Ok(session_id)
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
    pub fn write(&self, session_id: &str, data: &str) -> Result<()> {
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

    /// 原子提交一条用户消息：清洗换行后写入文本，短延迟，再单独发送 Enter。
    pub fn submit_text_to_session(&self, session_id: &str, text: &str) -> AppResult<()> {
        if text.len() > SUBMIT_TEXT_MAX_BYTES {
            // fix(H1) review: submit 文本后端限制 256KB。
            return Err(AppError::from(format!(
                "submit_to_session text must be <= {} bytes",
                SUBMIT_TEXT_MAX_BYTES
            )));
        }

        let clean_text = text.replace(['\r', '\n'], "");
        let text_len = clean_text.len();
        let mutex = self.input_mutex_for_session(session_id)?;
        let _guard = mutex
            .lock()
            .map_err(|_| AppError::from("terminal input lock poisoned"))?;

        // fix(C2) review: 持有 per-session 锁覆盖“写文本 + sleep + 写 Enter”的完整序列。
        self.write_unlocked(session_id, &clean_text)
            .map_err(AppError::from)?;
        let delay_ms = std::cmp::min(200 + (text_len as u64 / 512) * 30, 5000);
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
        if let Ok(mut input_mutexes) = self.input_mutexes.lock() {
            input_mutexes.remove(session_id);
        }
        wsl_codex::cleanup_session_mcp_configs(self.app_paths.data_dir(), session_id);

        if let Some(session) = session {
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
            // 标记为已退出，防止等待线程在 kill 后重复发送事件
            {
                let mut s = session.status.lock().unwrap_or_else(|e| e.into_inner());
                *s = SessionStatus::Exited;
            }
            let _ = session.process.kill();
            // 广播 kill 事件（带来源），前端据 reason 决定关标签还是保留显示退出
            if let Some(emitter) = self.emitter.read().as_ref() {
                let _ = emitter.emit(
                    EV::SESSION_KILLED,
                    serde_json::json!({ "sessionId": session_id, "reason": reason }),
                );
            }
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
            for (_, session) in sessions.drain() {
                // 先设置取消标志，通知 reader 线程停止（与 kill() 保持一致）
                session.cancelled.store(true, Ordering::Relaxed);
                {
                    let mut s = session.status.lock().unwrap_or_else(|e| e.into_inner());
                    *s = SessionStatus::Exited;
                }
                let _ = session.process.kill();
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
        }
    }

    /// 构建 SSH 命令
    ///
    /// 生成 `ssh -tt [keepalive opts] [-p port] [-i identity_file] [user@]host 'export K=V && ... && cd path && cli_tool'`
    fn build_ssh_command(
        &self,
        ssh: &SshConnectionInfo,
        cli_tool: CliTool,
        provider_env: &HashMap<String, String>,
        yolo_mode: bool,
    ) -> Result<(String, Vec<String>)> {
        let ssh_path = cached_which("ssh").map_err(|_| anyhow!("ssh not found in PATH"))?;

        let mut args = vec!["-tt".to_string()]; // 强制伪终端，避免远端 TUI 降级
        append_ssh_session_options(&mut args);
        if ssh.port != 22 {
            args.extend(["-p".to_string(), ssh.port.to_string()]);
        }
        if let Some(ref id) = ssh.identity_file {
            args.extend(["-i".to_string(), id.clone()]);
        }

        // user@host 或仅 host
        let target = match &ssh.user {
            Some(u) => format!("{}@{}", u, ssh.host),
            None => ssh.host.clone(),
        };
        args.push(target);

        // 构建远程命令
        let mut remote_parts: Vec<String> = Vec::new();

        // Provider 环境变量注入（白名单 key 格式 + value 转义）
        if cli_tool != CliTool::None {
            for (k, v) in provider_env {
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
        remote_parts.push(Self::ssh_remote_cli_command(cli_tool, yolo_mode).to_string());
        args.push(remote_parts.join(" && "));

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
    use crate::models::shared_mcp::{BridgeMode, SharedMcpServerConfig};
    use crate::services::{ProjectCliHooksService, ProviderService, SettingsService};
    use crate::utils::orchestrator_manifest::ORCHESTRATOR_MANIFEST_FILE;
    use crate::utils::AppPaths;
    use std::io;

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

    struct FakePtyProcess;

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
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let app_paths = Arc::new(AppPaths::new(Some(
            temp_dir.path().to_string_lossy().to_string(),
        )));
        let cli_registry = Arc::new(CliToolRegistry::new());
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

    #[test]
    fn kill_with_reason_keeps_not_found_semantics_for_missing_session() {
        let (service, _temp_dir) = terminal_service_for_test();

        let error = service
            .kill_with_reason("missing-session", KillReason::OrphanReclaim)
            .expect_err("missing session must error");

        assert!(matches!(error, AppError::NotFound(_)));
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
        let writer_tx =
            spawn_terminal_writer(session_id.to_string(), Box::new(RecordingWriter { writes }));
        service
            .sessions
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(
                session_id.to_string(),
                TerminalSession {
                    launch_id: None,
                    process: Arc::new(FakePtyProcess),
                    writer_tx,
                    status: Arc::new(Mutex::new(SessionStatus::Idle)),
                    exit_code: Arc::new(Mutex::new(None)),
                    last_output_at: Arc::new(Mutex::new(Instant::now())),
                    cancelled: Arc::new(AtomicBool::new(false)),
                    output_buffer: Arc::new(Mutex::new(OutputBuffer::new(10, 1024))),
                    replay_buffer: Arc::new(Mutex::new(ReplayBuffer::new(1024))),
                },
            );
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
    fn write_waits_for_in_flight_submit_enter() {
        let (service, _temp_dir) = terminal_service_for_test();
        let writes = Arc::new(Mutex::new(Vec::new()));
        install_recording_session(&service, "session-1", writes.clone());

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
                == ["alpha"];
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
        assert_eq!(writes, vec!["alpha", "\r", "z"]);
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
