//! CLI Tool Adapter Layer for CC-Panes
//!
//! 提供 Trait + Registry 架构，让新增 CLI 工具只需实现 `CliToolAdapter` trait 并注册即可。
//!
//! ```text
//! 新增一个 CLI 工具 = 新建一个文件实现 trait + 注册一行代码
//! ```

mod claude;
mod codex;
mod cursor;
mod fs_atomic;
mod gemini;
mod glm;
mod grok;
mod kimi;
mod opencode;

pub use claude::ClaudeAdapter;
pub use codex::CodexAdapter;
pub use cursor::CursorAdapter;
pub use gemini::GeminiAdapter;
pub use glm::GlmAdapter;
pub use grok::GrokAdapter;
pub use kimi::KimiAdapter;
pub use opencode::OpenCodeAdapter;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

/// 创建不弹窗的 Command（Windows 自动设置 CREATE_NO_WINDOW）
///
/// 独立于 cc-panes-core，避免循环依赖。
pub fn no_window_command(program: &str) -> std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new(program);
        cmd.creation_flags(0x08000000);
        cmd
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new(program)
    }
}

/// 带超时执行子进程，返回 stdout（超时或失败返回 None）
///
/// 使用轮询方案，能正确 kill 超时进程，避免僵尸进程。
/// 同时关闭 stdin（`Stdio::null()`），防止子进程因等待输入而卡住。
pub fn run_with_timeout(
    cmd: &std::path::Path,
    args: &[String],
    timeout: Duration,
) -> Option<String> {
    let mut cmd = no_window_command(&cmd.to_string_lossy());
    cmd.args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null());

    let mut child = cmd.spawn().ok()?;

    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => {
                let mut stdout = String::new();
                if let Some(mut out) = child.stdout.take() {
                    use std::io::Read;
                    let _ = out.read_to_string(&mut stdout);
                }
                return Some(stdout.trim().to_string());
            }
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return None,
        }
    }
}

/// Resolve a CLI executable from the process PATH plus common user install
/// locations. macOS GUI apps may start without a login-shell PATH, so relying
/// on `which` alone misses tools installed by nvm/npm, Homebrew, Cargo, etc.
pub fn resolve_executable(executable: &str) -> Result<PathBuf> {
    if let Ok(path) = which::which(executable) {
        return Ok(path);
    }

    find_executable_in_dirs(
        executable,
        &candidate_executable_dirs(),
        &executable_extensions(),
    )
    .ok_or_else(|| {
        anyhow!(
            "{} CLI not found in PATH or common install locations",
            executable
        )
    })
}

fn candidate_executable_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    if let Ok(path_var) = std::env::var("PATH") {
        extend_unique_dirs(&mut dirs, std::env::split_paths(&path_var));
    }

    if let Some(home) = dirs::home_dir() {
        extend_unique_dirs(
            &mut dirs,
            [
                home.join(".cargo").join("bin"),
                home.join(".local").join("bin"),
            ],
        );

        #[cfg(not(windows))]
        {
            for app_dir in [".cc-panes", ".cc-panes-dev"] {
                let cached_path = home.join(app_dir).join("cached_path");
                if let Ok(value) = std::fs::read_to_string(cached_path) {
                    extend_unique_dirs(&mut dirs, std::env::split_paths(value.trim()));
                }
            }

            let nvm_dir = std::env::var_os("NVM_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".nvm"));
            let nvm_versions = nvm_dir.join("versions").join("node");
            if let Ok(entries) = std::fs::read_dir(nvm_versions) {
                let mut node_bins = entries
                    .flatten()
                    .map(|entry| entry.path().join("bin"))
                    .filter(|path| path.is_dir())
                    .collect::<Vec<_>>();
                node_bins.sort();
                node_bins.reverse();
                extend_unique_dirs(&mut dirs, node_bins);
            }
        }

        #[cfg(windows)]
        {
            extend_unique_dirs(
                &mut dirs,
                [
                    home.join("AppData").join("Roaming").join("npm"),
                    home.join("scoop").join("shims"),
                ],
            );
        }
    }

    #[cfg(windows)]
    {
        if let Ok(app_data) = std::env::var("APPDATA") {
            dirs.push(PathBuf::from(app_data).join("npm"));
        }
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            dirs.push(
                PathBuf::from(local_app_data)
                    .join("Microsoft")
                    .join("WinGet")
                    .join("Links"),
            );
        }
        if let Ok(scoop_root) = std::env::var("SCOOP") {
            dirs.push(PathBuf::from(scoop_root).join("shims"));
        }
    }

    #[cfg(not(windows))]
    extend_unique_dirs(
        &mut dirs,
        [
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/opt/homebrew/sbin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/local/sbin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
            PathBuf::from("/usr/sbin"),
            PathBuf::from("/sbin"),
            PathBuf::from("/opt/local/bin"),
        ],
    );

    dedupe_existing_dirs(dirs)
}

fn extend_unique_dirs<I>(dirs: &mut Vec<PathBuf>, incoming: I)
where
    I: IntoIterator<Item = PathBuf>,
{
    for dir in incoming {
        if dir.as_os_str().is_empty() {
            continue;
        }
        if !dirs.iter().any(|existing| existing == &dir) {
            dirs.push(dir);
        }
    }
}

fn dedupe_existing_dirs(dirs: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut result = Vec::new();
    for dir in dirs {
        if !dir.is_dir() {
            continue;
        }
        if !result.iter().any(|existing| existing == &dir) {
            result.push(dir);
        }
    }
    result
}

#[cfg(windows)]
fn executable_extensions() -> Vec<String> {
    let from_env = std::env::var("PATHEXT")
        .ok()
        .map(|value| {
            value
                .split(';')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| {
                    if value.starts_with('.') {
                        value.to_ascii_lowercase()
                    } else {
                        format!(".{}", value.to_ascii_lowercase())
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let defaults = [".exe", ".cmd", ".bat", ".com"];
    let mut ordered = Vec::new();
    for value in from_env
        .into_iter()
        .chain(defaults.into_iter().map(str::to_string))
    {
        if !ordered.iter().any(|existing| existing == &value) {
            ordered.push(value);
        }
    }
    ordered
}

#[cfg(not(windows))]
fn executable_extensions() -> Vec<String> {
    Vec::new()
}

fn find_executable_in_dirs(
    executable: &str,
    dirs: &[PathBuf],
    extensions: &[String],
) -> Option<PathBuf> {
    let has_extension = Path::new(executable).extension().is_some();

    for dir in dirs {
        // Windows（extensions 非空）下扩展名缺失的裸文件不可直接执行——npm 全局
        // 安装会在 .cmd shim 旁放同名 sh 脚本（如 `opencode`），命中它会导致
        // CreateProcess 启动失败，必须继续用 PATHEXT 扩展名探测。
        let direct = dir.join(executable);
        if direct.is_file() && (has_extension || extensions.is_empty()) {
            return Some(direct);
        }

        if has_extension {
            continue;
        }

        for extension in extensions {
            let candidate = dir.join(format!("{}{}", executable, extension));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    None
}

// ============ Trait ============

/// CLI 工具适配器 trait
///
/// 每个 CLI 工具（Claude Code、Codex、Kilo 等）实现此 trait，
/// 提供元信息、能力声明、命令构建逻辑。
pub trait CliToolAdapter: Send + Sync {
    /// 工具元信息（缓存引用，避免每次堆分配）
    fn info(&self) -> &CliToolInfo;

    /// 能力声明（前端据此决定 UI 展示）
    fn capabilities(&self) -> &CliToolCapabilities;

    /// 构建启动命令（核心方法，含 MCP 注入逻辑）
    fn build_command(&self, ctx: &CliAdapterContext) -> Result<CliCommandResult>;

    /// 用户全局命令目录。None = 不支持全局命令注入
    fn global_commands_dir(&self) -> Option<std::path::PathBuf> {
        None
    }

    /// 用户全局技能目录。None = 不支持技能注入
    fn global_skills_dir(&self) -> Option<std::path::PathBuf> {
        None
    }

    /// 项目级 hooks 定义。默认不支持
    fn project_hooks(&self) -> Vec<ProjectHookDefinition> {
        Vec::new()
    }

    /// 读取某个项目下的 hooks 当前状态。
    /// 默认返回空数组，表示该工具不支持项目级 hooks。
    fn get_project_hook_statuses(&self, _project_path: &Path) -> Result<Vec<ProjectHookStatus>> {
        Ok(Vec::new())
    }

    /// 将目标 hook 状态同步到项目配置中。
    /// `hook_binary_path` 在所有 hook 都关闭时可以为 None。
    fn sync_project_hooks(
        &self,
        _project_path: &Path,
        _hook_binary_path: Option<&Path>,
        _desired: &HashMap<String, bool>,
    ) -> Result<()> {
        Ok(())
    }

    /// 把 cc-pane 抽象事件映射为该 CLI 的原生 hook 绑定。
    ///
    /// 默认返回 `None`，表示该 CLI 不支持此事件（adapter 可按需 override）。
    /// 同步层在写配置时会跳过返回 `None` 的事件，并把 `unsupported_reason` 暴露给前端展示。
    fn map_cc_pane_event(&self, _event: &CcPaneEvent) -> Option<NativeHookBinding> {
        None
    }

    /// 当某个 cc-pane 事件不被支持时，给出原因（前端展示）。
    /// 默认 `None`，表示该 CLI 完全不支持 cc-pane 事件层。
    fn unsupported_cc_pane_event_reason(&self, _event: &CcPaneEvent) -> Option<&'static str> {
        None
    }

    /// 把 cc-pane ToolMatcher 翻译成该 CLI 原生 matcher 字符串。
    /// 默认 `None`（不支持工具 matcher 的细粒度翻译）。
    fn render_cc_pane_tool_matcher(&self, _matcher: &ToolMatcher) -> Option<String> {
        None
    }

    /// 环境检测（默认实现: which + --version，带 5s 超时）
    fn detect(&self) -> CliToolInfo {
        let mut info = self.info().clone();
        match resolve_executable(&info.executable) {
            Ok(path) => {
                info.installed = true;
                info.path = Some(path.to_string_lossy().into_owned());
                info.version = run_with_timeout(&path, &info.version_args, Duration::from_secs(5));
            }
            Err(_) => {
                info.installed = false;
            }
        }
        info.capabilities = Some(self.capabilities().clone());
        info
    }
}

// ============ 类型定义 ============

/// 工具元信息
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CliToolInfo {
    pub id: String,
    pub display_name: String,
    pub executable: String,
    #[serde(default)]
    pub version_args: Vec<String>,
    #[serde(default)]
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<CliToolCapabilities>,
}

/// 能力声明（前端据此决定 UI 展示）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CliToolCapabilities {
    /// 显示 Provider 子菜单
    pub supports_provider: bool,
    /// 显示 Resume 按钮
    pub supports_resume: bool,
    /// 启动时处理 MCP
    pub supports_mcp: bool,
    /// 注入 Spec prompt
    pub supports_system_prompt: bool,
    /// 支持 --add-dir
    pub supports_workspace: bool,
    /// 支持项目级 hooks 配置
    pub supports_project_hooks: bool,
    /// 支持 CC-Panes 为新会话预发确定性 session id（如 Claude/Grok 的 `--session-id`），
    /// 使 resume id 在启动前即确定，无需事后捕获
    #[serde(default)]
    pub supports_issued_session_id: bool,
    /// 兼容的 Provider 类型列表
    #[serde(default)]
    pub compatible_provider_types: Vec<String>,
}

/// 项目级 hook 定义
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectHookDefinition {
    pub name: String,
    pub label: String,
}

/// 某项目下 hook 的状态
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectHookStatus {
    pub name: String,
    pub label: String,
    pub enabled: bool,
    pub supported: bool,
    pub reason: Option<String>,
}

/// 构建命令的上下文（扁平字段，避免依赖主 crate 类型）
pub struct CliAdapterContext {
    pub session_id: String,
    pub project_path: String,
    pub workspace_path: Option<String>,
    pub provider: Option<CliProvider>,
    /// Optional executable override from CC-Panes settings. This replaces only
    /// the executable used to launch the adapter; the adapter still owns args.
    pub executable_override: Option<String>,
    /// Per-launch adapter options keyed by CLI tool specific option names.
    pub adapter_options: HashMap<String, serde_json::Value>,
    pub resume_id: Option<String>,
    /// CC-Panes 预先发号的会话 id（仅新会话）。Claude 通过 `--session-id` 使用，
    /// 使 resume id 在启动前即确定，替代事后扫目录反查。
    pub issued_session_id: Option<String>,
    pub skip_mcp: bool,
    /// 本次启动是否启用 YOLO 模式（绕过 CLI 权限确认/沙箱提示）。
    pub yolo_mode: bool,
    pub append_system_prompt: Option<String>,
    /// 初始用户 prompt（作为 CLI 位置参数传递，显示为首条用户消息）
    pub initial_prompt: Option<String>,
    /// Orchestrator HTTP 端口
    pub orchestrator_port: Option<u16>,
    /// Orchestrator Bearer Token
    pub orchestrator_token: Option<String>,
    /// 本次启动的 launch_id（用于在 MCP URL 上附带 caller 身份，
    /// 让 Orchestrator 自动识别"是哪个 Claude 在调用 launch_task"）。
    pub launch_id: Option<String>,
    /// 数据目录（用于写入 MCP 配置文件等）
    pub data_dir: PathBuf,
    /// 共享 MCP Server URL 映射（name → http url）
    /// 非空时 generate_mcp_config 会跳过同名 stdio 配置并注入 HTTP 版本
    #[allow(dead_code)]
    pub shared_mcp_urls: HashMap<String, String>,
    /// 运行配置允许保留的 MCP server id。
    /// Codex 需要这个列表来禁用用户 config.toml 中未被本次运行配置选中的 MCP。
    #[allow(dead_code)]
    pub allowed_mcp_server_ids: Vec<String>,
    /// 为 true 时，Codex 启动会把 config.toml 里不在 allowed_mcp_server_ids 的 MCP
    /// 通过 per-launch override 显式 disabled，避免运行配置筛选后仍继承用户全局 MCP。
    #[allow(dead_code)]
    pub disable_unlisted_mcp_servers: bool,
}

impl CliAdapterContext {
    pub fn command_override(&self) -> Option<&str> {
        self.executable_override
            .as_deref()
            .map(normalize_cli_command)
            .filter(|value| !value.is_empty())
    }

    pub fn resolve_command(&self, executable: &str) -> Result<String> {
        if let Some(command) = self.command_override() {
            return Ok(command.to_string());
        }
        resolve_executable(executable).map(|path| path.to_string_lossy().into_owned())
    }

    /// 解析可执行文件并在 Windows 上把 npm `.cmd`/`.bat` shim 改写为可被 PTY
    /// (`CreateProcess`) 直接启动的命令。
    ///
    /// PTY 在 Windows 上通过 `CreateProcess` 拉起进程，无法直接执行 `.cmd`/`.bat`
    /// 批处理文件——而 npm 全局安装的 CLI（opencode/gemini/kimi/crush/cursor 等）
    /// 解析出来的正是 `.cmd` shim。此方法负责把 `.cmd` 改写为 `node <entry>` 形式。
    ///
    /// 用户显式 override 的命令不做改写，原样透传。
    pub fn resolve_launch(
        &self,
        executable: &str,
        args: Vec<String>,
    ) -> Result<(String, Vec<String>)> {
        if let Some(command) = self.command_override() {
            return Ok((command.to_string(), args));
        }
        let path = resolve_executable(executable)?;
        Ok(rewrite_windows_npm_shim(
            path.to_string_lossy().into_owned(),
            args,
        ))
    }
}

/// adapter_options 约定键（effort/extraArgs/verbose/maxTurns）的解析 helper，
/// 供 claude/codex adapter 与 WSL 命令构建复用。
///
/// effort 六档：low/medium/high/xhigh/max（default 或未知值视为未设置）。
pub fn effort_from_options(options: &HashMap<String, serde_json::Value>) -> Option<String> {
    options
        .get("effort")
        .and_then(serde_json::Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| matches!(value.as_str(), "low" | "medium" | "high" | "xhigh" | "max"))
}

pub fn extra_args_from_options(options: &HashMap<String, serde_json::Value>) -> Vec<String> {
    options
        .get("extraArgs")
        .and_then(serde_json::Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_string)
                .filter(|value| !value.trim().is_empty())
                .collect()
        })
        .unwrap_or_default()
}

pub fn verbose_from_options(options: &HashMap<String, serde_json::Value>) -> bool {
    options
        .get("verbose")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

pub fn max_turns_from_options(options: &HashMap<String, serde_json::Value>) -> Option<u64> {
    options.get("maxTurns").and_then(serde_json::Value::as_u64)
}

/// Codex `-c model_reasoning_effort=<v>` 的取值：codex 无 max 档，max 映射为 xhigh。
pub fn codex_reasoning_effort(effort: &str) -> Option<&'static str> {
    match effort {
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" | "max" => Some("xhigh"),
        _ => None,
    }
}

/// Claude 无 --effort flag，effort 经 `MAX_THINKING_TOKENS` 环境变量注入思考预算。
pub fn claude_max_thinking_tokens(effort: &str) -> Option<u32> {
    match effort {
        "low" => Some(4096),
        "medium" => Some(10000),
        "high" => Some(16000),
        "xhigh" => Some(31999),
        "max" => Some(63999),
        _ => None,
    }
}

/// 判断路径是否为 Windows 批处理 shim（`.cmd`/`.bat`）。
#[cfg(any(windows, test))]
fn is_windows_batch_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            let ext = ext.to_ascii_lowercase();
            ext == "cmd" || ext == "bat"
        })
        .unwrap_or(false)
}

/// 判断 shim 入口是否为 Windows PE 原生二进制（`.exe`）。这类入口必须直接
/// 运行，不能作为脚本传给 `node`。
#[cfg(any(windows, test))]
fn is_pe_binary(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("exe"))
        .unwrap_or(false)
}

/// 为 npm shim 寻找 `node` 可执行文件：优先 shim 同目录的 `node.exe`，否则 PATH。
#[cfg(any(windows, test))]
fn node_for_npm_shim(shim_path: &Path) -> Option<PathBuf> {
    if let Some(dir) = shim_path.parent() {
        let adjacent_node = dir.join("node.exe");
        if adjacent_node.is_file() {
            return Some(adjacent_node);
        }
    }
    which::which("node").ok()
}

/// 从 npm 生成的 `.cmd` shim 内容中解析真正的 JS 入口绝对路径。
///
/// npm shim 末行形如：
/// ```text
/// ... "%_prog%"  "%dp0%\node_modules\opencode-ai\bin\opencode" %*
/// ```
/// 这里提取 `%dp0%` 之后的相对路径，并用 shim 所在目录替换 `%dp0%`。
#[cfg(any(windows, test))]
fn parse_npm_shim_entry(shim_path: &Path) -> Option<PathBuf> {
    let dir = shim_path.parent()?;
    let contents = std::fs::read_to_string(shim_path).ok()?;

    for line in contents.lines() {
        // 只看真正的执行行（含 `%*` 透传参数），跳过 `IF EXIST "%dp0%\node.exe"`
        // 之类的探测行，避免误把 node.exe 当成入口。
        if !line.contains("%dp0%") || !line.contains("%*") {
            continue;
        }
        // 取该行里以 `%dp0%` 开头、由引号包裹的 token。
        let mut search = line;
        while let Some(start) = search.find("\"%dp0%") {
            let after_quote = &search[start + 1..]; // 跳过起始引号
            if let Some(end) = after_quote.find('"') {
                let token = &after_quote[..end]; // 形如 %dp0%\node_modules\...\opencode
                let rel = token
                    .trim_start_matches("%dp0%")
                    .trim_start_matches(['\\', '/']);
                if !rel.is_empty() {
                    // shim 内是 Windows 反斜杠分隔，按 `\` 和 `/` 拆分后逐段 join，
                    // 让路径在任意平台都能正确拼接（便于跨平台单测）。
                    let mut entry = dir.to_path_buf();
                    for segment in rel.split(['\\', '/']).filter(|s| !s.is_empty()) {
                        entry.push(segment);
                    }
                    if entry.is_file() {
                        return Some(entry);
                    }
                    // npm shim 的入口 token 常省略扩展名（如 `...\bin\opencode`）。
                    // 若同名 `.exe` 存在，说明该 CLI 分发的是原生 PE 二进制
                    // （opencode 等），返回该 `.exe` 供上层直接运行。
                    let exe_entry = entry.with_extension("exe");
                    if exe_entry.is_file() {
                        return Some(exe_entry);
                    }
                }
                search = &after_quote[end + 1..];
            } else {
                break;
            }
        }
    }
    None
}

/// 在 Windows 上把 npm `.cmd`/`.bat` shim 改写为可被 PTY 直接启动的命令。
///
/// - 非 Windows 或非批处理文件：原样透传。
/// - 批处理文件：
///   - 入口是 PE 原生二进制（`.exe`，如 opencode）：直接运行该 `.exe`，不经 node。
///   - 入口是 JS 脚本：解析出 `node <entry>` 直接启动。
///   - 解析失败：回退到 `cmd.exe /c <shim> <args>`（至少能拉起，优于直接失败）。
#[cfg(windows)]
pub fn rewrite_windows_npm_shim(command: String, args: Vec<String>) -> (String, Vec<String>) {
    let path = PathBuf::from(&command);
    if !is_windows_batch_file(&path) {
        return (command, args);
    }

    if let Some(entry) = parse_npm_shim_entry(&path) {
        // 入口是 PE 二进制：PTY 可直接 CreateProcess 拉起，绝不能交给 node。
        if is_pe_binary(&entry) {
            let effective_command = entry.to_string_lossy().into_owned();
            tracing::info!(
                shim = %command,
                final_command = %effective_command,
                launch_kind = "native_exe",
                arg_count = args.len(),
                "windows npm shim: using native executable entry"
            );
            return (effective_command, args);
        }
        // 入口是 JS 脚本：用 node 运行。
        if let Some(node) = node_for_npm_shim(&path) {
            let effective_command = node.to_string_lossy().into_owned();
            let mut effective_args = vec![entry.to_string_lossy().into_owned()];
            effective_args.extend(args);
            tracing::info!(
                shim = %command,
                final_command = %effective_command,
                entry = %entry.display(),
                launch_kind = "node_entry",
                arg_count = effective_args.len(),
                "windows npm shim: using node entry"
            );
            return (effective_command, effective_args);
        }
    }

    tracing::warn!(
        command = %command,
        final_command = "cmd.exe",
        launch_kind = "cmd_fallback",
        arg_count = args.len(),
        "windows npm shim: node/entry 解析失败，回退到 cmd.exe /c"
    );
    let mut effective_args = vec!["/c".to_string(), command];
    effective_args.extend(args);
    ("cmd.exe".to_string(), effective_args)
}

/// 非 Windows 平台：原样透传。
#[cfg(not(windows))]
pub fn rewrite_windows_npm_shim(command: String, args: Vec<String>) -> (String, Vec<String>) {
    (command, args)
}

pub fn normalize_cli_command(command: &str) -> &str {
    let command = command.trim();
    if command.len() >= 2 {
        let bytes = command.as_bytes();
        if (bytes[0] == b'"' && bytes[command.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[command.len() - 1] == b'\'')
        {
            return command[1..command.len() - 1].trim();
        }
    }
    command
}

/// 供 adapter 使用的轻量 Provider 视图，避免依赖主 crate 类型
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CliProvider {
    pub id: String,
    pub name: String,
    pub provider_type: String,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub region: Option<String>,
    pub project_id: Option<String>,
    pub aws_profile: Option<String>,
    pub config_dir: Option<String>,
    #[serde(default)]
    pub is_default: bool,
}

/// 命令构建结果
pub struct CliCommandResult {
    pub command: String,
    pub args: Vec<String>,
    /// 需要清除的环境变量
    pub env_remove: Vec<String>,
    /// 需要注入的环境变量
    pub env_inject: HashMap<String, String>,
}

// ============ 日志脱敏 ============

/// 启动参数日志脱敏：掩码 token 值、截断 prompt 类长参数。
/// 记录 CLI 启动命令时必须经过此函数，避免 initial prompt / system prompt /
/// MCP token 落入应用日志。
pub fn redact_args_for_log(args: &[String]) -> Vec<String> {
    args.iter()
        .map(|arg| redact_cli_text_for_log(arg))
        .collect()
}

/// 单段文本脱敏：token 掩码 + developer_instructions 整体替换 + 超长截断。
pub fn redact_cli_text_for_log(text: &str) -> String {
    let masked = mask_token_values(text);
    if let Some(rest) = masked.strip_prefix("developer_instructions=") {
        return format!(
            "developer_instructions=<redacted {} chars>",
            rest.chars().count()
        );
    }
    let char_count = masked.chars().count();
    if char_count > 120 {
        let prefix: String = masked.chars().take(60).collect();
        return format!("{prefix}…<{char_count} chars>");
    }
    masked
}

/// 掩码文本中所有 `token=<value>`（大小写不敏感）。
/// 裸值掩码到 `&`/引号/空白 为止；引号值（`token='x'` / `token="x"`）掩码引号内内容。
pub fn mask_token_values(text: &str) -> String {
    const NEEDLE: &str = "token=";
    let lower = text.to_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    while let Some(rel) = lower[cursor..].find(NEEDLE) {
        let value_start = cursor + rel + NEEDLE.len();
        out.push_str(&text[cursor..value_start]);
        let tail = &text[value_start..];
        cursor = match tail.chars().next() {
            Some(quote @ ('\'' | '"')) => {
                let inner = &tail[1..];
                let inner_len = inner.find(quote).unwrap_or(inner.len());
                out.push(quote);
                if inner_len > 0 {
                    out.push_str("***");
                }
                // 闭引号（如有）随剩余文本一起拷贝
                value_start + 1 + inner_len
            }
            _ => {
                let value_len = tail
                    .find(|c: char| c == '&' || c == '"' || c == '\'' || c.is_whitespace())
                    .unwrap_or(tail.len());
                if value_len > 0 {
                    out.push_str("***");
                }
                value_start + value_len
            }
        };
    }
    out.push_str(&text[cursor..]);
    out
}

#[cfg(test)]
mod redact_tests {
    use super::*;

    #[test]
    fn masks_token_values_case_insensitive() {
        assert_eq!(
            mask_token_values("http://127.0.0.1:9000/mcp?token=secret123&launchId=abc"),
            "http://127.0.0.1:9000/mcp?token=***&launchId=abc"
        );
        assert_eq!(
            mask_token_values("export CC_PANES_API_TOKEN='secret'"),
            "export CC_PANES_API_TOKEN='***'"
        );
    }

    #[test]
    fn truncates_long_prompt_args() {
        let prompt = "你".repeat(300);
        let redacted = redact_cli_text_for_log(&prompt);
        assert!(redacted.contains("<300 chars>"));
        assert!(redacted.chars().count() < 80);
    }

    #[test]
    fn redacts_developer_instructions_entirely() {
        let arg = "developer_instructions=do something secret";
        assert_eq!(
            redact_cli_text_for_log(arg),
            "developer_instructions=<redacted 19 chars>"
        );
    }

    #[test]
    fn keeps_short_plain_args() {
        assert_eq!(redact_cli_text_for_log("--resume"), "--resume");
        assert_eq!(redact_cli_text_for_log("read-only"), "read-only");
    }
}

// ============ Registry ============

/// CLI 工具注册表
pub struct CliToolRegistry {
    adapters: HashMap<String, Arc<dyn CliToolAdapter>>,
    order: Vec<String>,
}

impl CliToolRegistry {
    pub fn new() -> Self {
        Self {
            adapters: HashMap::new(),
            order: Vec::new(),
        }
    }

    pub fn with_builtin_adapters() -> Self {
        let mut registry = Self::new();
        registry.register(Arc::new(ClaudeAdapter::new()));
        registry.register(Arc::new(CodexAdapter::new()));
        registry.register(Arc::new(GeminiAdapter::new()));
        registry.register(Arc::new(KimiAdapter::new()));
        registry.register(Arc::new(GlmAdapter::new()));
        registry.register(Arc::new(OpenCodeAdapter::new()));
        registry.register(Arc::new(CursorAdapter::new()));
        registry.register(Arc::new(GrokAdapter::new()));
        registry
    }

    /// 注册一个适配器（id 从 adapter.info().id 取得）
    pub fn register(&mut self, adapter: Arc<dyn CliToolAdapter>) {
        let id = adapter.info().id.clone();
        if !self.order.contains(&id) {
            self.order.push(id.clone());
        }
        self.adapters.insert(id, adapter);
    }

    /// 按 id 查找适配器
    pub fn get(&self, id: &str) -> Option<&Arc<dyn CliToolAdapter>> {
        self.adapters.get(id)
    }

    /// 列出所有工具的元信息（保持注册顺序）
    pub fn list_tools(&self) -> Vec<&CliToolInfo> {
        self.order
            .iter()
            .filter_map(|id| self.adapters.get(id).map(|a| a.info()))
            .collect()
    }

    /// 检测所有工具的安装状态（保持注册顺序）
    pub fn detect_all(&self) -> Vec<CliToolInfo> {
        self.order
            .iter()
            .filter_map(|id| self.adapters.get(id).map(|a| a.detect()))
            .collect()
    }

    /// 收集所有工具的全局命令目录（保持注册顺序，过滤 None）
    pub fn global_commands_dirs(&self) -> Vec<(String, PathBuf)> {
        self.order
            .iter()
            .filter_map(|id| {
                self.adapters
                    .get(id)
                    .and_then(|a| a.global_commands_dir().map(|dir| (id.clone(), dir)))
            })
            .collect()
    }

    /// 收集所有工具的全局技能目录（保持注册顺序，过滤 None）
    pub fn global_skills_dirs(&self) -> Vec<(String, PathBuf)> {
        self.order
            .iter()
            .filter_map(|id| {
                self.adapters
                    .get(id)
                    .and_then(|a| a.global_skills_dir().map(|dir| (id.clone(), dir)))
            })
            .collect()
    }

    /// 列出所有工具的能力声明（保持注册顺序，带 id）
    pub fn list_capabilities(&self) -> Vec<(String, CliToolCapabilities)> {
        self.order
            .iter()
            .filter_map(|id| {
                self.adapters
                    .get(id)
                    .map(|a| (id.clone(), a.capabilities().clone()))
            })
            .collect()
    }
}

impl Default for CliToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod registry_tests {
    use super::*;

    fn test_context(executable_override: Option<&str>) -> CliAdapterContext {
        CliAdapterContext {
            session_id: "test-session".to_string(),
            project_path: "/tmp/project".to_string(),
            workspace_path: None,
            provider: None,
            executable_override: executable_override.map(str::to_string),
            adapter_options: Default::default(),
            resume_id: None,
            issued_session_id: None,
            skip_mcp: true,
            yolo_mode: false,
            append_system_prompt: None,
            initial_prompt: None,
            orchestrator_port: None,
            orchestrator_token: None,
            launch_id: None,
            data_dir: std::env::temp_dir(),
            shared_mcp_urls: HashMap::new(),
            allowed_mcp_server_ids: Vec::new(),
            disable_unlisted_mcp_servers: false,
        }
    }

    #[test]
    fn builtin_registry_matches_desktop_adapter_set() {
        let registry = CliToolRegistry::with_builtin_adapters();
        let ids = registry
            .list_tools()
            .into_iter()
            .map(|tool| tool.id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            ids,
            vec!["claude", "codex", "gemini", "kimi", "glm", "opencode", "cursor", "grok"]
        );
        assert!(registry.get("claude").is_some());
        assert!(registry.get("codex").is_some());
    }

    #[test]
    fn context_resolve_command_prefers_trimmed_override() {
        let ctx = test_context(Some("  C:\\Tools\\reclaude.exe  "));

        assert_eq!(
            ctx.resolve_command("definitely-not-installed").unwrap(),
            "C:\\Tools\\reclaude.exe"
        );
    }

    #[test]
    fn context_resolve_command_strips_wrapping_quotes_from_override() {
        let ctx = test_context(Some(r#"  "C:\Program Files\reclaude\reclaude.exe"  "#));

        assert_eq!(
            ctx.resolve_command("definitely-not-installed").unwrap(),
            r"C:\Program Files\reclaude\reclaude.exe"
        );
    }

    #[test]
    fn context_resolve_command_ignores_blank_override() {
        let ctx = test_context(Some("  "));

        let err = ctx.resolve_command("definitely-not-installed").unwrap_err();
        assert!(err
            .to_string()
            .contains("definitely-not-installed CLI not found"));
    }

    /// 标准 npm `.cmd` shim 末行的真实模板（opencode-ai 包）。
    const NPM_SHIM_CMD: &str = "@ECHO off\r\n\
GOTO start\r\n\
:find_dp0\r\n\
SET dp0=%~dp0\r\n\
EXIT /b\r\n\
:start\r\n\
SETLOCAL\r\n\
CALL :find_dp0\r\n\
\r\n\
IF EXIST \"%dp0%\\node.exe\" (\r\n\
  SET \"_prog=%dp0%\\node.exe\"\r\n\
) ELSE (\r\n\
  SET \"_prog=node\"\r\n\
  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n\
)\r\n\
\r\n\
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\opencode-ai\\bin\\opencode\" %*\r\n";

    fn fresh_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ccpanes_shim_{}_{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn find_executable_prefers_cmd_shim_over_bare_sh_script_on_windows() {
        let dir = fresh_dir("bare_sh");
        // npm 全局安装同时生成扩展名缺失的 sh 脚本与 .cmd shim
        std::fs::write(dir.join("opencode"), b"#!/bin/sh\n").unwrap();
        std::fs::write(dir.join("opencode.cmd"), b"@ECHO off\r\n").unwrap();

        // Windows 语义（extensions 非空）：必须选 .cmd，不能命中裸 sh 脚本
        let found = find_executable_in_dirs(
            "opencode",
            std::slice::from_ref(&dir),
            &[".exe".to_string(), ".cmd".to_string()],
        )
        .expect("should find executable");
        assert_eq!(found, dir.join("opencode.cmd"));

        // 非 Windows 语义（extensions 为空）：裸文件即真实二进制，保持原行为
        let found_unix = find_executable_in_dirs("opencode", std::slice::from_ref(&dir), &[])
            .expect("should find executable");
        assert_eq!(found_unix, dir.join("opencode"));
    }

    #[test]
    fn parse_npm_shim_entry_extracts_js_entry() {
        let dir = fresh_dir("parse");
        let shim = dir.join("opencode.cmd");
        std::fs::write(&shim, NPM_SHIM_CMD).unwrap();

        // 入口文件必须真实存在（parser 会 is_file() 校验）。
        let entry = dir
            .join("node_modules")
            .join("opencode-ai")
            .join("bin")
            .join("opencode");
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::write(&entry, b"#!/usr/bin/env node\n").unwrap();

        let parsed = parse_npm_shim_entry(&shim).expect("should parse npm shim entry");
        assert_eq!(parsed, entry);
    }

    #[test]
    fn parse_npm_shim_entry_returns_none_when_entry_missing() {
        let dir = fresh_dir("parse_missing");
        let shim = dir.join("opencode.cmd");
        std::fs::write(&shim, NPM_SHIM_CMD).unwrap();
        // 不创建 node_modules 入口 → 解析应失败。
        assert!(parse_npm_shim_entry(&shim).is_none());
    }

    #[test]
    fn rewrite_passes_through_non_batch_command() {
        let args = vec!["--help".to_string()];
        let (command, out_args) =
            rewrite_windows_npm_shim("C:\\bin\\codex.exe".to_string(), args.clone());
        assert_eq!(command, "C:\\bin\\codex.exe");
        assert_eq!(out_args, args);
    }

    #[cfg(windows)]
    #[test]
    fn rewrite_batch_shim_runs_node_with_entry() {
        let dir = fresh_dir("rewrite");
        let shim = dir.join("opencode.cmd");
        std::fs::write(&shim, NPM_SHIM_CMD).unwrap();

        // 相邻 node.exe（node_for_npm_shim 优先选用）。
        let node = dir.join("node.exe");
        std::fs::write(&node, b"").unwrap();

        let entry = dir
            .join("node_modules")
            .join("opencode-ai")
            .join("bin")
            .join("opencode");
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::write(&entry, b"").unwrap();

        let (command, out_args) = rewrite_windows_npm_shim(
            shim.to_string_lossy().into_owned(),
            vec!["hello prompt".to_string()],
        );

        assert_eq!(command, node.to_string_lossy());
        assert_eq!(
            out_args,
            vec![
                entry.to_string_lossy().into_owned(),
                "hello prompt".to_string()
            ]
        );
    }

    #[test]
    fn parse_npm_shim_entry_falls_back_to_sibling_exe() {
        let dir = fresh_dir("parse_exe");
        let shim = dir.join("opencode.cmd");
        std::fs::write(&shim, NPM_SHIM_CMD).unwrap();

        // 只创建 PE 二进制入口（无扩展名的入口文件不存在），parser 应回退到 .exe。
        let exe_entry = dir
            .join("node_modules")
            .join("opencode-ai")
            .join("bin")
            .join("opencode.exe");
        std::fs::create_dir_all(exe_entry.parent().unwrap()).unwrap();
        std::fs::write(&exe_entry, b"MZ").unwrap();

        let parsed = parse_npm_shim_entry(&shim).expect("should resolve .exe entry");
        assert_eq!(parsed, exe_entry);
    }

    #[cfg(windows)]
    #[test]
    fn rewrite_batch_shim_runs_exe_entry_directly() {
        let dir = fresh_dir("rewrite_exe");
        let shim = dir.join("opencode.cmd");
        std::fs::write(&shim, NPM_SHIM_CMD).unwrap();

        // 相邻 node.exe 存在也不应被选用——入口是 PE 二进制时必须直接运行。
        let node = dir.join("node.exe");
        std::fs::write(&node, b"").unwrap();

        let exe_entry = dir
            .join("node_modules")
            .join("opencode-ai")
            .join("bin")
            .join("opencode.exe");
        std::fs::create_dir_all(exe_entry.parent().unwrap()).unwrap();
        std::fs::write(&exe_entry, b"MZ").unwrap();

        let (command, out_args) = rewrite_windows_npm_shim(
            shim.to_string_lossy().into_owned(),
            vec!["hello prompt".to_string()],
        );

        // 直接运行 .exe，不经 node，参数原样透传。
        assert_eq!(command, exe_entry.to_string_lossy());
        assert_eq!(out_args, vec!["hello prompt".to_string()]);
    }
}

// ============ cc-pane 抽象事件层 ============
//
// cc-pane 自己定义一套生命周期事件，CLI 通过 `CliToolAdapter::map_cc_pane_event`
// 把它翻译为各自的原生 hook 绑定（Claude / Codex / 未来 CLI）。
//
// 设计原则：
//   - 业务侧（cc-panes-cli-hook 子命令、状态机）只面向 CcPaneEvent，不关心底层 CLI
//   - 不支持的事件由 adapter 返回 None + unsupported_reason，同步层跳过
//   - 类型刻意放在 cc-cli-adapters crate（而非 cc-panes-core），以避免循环依赖

/// cc-pane 抽象事件（10 个），按会话生命周期排列。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CcPaneEvent {
    /// 首次启动会话
    SessionInit,
    /// 恢复已有会话（含 resume / clear / compact）
    SessionResume,
    /// 会话终止
    SessionEnd,
    /// 用户提交 prompt 后、Claude 处理前
    PromptBefore,
    /// 工具调用前（带 matcher 决定关注哪些工具）
    ToolBefore(ToolMatcher),
    /// 工具调用后（带 matcher）
    ToolAfter(ToolMatcher),
    /// 一轮响应结束（Claude 真正空闲）
    TurnEnd,
    /// 上下文压缩前
    BeforeCompact,
    /// 等待用户输入（权限提示 / MCP elicitation）
    WaitingInput,
    /// 出错（API 失败、限流等）
    Error,
}

/// cc-pane DSL 工具匹配器。
///
/// 比 CLI 原生 matcher 更高层，adapter 负责翻译为各 CLI 的原生 matcher 字符串。
/// 典型用法：
///   - `ToolMatcher::any()` — 匹配所有工具
///   - `ToolMatcher { tool: ToolKind::Write, path_glob: Some(".claude/**".into()), .. }`
///   - `ToolMatcher { tool: ToolKind::Bash, bash_cmd_prefix: Some("rm -rf".into()), .. }`
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToolMatcher {
    /// 关注的工具种类
    pub tool: ToolKind,
    /// 可选：文件路径 glob（仅对 Write/Edit/Read 类工具有意义）
    pub path_glob: Option<String>,
    /// 可选：bash 命令前缀（仅对 Bash 工具有意义）
    pub bash_cmd_prefix: Option<String>,
}

impl ToolMatcher {
    /// 匹配所有工具的快捷构造
    pub fn any() -> Self {
        Self {
            tool: ToolKind::Any,
            path_glob: None,
            bash_cmd_prefix: None,
        }
    }
}

/// 工具种类。`Any` 表示通配。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ToolKind {
    #[default]
    Any,
    Bash,
    Write,
    Edit,
    Read,
    /// 留给未来扩展（cc-pane 自定义工具或 MCP 工具）
    Custom,
}

/// CLI 原生 hook 绑定，由 `CliToolAdapter::map_cc_pane_event` 返回。
///
/// 同步层据此把 cc-pane 启用的事件写入 CLI 的配置文件（如 `.claude/settings.local.json`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeHookBinding {
    /// CLI 原生事件名，如 Claude 的 `"SessionStart"` / `"PreToolUse"`
    pub event: String,
    /// CLI 原生 matcher（由 adapter 翻译生成），None 表示不需要 matcher
    pub matcher: Option<String>,
    /// hook 超时（秒）
    pub timeout_secs: u32,
    /// 是否 async 执行
    pub async_mode: bool,
    /// 留给各 CLI 特有字段的扩展点（例如 Codex 的 `statusMessage`）
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub extra: serde_json::Value,
}

impl NativeHookBinding {
    /// 构造一个最常见的同步 hook 绑定
    pub fn new(event: impl Into<String>, matcher: Option<&str>, timeout_secs: u32) -> Self {
        Self {
            event: event.into(),
            matcher: matcher.map(|s| s.to_string()),
            timeout_secs,
            async_mode: false,
            extra: serde_json::Value::Null,
        }
    }
}
