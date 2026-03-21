use crate::constants::events as EV;
use crate::events::{EventEmitter, SessionNotifier};
use crate::models::{CliTool, SshConnectionInfo, TerminalExit, TerminalOutput};
use crate::pty::{spawn_pty, PtyConfig, PtyProcess};
use crate::services::{ProviderService, SettingsService, SpecService};
use crate::utils::AppPaths;
use anyhow::{anyhow, Result};
use cc_cli_adapters::{CliAdapterContext, CliToolRegistry};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

/// 解析默认 Shell
/// Windows: 优先 pwsh > powershell > cmd
/// Unix: 使用 $SHELL 或 /bin/sh
fn resolve_default_shell() -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        // 优先 PowerShell 7
        if which::which("pwsh").is_ok() {
            return ("pwsh".to_string(), vec![]);
        }
        // PowerShell 5.1
        if which::which("powershell").is_ok() {
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
        if let Ok(path) = which::which("pwsh") {
            shells.push(ShellInfo::new("pwsh", "PowerShell 7", &path.to_string_lossy()));
        }
        // 2. PowerShell 5.1
        if let Ok(path) = which::which("powershell") {
            shells.push(ShellInfo::new("powershell", "Windows PowerShell", &path.to_string_lossy()));
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
        if which::which("wsl").is_ok() {
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
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionStatus {
    Active,
    Idle,
    WaitingInput,
    Exited,
}

/// 终端会话状态信息
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatusInfo {
    pub session_id: String,
    pub status: SessionStatus,
    pub last_output_at: u64, // 毫秒时间戳
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

/// 读取终端输出的返回类型
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOutput {
    pub session_id: String,
    pub lines: Vec<String>,
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

    /// 获取最近 N 行（0 = 全部）
    fn get_recent(&self, n: usize) -> Vec<String> {
        if n == 0 || n >= self.lines.len() {
            self.lines.iter().cloned().collect()
        } else {
            self.lines.iter().skip(self.lines.len() - n).cloned().collect()
        }
    }
}

/// 终端会话
struct TerminalSession {
    process: Arc<dyn PtyProcess>,
    writer: Box<dyn Write + Send>,
    status: Arc<Mutex<SessionStatus>>,
    last_output_at: Arc<Mutex<Instant>>,
    /// reader 线程取消标志：kill() 设置为 true，reader 线程检查后退出
    cancelled: Arc<AtomicBool>,
    /// 输出缓冲区（ANSI 已剥离的纯文本行）
    output_buffer: Arc<Mutex<OutputBuffer>>,
}

/// Orchestrator 连接信息（port + token），启动后注入
#[derive(Debug, Clone)]
pub struct OrchestratorInfo {
    pub port: u16,
    pub token: String,
}

/// 已退出会话的缓冲区条目：(缓冲区, 退出时间)
type DeadBufferEntry = (Arc<Mutex<OutputBuffer>>, Instant);

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
    /// Spec 服务（终端启动时自动注入 active spec prompt）
    spec_service: Mutex<Option<Arc<SpecService>>>,
    /// CLI 工具适配器注册表
    cli_registry: Arc<CliToolRegistry>,
}

/// ConPTY style-only 空闲帧：\x1b[39m\x1b[49m\x1b[59m\x1b[0m\x1b[?25l  (25 字节)
const CONPTY_STYLE_ONLY: &[u8] = b"\x1b[39m\x1b[49m\x1b[59m\x1b[0m\x1b[?25l";

/// 跨块缓冲状态，仅保留 carry 用于处理被拆分到两次 read() 的模式
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
        if i + CONPTY_STYLE_ONLY.len() <= data.len()
            && data[i..].starts_with(CONPTY_STYLE_ONLY)
        {
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
fn utf8_safe_process(buf: &[u8], carry: &mut Vec<u8>) -> Option<String> {
    let mut combined = Vec::with_capacity(carry.len() + buf.len());
    combined.extend_from_slice(carry);
    combined.extend_from_slice(buf);
    carry.clear();

    // 检测末尾不完整 UTF-8 序列（UTF-8 最长 4 字节，需检查末尾 4 字节）
    let mut valid_end = combined.len();
    for i in (combined.len().saturating_sub(4)..combined.len()).rev() {
        let byte = combined[i];
        if byte & 0x80 == 0 {
            // ASCII — 完整
            break;
        }
        if byte & 0xC0 == 0xC0 {
            // 多字节起始字节
            let expected_len = if byte & 0xF8 == 0xF0 { 4 }
                else if byte & 0xF0 == 0xE0 { 3 }
                else if byte & 0xE0 == 0xC0 { 2 }
                else { 1 };
            let actual_len = combined.len() - i;
            if actual_len < expected_len {
                valid_end = i;
            }
            break;
        }
    }

    if valid_end < combined.len() {
        carry.extend_from_slice(&combined[valid_end..]);
        combined.truncate(valid_end);
    }

    if combined.is_empty() {
        return None;
    }

    Some(String::from_utf8_lossy(&combined).to_string())
}

impl TerminalService {
    pub fn new(
        settings_service: Arc<SettingsService>,
        provider_service: Arc<ProviderService>,
        app_paths: Arc<AppPaths>,
        cli_registry: Arc<CliToolRegistry>,
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
            spec_service: Mutex::new(None),
            cli_registry,
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

    /// 创建新的终端会话
    #[allow(clippy::too_many_arguments)]
    pub fn create_session(
        &self,
        project_path: &str,
        cols: u16,
        rows: u16,
        workspace_name: Option<&str>,
        provider_id: Option<&str>,
        workspace_path: Option<&str>,
        cli_tool: CliTool,
        resume_id: Option<&str>,
        skip_mcp: bool,
        append_system_prompt: Option<&str>,
        ssh: Option<&SshConnectionInfo>,
    ) -> Result<String> {
        let is_ssh = ssh.is_some();
        let mut env_vars = self.settings_service.get_proxy_env_vars();
        let provider_vars = self.provider_service.get_env_vars(provider_id);
        env_vars.extend(provider_vars.clone());
        let emitter = self.emitter.read().clone()
            .ok_or_else(|| anyhow!("TerminalService not initialized: emitter not set (call set_emitter first)"))?;
        let notifier = self.notifier.read().clone()
            .ok_or_else(|| anyhow!("TerminalService not initialized: notifier not set (call set_notifier first)"))?;
        let settings_service = self.settings_service.clone();
        let session_id = Uuid::new_v4().to_string();

        // 注入 TERM 环境变量（Windows 上需要）
        #[cfg(windows)]
        {
            env_vars.insert("TERM".to_string(), "xterm-256color".to_string());
        }

        // 解析 Shell 配置
        let shell_id = self
            .settings_service
            .get_settings()
            .terminal
            .shell
            .clone();

        let _ = workspace_name;

        // 注入 Orchestrator API 信息到所有 PTY 会话（仅本地模式）
        if !is_ssh {
            if let Ok(info_guard) = self.orchestrator_info.lock() {
                if let Some(info) = info_guard.as_ref() {
                    env_vars.insert("CC_PANES_API_PORT".to_string(), info.port.to_string());
                    env_vars.insert("CC_PANES_API_TOKEN".to_string(), info.token.clone());
                }
            }
        }

        // SSH 模式 vs 本地模式分支
        let (cwd, command, args, env_remove) = if let Some(ssh_info) = ssh {
            // SSH 模式：cwd 用本机 home dir，命令通过 ssh 连接远程
            // 跳过 MCP 注入、Orchestrator 信息注入、--add-dir、--resume、--append-system-prompt
            let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
            let (cmd, cmd_args) = self.build_ssh_command(ssh_info, cli_tool, &provider_vars)?;
            info!(
                session_id = %session_id,
                host = %ssh_info.host,
                remote_path = %ssh_info.remote_path,
                cli_tool = ?cli_tool,
                "create_session: SSH mode"
            );
            (home, cmd, cmd_args, vec![])
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
                (c, shell_args, vec![])
            } else {
                let adapter = self.cli_registry.get(cli_tool_id).ok_or_else(|| {
                    anyhow!("Unknown CLI tool: {}", cli_tool_id)
                })?;

                // 自动注入 Spec prompt（仅 CLI 工具模式，且无显式 append_system_prompt 时）
                let spec_prompt = if append_system_prompt.is_none() {
                    self.generate_spec_prompt(project_path)
                } else {
                    None
                };
                let effective_prompt = append_system_prompt
                    .map(|s| s.to_string())
                    .or(spec_prompt);

                let orch_info = self.orchestrator_info.lock().ok().and_then(|g| g.clone());
                let ctx = CliAdapterContext {
                    session_id: session_id.clone(),
                    project_path: project_path.to_string(),
                    workspace_path: workspace_path.map(|s| s.to_string()),
                    resume_id: resume_id.map(|s| s.to_string()),
                    skip_mcp,
                    append_system_prompt: effective_prompt,
                    orchestrator_port: orch_info.as_ref().map(|i| i.port),
                    orchestrator_token: orch_info.as_ref().map(|i| i.token.clone()),
                    data_dir: self.app_paths.data_dir().to_path_buf(),
                };

                let result = adapter.build_command(&ctx)?;
                env_vars.extend(result.env_inject);
                (result.command, result.args, result.env_remove)
            };
            (cwd, cmd, cmd_args, cmd_env_remove)
        };
        let launch_claude = cli_tool != CliTool::None;

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
        let mut reader = spawn_result.reader;
        let writer = spawn_result.writer;
        let process = spawn_result.process;

        // 状态追踪
        let status = Arc::new(Mutex::new(SessionStatus::Active));
        let last_output_at = Arc::new(Mutex::new(Instant::now()));
        let cancelled = Arc::new(AtomicBool::new(false));
        // 输出缓冲区：2000 行 / 512KB 上限
        let output_buffer = Arc::new(Mutex::new(OutputBuffer::new(2000, 512 * 1024)));

        // sanitize 可开关兜底（默认关闭 — dwFlags=0 应该解决了根本问题）
        #[cfg(windows)]
        let disable_sanitize = self
            .settings_service
            .get_settings()
            .terminal
            .disable_conpty_sanitize
            .unwrap_or(true);

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
                    process,
                    writer,
                    status: status.clone(),
                    last_output_at: last_output_at.clone(),
                    cancelled: cancelled.clone(),
                    output_buffer: output_buffer.clone(),
                },
            );
        }

        // 启动读取线程（含状态检测 + UTF-8 安全）
        let sid = session_id.clone();
        let read_emitter = emitter.clone();
        let read_status = status.clone();
        let read_last_output = last_output_at.clone();
        let read_cancelled = cancelled.clone();
        let read_notifier = notifier.clone();
        let _settings_svc = settings_service.clone();
        let read_output_buffer = output_buffer.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let prev_status = Mutex::new(SessionStatus::Active);
            let mut utf8_carry: Vec<u8> = Vec::new();
            let mut first_output = true;
            let mut last_emitted_status = SessionStatus::Active;
            let mut last_status_emit_time = Instant::now();
            #[cfg(windows)]
            let mut sanitize_state = WindowsOutputSanitizeState::default();
            loop {
                if read_cancelled.load(Ordering::Relaxed) {
                    break;
                }
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        // 首次输出诊断日志（含 hex），用于排查前端事件注册竞态
                        if first_output {
                            let hex: String = buf[..n].iter().map(|b| format!("{:02x}", b)).collect::<Vec<_>>().join(" ");
                            info!("[pty-read] session={} first output: {} bytes, hex=[{}]", sid, n, hex);
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

                        // 更新状态
                        {
                            let mut ts = read_last_output.lock().unwrap_or_else(|e| {
                                warn!("last_output_at lock poisoned, using fallback value");
                                e.into_inner()
                            });
                            *ts = Instant::now();
                        }

                        // 推断状态
                        let new_status = infer_status(&data);
                        {
                            let mut s = read_status.lock().unwrap_or_else(|e| {
                                warn!("read_status lock poisoned, using fallback value");
                                e.into_inner()
                            });
                            *s = new_status;
                        }

                        // 检测状态变更并触发通知
                        {
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

                        // 追加到输出缓冲区（在 emit 之前，避免 data 被 move）
                        if let Ok(mut buf) = read_output_buffer.lock() {
                            buf.push(&data);
                        }

                        // 直接 emit，用 catch_unwind 保护
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            let _ = read_emitter.emit(
                                EV::TERMINAL_OUTPUT,
                                serde_json::to_value(&TerminalOutput {
                                    session_id: sid.clone(),
                                    data,
                                }).unwrap_or_default(),
                            );
                        }));

                        // 发送状态事件（节流：仅在 status 变化或距上次发射 ≥2s 时发射）
                        let now_instant = Instant::now();
                        let status_changed = new_status != last_emitted_status;
                        let time_elapsed = now_instant.duration_since(last_status_emit_time)
                            >= std::time::Duration::from_secs(2);

                        if status_changed || time_elapsed {
                            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                let _ = read_emitter.emit(
                                    EV::TERMINAL_STATUS,
                                    serde_json::to_value(&SessionStatusInfo {
                                        session_id: sid.clone(),
                                        status: new_status,
                                        last_output_at: std::time::SystemTime::now()
                                            .duration_since(std::time::UNIX_EPOCH)
                                            .unwrap_or_default()
                                            .as_millis()
                                            as u64,
                                    }).unwrap_or_default(),
                                );
                            }));
                            last_emitted_status = new_status;
                            last_status_emit_time = now_instant;
                        }
                    }
                    Err(e) => {
                        warn!("Terminal read error: {}", e);
                        break;
                    }
                }
            }
        });

        // 启动等待线程
        let sid = session_id.clone();
        let wait_emitter = emitter;
        let exit_status = status;
        let wait_notifier = notifier;
        let sessions_for_wait = Arc::clone(&self.sessions);
        let dead_buffers_for_wait = Arc::clone(&self.dead_buffers);
        thread::spawn(move || {
            let exit_code = match process_for_wait.wait() {
                Ok(status) => {
                    if status.success() {
                        0
                    } else {
                        1
                    }
                }
                Err(_) => -1,
            };
            info!(session_id = %sid, exit_code, "PTY process exited");

            // 标记为已退出
            {
                let mut s = exit_status.lock().unwrap_or_else(|e| {
                    warn!("exit_status lock poisoned, using fallback value");
                    e.into_inner()
                });
                *s = SessionStatus::Exited;
            }

            // 发送退出通知
            wait_notifier.notify_session_exited(&sid, exit_code);
            wait_notifier.cleanup_session(&sid);

            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _ = wait_emitter.emit(
                    EV::TERMINAL_EXIT,
                    serde_json::to_value(&TerminalExit {
                        session_id: sid.clone(),
                        exit_code,
                    }).unwrap_or_default(),
                );
            }));

            // 发送最终状态
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _ = wait_emitter.emit(
                    EV::TERMINAL_STATUS,
                    serde_json::to_value(&SessionStatusInfo {
                        session_id: sid.clone(),
                        status: SessionStatus::Exited,
                        last_output_at: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64,
                    }).unwrap_or_default(),
                );
            }));

            // 延迟清理会话：等待读取线程完成后移除 session，
            // 防止僵尸会话永久驻留在 HashMap 中
            thread::sleep(std::time::Duration::from_millis(500));
            if let Ok(mut sessions) = sessions_for_wait.lock() {
                // 移除前保存 output_buffer 到 dead_buffers，供事后读取
                if let Some(session) = sessions.remove(&sid) {
                    if let Ok(mut dead) = dead_buffers_for_wait.lock() {
                        dead.insert(sid.clone(), (session.output_buffer, Instant::now()));
                    }
                }
            }
        });

        info!(session_id = %session_id, project = %project_path, launch_claude, "Terminal session created");
        Ok(session_id)
    }

    /// 获取所有会话状态
    pub fn get_all_status(&self) -> Result<Vec<SessionStatusInfo>> {
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
                let adjusted_status = match status {
                    SessionStatus::Active if elapsed.as_secs() > 8 => SessionStatus::Idle,
                    other => other,
                };

                SessionStatusInfo {
                    session_id: id.clone(),
                    status: adjusted_status,
                    last_output_at: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64
                        - elapsed.as_millis() as u64,
                }
            })
            .collect())
    }

    /// 向终端写入数据（分块写入防止 ConPTY 大缓冲丢字符）
    ///
    /// 多 chunk 写入时，每个 chunk 单独获取/释放锁，并在 chunk 间添加延迟，
    /// 避免 Windows ConPTY 输入缓冲溢出导致丢字符。
    pub fn write(&self, session_id: &str, data: &str) -> Result<()> {
        let bytes = data.as_bytes();
        const CHUNK_SIZE: usize = 2048;
        const INTER_CHUNK_DELAY_MS: u64 = 10;

        let chunks: Vec<&[u8]> = bytes.chunks(CHUNK_SIZE).collect();

        for (i, chunk) in chunks.iter().enumerate() {
            {
                let mut sessions = self
                    .sessions
                    .lock()
                    .map_err(|_| anyhow!("sessions lock poisoned"))?;
                let session = sessions
                    .get_mut(session_id)
                    .ok_or_else(|| anyhow!("Session not found: {}", session_id))?;
                session.writer.write_all(chunk)?;
                session.writer.flush()?;
            } // 锁在此释放

            // 多 chunk 时，非最后一个 chunk 后添加延迟，让 ConPTY 消化输入
            if chunks.len() > 1 && i < chunks.len() - 1 {
                std::thread::sleep(std::time::Duration::from_millis(INTER_CHUNK_DELAY_MS));
            }
        }
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

    /// 关闭终端会话
    pub fn kill(&self, session_id: &str) -> Result<()> {
        debug!(session_id = %session_id, "Terminal kill requested");
        // 在 sessions lock 外 drop session，避免 ConPTY writer 关闭时阻塞锁
        let session = {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| anyhow!("sessions lock poisoned"))?;
            sessions.remove(session_id)
        }; // sessions lock 在此释放

        if let Some(session) = session {
            // 保存 output_buffer 到 dead_buffers，供事后读取
            if let Ok(mut dead) = self.dead_buffers.lock() {
                dead.insert(session_id.to_string(), (Arc::clone(&session.output_buffer), Instant::now()));
            }
            // 设置取消标志，通知 reader 线程停止 emit 事件
            session.cancelled.store(true, Ordering::Relaxed);
            // 标记为已退出，防止等待线程在 kill 后重复发送事件
            {
                let mut s = session.status.lock().unwrap_or_else(|e| e.into_inner());
                *s = SessionStatus::Exited;
            }
            let _ = session.process.kill();
            // session 在此 drop，writer handle 关闭 — 不再持有 sessions lock
            Ok(())
        } else {
            Err(anyhow!("Session not found: {}", session_id))
        }
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
            sessions.get(session_id).map(|s| Arc::clone(&s.output_buffer))
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
                dead.retain(|_, (_, created_at)| created_at.elapsed().as_secs() < 300);
                dead.get(session_id)
                    .map(|(arc, _)| Arc::clone(arc))
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

    /// 构建 SSH 命令
    ///
    /// 生成 `ssh -t [-p port] [-i identity_file] [user@]host 'export K=V && ... && cd path && cli_tool'`
    fn build_ssh_command(
        &self,
        ssh: &SshConnectionInfo,
        cli_tool: CliTool,
        provider_env: &HashMap<String, String>,
    ) -> Result<(String, Vec<String>)> {
        let ssh_path = which::which("ssh")
            .map_err(|_| anyhow!("ssh not found in PATH"))?;

        let mut args = vec!["-t".to_string()]; // 强制伪终端
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
        match cli_tool {
            CliTool::None   => remote_parts.push("exec $SHELL -l".into()),
            CliTool::Claude => remote_parts.push("claude".into()),
            CliTool::Codex  => remote_parts.push("codex --full-auto".into()),
        }
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

    #[test]
    fn test_infer_status_empty() {
        assert_eq!(infer_status(""), SessionStatus::Active);
    }

    #[test]
    fn test_infer_status_waiting_prompt() {
        assert_eq!(infer_status("Continue? [Y/n]"), SessionStatus::WaitingInput);
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
        assert_eq!(infer_status("Do you want to continue?"), SessionStatus::WaitingInput);
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
        assert!(output.is_empty(), "pattern D (style-only) should be stripped");
    }

    #[test]
    fn test_strip_full_cursor_redraw_sequence() {
        // 光标重绘: \x1b[27m + \x08 '2' \x1b[7m ' '
        // \x1b[27m 不再被剥离（它是合法的 SGR "关闭反显"），模式 A 仍会被剥离
        let mut input = Vec::new();
        input.extend_from_slice(b"\x1b\x5b\x32\x37\x6d"); // \x1b[27m — 透传
        input.extend_from_slice(b"\x08\x32\x1b\x5b\x37\x6d\x20"); // \x08 '2' \x1b[7m ' ' (模式 A — 剥离)
        let output = strip_conpty_artifacts(&input);
        assert_eq!(output, b"\x1b[27m", "ESC[27m should pass through, only pattern A stripped");
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
        assert_eq!(output, input.to_vec(), "legitimate reverse video sequences must pass through unchanged");
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
        assert!(out.is_empty(), "cursor redraw with variable char '2' should be fully stripped");
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
        assert!(out.is_empty(), "repeated cursor redraw 'k' should also be stripped");
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
        assert_eq!(output, b"\x1b[21;6H2\x1b[7m ", "valid CSI + SGR preserved, only style-only frame stripped");
    }

    // --- detect_shells 测试 ---

    #[test]
    fn test_detect_shells_not_empty() {
        let shells = detect_shells();
        assert!(!shells.is_empty(), "should detect at least one shell");
    }
}
