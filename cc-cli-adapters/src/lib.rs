//! CLI Tool Adapter Layer for CC-Panes
//!
//! 提供 Trait + Registry 架构，让新增 CLI 工具只需实现 `CliToolAdapter` trait 并注册即可。
//!
//! ```text
//! 新增一个 CLI 工具 = 新建一个文件实现 trait + 注册一行代码
//! ```

mod atomic_file;
mod claude;
mod codex;
pub mod context_size;
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookCommandShell {
    Posix,
    Windows,
}

/// 生成带存在性守卫的 hook 命令行。
///
/// 对外开放是因为 dsh 也要这个形态：它的 `dsh-hooks-claude-code` 桥读的是
/// Claude Code 形状的 `hooks.json`，命令串必须与我们写给 Claude 的一致
/// （守卫写法、Windows 上不能再套一层 `cmd.exe` 这两条尤其不能各写一份）。
pub fn build_guarded_hook_command(
    binary_path: &Path,
    subcommand: &str,
    shell: HookCommandShell,
) -> String {
    let path = binary_path.to_string_lossy();
    match shell {
        HookCommandShell::Posix => {
            let quoted = format!("'{}'", path.replace('\'', "'\\''"));
            format!("if [ -x {quoted} ]; then {quoted} {subcommand}; fi")
        }
        HookCommandShell::Windows => {
            // The CLI already runs hook commands through the Windows host shell.
            // Starting another cmd.exe here makes the hook consume Claude's JSON
            // stdin as shell input instead of forwarding it to the executable.
            format!(r#"if exist "{path}" "{path}" {subcommand}"#)
        }
    }
}

pub(crate) fn is_guarded_hook_command(command: &str) -> bool {
    let command = command.trim_start();
    command.starts_with("if [ -x ") || command.starts_with("if exist ")
}

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
    run_with_timeout_env(cmd, args, timeout, &[])
}

/// 同 `run_with_timeout`，附加环境变量注入（守卫/去干扰类 env）。
pub fn run_with_timeout_env(
    cmd: &std::path::Path,
    args: &[String],
    timeout: Duration,
    envs: &[(&str, &str)],
) -> Option<String> {
    let mut cmd = no_window_command(&cmd.to_string_lossy());
    cmd.args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null());
    for (key, value) in envs {
        cmd.env(key, value);
    }

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
    // `which` 在 Windows 上会把**无扩展名的裸文件**当成命中直接返回。
    // npm 全局安装会在 `xxx.cmd` 旁放一个同名的 sh 脚本（claude / opencode 都是），
    // 而 `CreateProcessW` 对 sh 脚本报 `os error 193: 不是有效的 Win32 应用程序`。
    //
    // 下面的 `find_executable_in_dirs` 早就按 PATHEXT 处理了这一情形（opencode 那次修的），
    // 但那段逻辑此前被这里的短路挡住，永远执行不到 —— claude 又踩了同一个坑。
    // 现在只接受**扩展名可执行**的 which 结果，否则落到扩展名感知的查找。
    if let Ok(path) = which::which(executable) {
        if is_directly_executable(&path) {
            return Ok(path);
        }
    }

    if let Some(found) = find_executable_in_dirs(
        executable,
        &candidate_executable_dirs(),
        &executable_extensions(),
    ) {
        return Ok(found);
    }

    // 最后兜底：同步抓一次 login-shell PATH（进程级缓存，最多阻塞一次）。
    // 覆盖首启无 cached_path 的窗口期与非白名单包管理器（macOS GUI 环境）。
    #[cfg(not(windows))]
    {
        let extra_dirs = login_shell_path_dirs();
        if !extra_dirs.is_empty() {
            if let Some(found) =
                find_executable_in_dirs(executable, extra_dirs, &executable_extensions())
            {
                return Ok(found);
            }
        }
    }

    Err(anyhow!(
        "{} CLI not found in PATH or common install locations",
        executable
    ))
}

/// login-shell PATH 的进程级缓存（失败也缓存空，整个进程最多阻塞一次）。
///
/// 只在 `resolve_executable` 白名单全部落空时才触发——即"本来就要报
/// not found"的路径上，最坏多等一次 shell 启动（8s 超时兜底）。
#[cfg(not(windows))]
fn login_shell_path_dirs() -> &'static [PathBuf] {
    use std::sync::OnceLock;
    static CACHE: OnceLock<Vec<PathBuf>> = OnceLock::new();
    CACHE.get_or_init(|| {
        // 递归守卫：shell rc 里若有触发环境解析的钩子，此变量已置位
        if std::env::var_os("CCPANES_RESOLVING_ENVIRONMENT").is_some() {
            return Vec::new();
        }
        let shell = resolve_login_shell();
        let output = run_with_timeout_env(
            Path::new(&shell),
            &["-ilc".to_string(), "echo $PATH".to_string()],
            Duration::from_secs(8),
            // 对齐 src-tauri 的 resolve_path_from_shell：防 rc 递归 + 防 tmux 劫持
            &[
                ("CCPANES_RESOLVING_ENVIRONMENT", "1"),
                ("ZSH_TMUX_AUTOSTART", "false"),
            ],
        );
        output.as_deref().map(split_path_dirs).unwrap_or_default()
    })
}

/// 从 shell 输出中提取 PATH 目录列表。
///
/// login shell 可能往 stdout 打招呼语/会话恢复提示（实战教训见 src-tauri
/// 的 `sanitize_path_output`），取**最后一个**含路径分隔的非空行再拆分。
#[cfg_attr(windows, allow(dead_code))] // 生产调用方在 cfg(not(windows)) 的兜底链路里
fn split_path_dirs(raw: &str) -> Vec<PathBuf> {
    let line = raw
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty() && line.contains('/'))
        .unwrap_or("");
    let mut dirs: Vec<PathBuf> = Vec::new();
    for entry in line.split(':') {
        if entry.is_empty() {
            continue;
        }
        let dir = PathBuf::from(entry);
        if !dirs.iter().any(|existing| existing == &dir) {
            dirs.push(dir);
        }
    }
    dirs
}

/// 该路径能否被 `CreateProcessW` / `exec` 直接执行。
///
/// Windows：必须带 PATHEXT 里的扩展名。裸文件多半是 npm 装出来的 sh shim，
/// 直接 spawn 会得到 `os error 193`，且报错里既不提 shim 也不提扩展名，
/// 看着完全像是我们把路径拼错了。
/// 非 Windows：可执行位由调用方/OS 判断，这里恒为真。
fn is_directly_executable(path: &Path) -> bool {
    #[cfg(windows)]
    {
        let extensions = executable_extensions();
        if extensions.is_empty() {
            return true;
        }
        match path.extension().and_then(|value| value.to_str()) {
            Some(ext) => {
                let dotted = format!(".{}", ext.to_ascii_lowercase());
                extensions.contains(&dotted)
            }
            None => false,
        }
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        true
    }
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
            extend_unique_dirs(
                &mut dirs,
                nvm_node_bin_dirs(&nvm_dir.join("versions").join("node")),
            );

            extend_unique_dirs(&mut dirs, extra_unix_tool_dirs(&home));
        }

        #[cfg(windows)]
        {
            extend_unique_dirs(
                &mut dirs,
                windows_user_cli_dirs(&home, std::env::var_os("GROK_HOME").as_deref()),
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

#[cfg(windows)]
fn windows_user_cli_dirs(home: &Path, grok_home: Option<&std::ffi::OsStr>) -> Vec<PathBuf> {
    let mut dirs = vec![
        // npm and Scoop are the two common user-level Windows CLI locations.
        home.join("AppData").join("Roaming").join("npm"),
        home.join("scoop").join("shims"),
        // Grok's official installer uses ~/.grok/bin and may not update the
        // environment inherited by an already-running desktop app.
        home.join(".grok").join("bin"),
    ];
    if let Some(grok_home) = grok_home {
        let path = PathBuf::from(grok_home);
        dirs.push(path.join("bin"));
    }
    dirs
}

/// 版本目录名比较（`v20.11.1` 风格），数字段按数值比。
///
/// 不能用字符串/PathBuf 字典序：`v9.x > v20.x`（'9' > '2'）会把"最新版"
/// 挑成 v9，claude 装在 v20 时就找不到。非数字段退回字符串比较，缺段按 0。
pub fn compare_version_dir_names(a: &str, b: &str) -> std::cmp::Ordering {
    let normalize = |name: &str| -> Vec<String> {
        name.trim_start_matches(['v', 'V'])
            .split('.')
            .map(str::to_string)
            .collect()
    };
    let left = normalize(a);
    let right = normalize(b);
    let len = left.len().max(right.len());
    for index in 0..len {
        let l = left.get(index).map(String::as_str).unwrap_or("0");
        let r = right.get(index).map(String::as_str).unwrap_or("0");
        let ordering = match (l.parse::<u64>(), r.parse::<u64>()) {
            (Ok(ln), Ok(rn)) => ln.cmp(&rn),
            _ => l.cmp(r),
        };
        if ordering != std::cmp::Ordering::Equal {
            return ordering;
        }
    }
    std::cmp::Ordering::Equal
}

/// nvm 版本目录下所有 `<version>/bin`，按版本**降序**（最新在前）。
///
/// 参数化 versions 目录路径以便 tempdir 测试；只返回真实存在的 bin 目录。
pub fn nvm_node_bin_dirs(nvm_versions_dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(nvm_versions_dir) else {
        return Vec::new();
    };
    let mut versions = entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    versions.sort_by(|a, b| {
        let name_of = |p: &Path| p.file_name().map(|n| n.to_string_lossy().into_owned());
        match (name_of(a), name_of(b)) {
            (Some(an), Some(bn)) => compare_version_dir_names(&bn, &an),
            _ => b.cmp(a),
        }
    });
    versions
        .into_iter()
        .map(|version| version.join("bin"))
        .filter(|bin| bin.is_dir())
        .collect()
}

/// Unix 侧常见包管理器的安装目录（bun / pnpm / volta / asdf / fnm）。
///
/// 这些目录都靠 shell 配置才进 PATH，macOS GUI 环境拿不到；不做存在性
/// 过滤（调用方各有过滤器：`dedupe_existing_dirs` / `append_sanitized_path_entry`）。
pub fn extra_unix_tool_dirs(home: &Path) -> Vec<PathBuf> {
    extra_unix_tool_dirs_with(
        home,
        std::env::var_os("PNPM_HOME").map(PathBuf::from),
        std::env::var_os("FNM_DIR").map(PathBuf::from),
    )
}

fn extra_unix_tool_dirs_with(
    home: &Path,
    pnpm_home: Option<PathBuf>,
    fnm_dir: Option<PathBuf>,
) -> Vec<PathBuf> {
    let mut dirs = vec![
        home.join(".bun").join("bin"),
        home.join("Library").join("pnpm"),
        home.join(".volta").join("bin"),
        home.join(".asdf").join("shims"),
    ];
    if let Some(pnpm) = pnpm_home {
        dirs.push(pnpm);
    }
    let fnm = fnm_dir.unwrap_or_else(|| home.join(".local").join("share").join("fnm"));
    // fnm 的 node 实体在 node-versions/*/installation/bin，aliases/default 是稳定入口
    dirs.push(fnm.join("aliases").join("default").join("bin"));
    dirs.push(fnm);
    dirs
}

/// login shell 解析：`$SHELL` 非空用之，缺失时按平台回落。
///
/// macOS 10.15+ 默认 shell 是 zsh——回落 `/bin/sh` 的话 `-ilc` 不读
/// `~/.zprofile`/`~/.zshrc`，PATH 抓取等于白跑。
pub fn resolve_login_shell() -> String {
    login_shell_from(std::env::var("SHELL").ok().as_deref())
}

fn login_shell_from(env_shell: Option<&str>) -> String {
    if let Some(shell) = env_shell {
        if !shell.trim().is_empty() {
            return shell.to_string();
        }
    }
    #[cfg(target_os = "macos")]
    {
        if Path::new("/bin/zsh").exists() {
            return "/bin/zsh".to_string();
        }
    }
    "/bin/sh".to_string()
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

    /// Structured permission-decision transport supported by this CLI.
    ///
    /// `None` is intentionally fail-closed: callers must never infer support
    /// from a generic notification or pre-tool hook.
    fn permission_request_capability(&self) -> Option<PermissionRequestCapability> {
        None
    }

    /// Validate and normalize a native permission request before it reaches
    /// privileged queue logic. Unsupported adapters reject every payload.
    fn validate_permission_request(
        &self,
        _payload: &serde_json::Value,
    ) -> std::result::Result<StructuredPermissionRequest, PermissionRequestValidationError> {
        Err(PermissionRequestValidationError::UnsupportedCli)
    }

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

    /// 是否存在仍以裸二进制路径运行的 CC-Panes hook，需要升级为存在性守卫命令。
    fn project_hooks_need_command_upgrade(&self, _project_path: &Path) -> Result<bool> {
        Ok(false)
    }

    /// 删除此 adapter 写入的用户级配置，返回实际变更的路径。
    fn cleanup_user_injections(&self) -> Result<Vec<PathBuf>> {
        Ok(Vec::new())
    }

    /// 删除此 adapter 写入的项目 hook，必须保留用户自定义条目。
    fn cleanup_project_hooks(&self, _project_path: &Path) -> Result<Vec<PathBuf>> {
        Ok(Vec::new())
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
    /// 允许被 MCP `launch_task` 编排启动。
    ///
    /// **默认 false 是有意的**：编排启动链路（prompt 注入、leader/worker 反馈、
    /// resume 绑定）需要逐个 CLI 实机验证过才放行。此前这份白名单硬编码在
    /// `orchestrator_service::parse_launch_cli_tool` 里，新增 CLI 必须记得回去改；
    /// 现在改为由 adapter 自己声明——验证过再置 true。
    #[serde(default)]
    pub supports_orchestrated_launch: bool,
    /// 消费 `adapterOptions.effort`（映射到该 CLI 的思考预算/推理档位）
    ///
    /// 以下三个 per-launch 能力位存在的理由：启动器的 chips 是**通用 UI**，对所有 CLI
    /// 一律可点。但每个 adapter 的 `build_command` 只消费自己支持的键——不支持的键被
    /// **静默丢弃**，用户选了 effort=high 却毫无效果且无任何提示。声明出来让前端置灰，
    /// 是把「这个 CLI 做不到」从隐性变成显性。
    ///
    /// **默认 false 是有意的**（同 `supports_orchestrated_launch` 的理由）：新接入的
    /// adapter 若不显式声明，UI 宁可置灰也不要撒谎说能用。
    #[serde(default)]
    pub supports_effort_option: bool,
    /// 消费 `adapterOptions.verbose`（映射到该 CLI 的详细输出 flag）
    #[serde(default)]
    pub supports_verbose_option: bool,
    /// 消费 `adapterOptions.maxTurns`（映射到该 CLI 的最大轮数 flag）
    #[serde(default)]
    pub supports_max_turns_option: bool,
    /// 兼容的 Provider 类型列表
    #[serde(default)]
    pub compatible_provider_types: Vec<String>,
}

/// Native synchronous permission-decision capability.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionRequestCapability {
    /// Claude Code's synchronous `PermissionRequest` hook.
    ClaudeSynchronousHook,
}

/// Security-relevant subset of a validated native permission request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StructuredPermissionRequest {
    pub tool_use_id: String,
    pub tool_name: String,
    pub tool_input: serde_json::Value,
}

/// Fail-closed reasons returned at the adapter boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionRequestValidationError {
    UnsupportedCli,
    UnsupportedEvent,
    MissingToolUseId,
    MissingToolName,
    InvalidToolInput,
}

impl std::fmt::Display for PermissionRequestValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::UnsupportedCli => "CLI does not support structured permission requests",
            Self::UnsupportedEvent => "hook event is not PermissionRequest",
            Self::MissingToolUseId => "tool_use_id is missing or invalid",
            Self::MissingToolName => "tool_name is missing or invalid",
            Self::InvalidToolInput => "tool_input must be a JSON object",
        })
    }
}

impl std::error::Error for PermissionRequestValidationError {}

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
#[derive(Clone)]
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
    /// 本次会话要挂载的 CC-Panes 内置 skill 根目录（通常是
    /// `<data_dir>/skills/builtin`）。**按会话挂载，绝不写用户的 CLI Home**：
    /// - Claude：每个路径转成一个 `--plugin-dir`
    /// - Codex：合并进 `-c skills.config=[...]` 启动期覆盖
    ///
    /// 为空表示本次不挂载任何内置 skill（`LaunchProfileSkillMode::Disabled`），
    /// 此时各 adapter 必须**完全不碰**用户的 skill 配置。
    pub skill_mount_paths: Vec<String>,
}

/// Internal adapter option carrying the resolved managed Provider environment.
/// The value may contain credentials and must never be logged or forwarded to CLI arguments.
pub const MANAGED_PROVIDER_ENV_OPTION: &str = "__ccpanesProviderEnv";

impl CliAdapterContext {
    pub fn model_id(&self) -> Option<&str> {
        self.adapter_options
            .get("__ccpanesModelId")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    }

    /// Provider 模型配置的 `contextSize` 字符串（`"1m"` / `"200k"` / `"500k"` 等）。
    /// 配合 `__ccpanesModelId` 一起用于 claude.rs managed_settings 拼 `[<size>]` 后缀。
    /// 空 / `"200k"`（默认）/ `"custom"` 都不拼后缀——与 ccpanel `apply_context_size_suffix` 对齐。
    pub fn context_size(&self) -> Option<String> {
        self.adapter_options
            .get("__ccpanesContextSize")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }

    pub fn command_override(&self) -> Option<&str> {
        self.executable_override
            .as_deref()
            .map(normalize_cli_command)
            .filter(|value| !value.is_empty())
    }

    /// 覆盖值是**裸命令名**（不含路径分隔符）时，仍需按 PATHEXT 解析成真实可执行路径。
    ///
    /// `[cliLaunchers.overrides.claude] command = "claude"` 这种写法是合法配置，
    /// 但直接拿去 spawn 会命中 npm 的无扩展名 sh shim，报
    /// `os error 193: 不是有效的 Win32 应用程序`（实测 dev 侧就是这样坏的）。
    /// 覆盖值若已是路径（绝对或含分隔符），说明用户指名道姓，原样透传不改写。
    pub fn resolved_override_public(&self) -> Option<String> {
        self.resolved_override()
    }

    fn resolved_override(&self) -> Option<String> {
        let raw = self.command_override()?;
        let looks_like_path =
            raw.contains('/') || raw.contains('\\') || Path::new(raw).is_absolute();
        if looks_like_path {
            return Some(raw.to_string());
        }
        match resolve_executable(raw) {
            Ok(path) => Some(path.to_string_lossy().into_owned()),
            // 解析不出来就退回原值，让 spawn 去报错——不要在这里吞掉用户配置
            Err(_) => Some(raw.to_string()),
        }
    }

    pub fn resolve_command(&self, executable: &str) -> Result<String> {
        if let Some(command) = self.resolved_override() {
            return Ok(command);
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
    /// 用户显式 override 也必须经过 Windows npm shim 改写；绝对路径和裸命令都可能指向
    /// `.cmd`/`.bat`，而 ConPTY 的 CreateProcess 不能直接启动批处理文件。
    pub fn resolve_launch(
        &self,
        executable: &str,
        args: Vec<String>,
    ) -> Result<(String, Vec<String>)> {
        let command = if let Some(command) = self.resolved_override() {
            command
        } else {
            resolve_executable(executable)?
                .to_string_lossy()
                .into_owned()
        };
        Ok(rewrite_windows_npm_shim(command, args))
    }
}

pub(crate) fn push_model_arg(args: &mut Vec<String>, ctx: &CliAdapterContext) {
    if let Some(model_id) = ctx.model_id() {
        args.push("--model".to_string());
        args.push(model_id.to_string());
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpProxyInvocation {
    pub command: String,
    pub args: Vec<String>,
}

/// 从 adapter options 构造 mcp-proxy 调用。只有显式启用且 sidecar 路径为
/// 绝对路径时生效；本地 adapter 与 WSL 启动链共用这份参数契约。
pub fn mcp_proxy_invocation_from_options(
    adapter_options: &HashMap<String, serde_json::Value>,
    data_dir: &Path,
    launch_id: Option<&str>,
) -> Option<McpProxyInvocation> {
    let enabled = adapter_options
        .get("mcpProxyEnabled")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if !enabled {
        return None;
    }
    let command = adapter_options
        .get("mcpProxyCommand")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    if !Path::new(command).is_absolute() {
        return None;
    }
    let mut args = vec![
        "--data-dir".to_string(),
        data_dir.to_string_lossy().into_owned(),
        "mcp-proxy".to_string(),
    ];
    if let Some(launch_id) = launch_id {
        args.push("--launch-id".to_string());
        args.push(launch_id.to_string());
    }
    Some(McpProxyInvocation {
        command: command.to_string(),
        args,
    })
}

fn mcp_proxy_invocation(ctx: &CliAdapterContext) -> Option<McpProxyInvocation> {
    mcp_proxy_invocation_from_options(
        &ctx.adapter_options,
        &ctx.data_dir,
        ctx.launch_id.as_deref(),
    )
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
    let mut masked = text.to_string();
    for needle in [
        "token=",
        "api_key=",
        "apikey=",
        "authorization=",
        "auth=",
        "header=",
    ] {
        masked = mask_assignment_values(&masked, needle);
    }
    mask_bearer_values(&masked)
}

fn mask_assignment_values(text: &str, needle: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    while let Some(rel) = lower[cursor..].find(needle) {
        let value_start = cursor + rel + needle.len();
        out.push_str(&text[cursor..value_start]);
        let tail = &text[value_start..];
        if matches!(needle, "authorization=" | "auth=")
            && tail.to_ascii_lowercase().starts_with("bearer ")
        {
            let value_len = tail
                .find(|character: char| {
                    character == '&'
                        || character == ','
                        || character == '"'
                        || character == '\''
                        || character == '\r'
                        || character == '\n'
                })
                .unwrap_or(tail.len());
            out.push_str("***");
            cursor = value_start + value_len;
            continue;
        }
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

fn mask_bearer_values(text: &str) -> String {
    const NEEDLE: &str = "bearer ";
    let lower = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    while let Some(relative) = lower[cursor..].find(NEEDLE) {
        let value_start = cursor + relative + NEEDLE.len();
        out.push_str(&text[cursor..value_start]);
        let value_len = text[value_start..]
            .find(|character: char| {
                character == '&'
                    || character == ','
                    || character == '"'
                    || character == '\''
                    || character.is_whitespace()
            })
            .unwrap_or(text.len() - value_start);
        if value_len > 0 {
            out.push_str("***");
        }
        cursor = value_start + value_len;
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
        assert_eq!(
            mask_token_values("api_key=secret Authorization=Bearer another-secret"),
            "api_key=*** Authorization=***"
        );
        assert_eq!(
            mask_token_values("HEADER='X-Api-Key: secret'&auth=credential"),
            "HEADER='***'&auth=***"
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

#[cfg(test)]
mod path_resolution_tests {
    use super::*;
    use std::cmp::Ordering;

    #[test]
    fn version_compare_is_numeric_not_lexicographic() {
        assert_eq!(
            compare_version_dir_names("v9.0.0", "v20.11.1"),
            Ordering::Less
        );
        assert_eq!(
            compare_version_dir_names("v20.9.0", "v20.11.1"),
            Ordering::Less
        );
        assert_eq!(
            compare_version_dir_names("v20.11.1", "v20.11.1"),
            Ordering::Equal
        );
        assert_eq!(
            compare_version_dir_names("18.0.0", "v9.9.9"),
            Ordering::Greater
        );
        // 缺段按 0
        assert_eq!(compare_version_dir_names("v20", "v20.0.0"), Ordering::Equal);
    }

    #[test]
    fn version_compare_tolerates_non_numeric_names() {
        // 畸形目录名不 panic，且有稳定序（非数字段退回字符串比较）
        assert_eq!(
            compare_version_dir_names("system", "system"),
            Ordering::Equal
        );
        let _ = compare_version_dir_names("system", "v20.11.1");
        let _ = compare_version_dir_names("v20.beta.1", "v20.0.1");
    }

    #[test]
    fn nvm_bin_dirs_sorted_semver_descending_and_filtered() {
        let versions = tempfile::tempdir().expect("versions dir");
        for name in ["v9.0.0", "v20.11.1", "v20.9.0"] {
            std::fs::create_dir_all(versions.path().join(name).join("bin")).expect("bin dir");
        }
        // 无 bin 子目录的版本要被过滤
        std::fs::create_dir_all(versions.path().join("v1.0.0")).expect("binless version");

        let bins = nvm_node_bin_dirs(versions.path());

        let names: Vec<_> = bins
            .iter()
            .map(|bin| {
                bin.parent()
                    .and_then(|p| p.file_name())
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert_eq!(names, ["v20.11.1", "v20.9.0", "v9.0.0"]);
    }

    #[test]
    fn nvm_bin_dirs_missing_root_returns_empty() {
        assert!(nvm_node_bin_dirs(Path::new("/definitely/not/here")).is_empty());
    }

    #[test]
    fn extra_unix_tool_dirs_cover_common_package_managers() {
        let home = Path::new("/home/tester");
        let dirs = extra_unix_tool_dirs_with(home, None, None);
        for expected in [
            "/home/tester/.bun/bin",
            "/home/tester/Library/pnpm",
            "/home/tester/.volta/bin",
            "/home/tester/.asdf/shims",
        ] {
            assert!(
                dirs.iter().any(|d| d == Path::new(expected)),
                "missing {expected} in {dirs:?}"
            );
        }
        // fnm 默认位置 + aliases/default/bin 稳定入口
        assert!(dirs
            .iter()
            .any(|d| d.ends_with(Path::new("fnm/aliases/default/bin"))
                || d.ends_with(Path::new("fnm\\aliases\\default\\bin"))));
    }

    #[test]
    fn extra_unix_tool_dirs_honor_env_overrides() {
        let home = Path::new("/home/tester");
        let dirs = extra_unix_tool_dirs_with(
            home,
            Some(PathBuf::from("/custom/pnpm")),
            Some(PathBuf::from("/custom/fnm")),
        );
        assert!(dirs.iter().any(|d| d == Path::new("/custom/pnpm")));
        assert!(dirs.iter().any(|d| d == Path::new("/custom/fnm")));
        assert!(dirs
            .iter()
            .any(|d| d.starts_with("/custom/fnm") && d.ends_with("bin")));
    }

    #[test]
    fn split_path_dirs_takes_last_pathlike_line_and_dedupes() {
        // login shell 的招呼语/会话恢复提示要被跳过，取最后的 PATH 行
        let raw = "Restored session: Wed Aug 6\nWelcome!\n/opt/homebrew/bin:/usr/bin:/opt/homebrew/bin:/usr/local/bin\n";
        let dirs = split_path_dirs(raw);
        assert_eq!(
            dirs,
            vec![
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/bin"),
                PathBuf::from("/usr/local/bin"),
            ]
        );
        assert!(split_path_dirs("").is_empty());
        assert!(split_path_dirs("banner only\n").is_empty());
    }

    #[test]
    fn login_shell_prefers_env_then_platform_default() {
        assert_eq!(
            login_shell_from(Some("/usr/local/bin/fish")),
            "/usr/local/bin/fish"
        );
        let fallback = login_shell_from(None);
        let fallback_empty = login_shell_from(Some(""));
        let fallback_blank = login_shell_from(Some("   "));
        #[cfg(target_os = "macos")]
        {
            assert_eq!(fallback, "/bin/zsh");
        }
        #[cfg(not(target_os = "macos"))]
        {
            assert_eq!(fallback, "/bin/sh");
        }
        assert_eq!(fallback_empty, fallback);
        assert_eq!(fallback_blank, fallback);
    }

    #[cfg(windows)]
    #[test]
    fn windows_user_cli_dirs_include_grok_default_and_override() {
        let home = Path::new(r"C:\Users\tester");
        let dirs = windows_user_cli_dirs(home, Some(std::ffi::OsStr::new(r"D:\Tools\grok")));

        assert!(dirs.contains(&home.join(".grok").join("bin")));
        assert!(dirs.contains(&PathBuf::from(r"D:\Tools\grok\bin")));
        assert!(dirs.contains(&home.join("AppData").join("Roaming").join("npm")));
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

    #[test]
    fn guarded_hook_command_is_silent_when_binary_is_missing() {
        let posix = build_guarded_hook_command(
            Path::new("/opt/CC Panes/it's-hook"),
            "session-end",
            HookCommandShell::Posix,
        );
        assert_eq!(
            posix,
            "if [ -x '/opt/CC Panes/it'\\''s-hook' ]; then '/opt/CC Panes/it'\\''s-hook' session-end; fi"
        );

        let windows = build_guarded_hook_command(
            Path::new(r"C:\Program Files\CC-Panes\cc-panes-cli-hook.exe"),
            "session-end",
            HookCommandShell::Windows,
        );
        assert_eq!(
            windows,
            r#"if exist "C:\Program Files\CC-Panes\cc-panes-cli-hook.exe" "C:\Program Files\CC-Panes\cc-panes-cli-hook.exe" session-end"#
        );
        assert!(is_guarded_hook_command(&windows));
        assert!(!is_guarded_hook_command(
            r#"cmd.exe /D /C if exist "C:\Program Files\CC-Panes\cc-panes-cli-hook.exe" "C:\Program Files\CC-Panes\cc-panes-cli-hook.exe" session-end"#
        ));
    }

    #[cfg(windows)]
    #[test]
    fn windows_hook_command_passes_json_stdin_without_nested_shell() {
        use std::io::Write;
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};

        let probe = std::env::var_os("WINDIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
            .join("System32")
            .join("findstr.exe");
        assert!(
            probe.is_file(),
            "test probe is missing: {}",
            probe.display()
        );

        let command = build_guarded_hook_command(&probe, "session_id", HookCommandShell::Windows);
        assert!(
            !command.starts_with("cmd.exe "),
            "hook must not add a nested shell"
        );

        let mut child = Command::new("cmd.exe")
            .args(["/D", "/S", "/C"])
            .raw_arg(&command)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"{\"session_id\":\"stdin-check\"}\r\n")
            .unwrap();

        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "hook command failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            r#"{"session_id":"stdin-check"}"#,
            "command={command:?} stderr={}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

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
            skill_mount_paths: Vec::new(),
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

    /// `find_executable_in_dirs` 早就会避开裸 sh 脚本，但 `resolve_executable`
    /// 先调 `which`，命中裸文件就直接返回，那段修复永远执行不到 ——
    /// 实测导致 claude 被解析成 `...\nodejs\claude`（sh shim），
    /// spawn 报 `os error 193`。这个守卫就是让 which 的结果必须先过扩展名这关。
    #[test]
    fn which_result_without_executable_extension_is_rejected_on_windows() {
        let dir = fresh_dir("which_guard");
        let bare = dir.join("claude");
        let cmd = dir.join("claude.cmd");
        std::fs::write(&bare, b"#!/bin/sh\n").unwrap();
        std::fs::write(&cmd, b"@ECHO off\r\n").unwrap();

        #[cfg(windows)]
        {
            assert!(
                !is_directly_executable(&bare),
                "裸 sh shim 不可直接 spawn，必须被拒"
            );
            assert!(is_directly_executable(&cmd), ".cmd 应被接受");
            assert!(is_directly_executable(&dir.join("claude.exe")));
            // 被拒之后应落到扩展名感知的查找，选中 .cmd
            let fallback = find_executable_in_dirs(
                "claude",
                std::slice::from_ref(&dir),
                &[".exe".to_string(), ".cmd".to_string()],
            )
            .expect("should fall back to the .cmd shim");
            assert_eq!(fallback, cmd);
        }

        #[cfg(not(windows))]
        {
            // 非 Windows 上可执行位由 OS 判断，不做扩展名限制
            assert!(is_directly_executable(&bare));
        }
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

    #[cfg(windows)]
    #[test]
    fn resolve_launch_rewrites_explicit_batch_override() {
        let dir = fresh_dir("override_rewrite");
        let shim = dir.join("opencode.cmd");
        std::fs::write(&shim, NPM_SHIM_CMD).unwrap();
        let node = dir.join("node.exe");
        std::fs::write(&node, b"").unwrap();
        let entry = dir
            .join("node_modules")
            .join("opencode-ai")
            .join("bin")
            .join("opencode");
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::write(&entry, b"").unwrap();

        let ctx = test_context(Some(&shim.to_string_lossy()));
        let (command, args) = ctx
            .resolve_launch("unused", vec!["--version".to_string()])
            .unwrap();
        assert_eq!(command, node.to_string_lossy());
        assert_eq!(
            args,
            vec![
                entry.to_string_lossy().into_owned(),
                "--version".to_string()
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

#[cfg(test)]
mod unattended_tests {
    use super::*;

    fn valid_claude_permission_request() -> serde_json::Value {
        serde_json::json!({
            "hook_event_name": "PermissionRequest",
            "session_id": "claude-session",
            "tool_use_id": "toolu_01H",
            "tool_name": "Bash",
            "tool_input": { "command": "cargo test" },
            "permission_suggestions": []
        })
    }

    #[test]
    fn unattended_claude_capability_accepts_only_structured_permission_requests() {
        let adapter = ClaudeAdapter::new();

        assert_eq!(
            adapter.permission_request_capability(),
            Some(PermissionRequestCapability::ClaudeSynchronousHook)
        );
        let request = adapter
            .validate_permission_request(&valid_claude_permission_request())
            .expect("valid PermissionRequest");
        assert_eq!(request.tool_use_id, "toolu_01H");
        assert_eq!(request.tool_name, "Bash");
        assert_eq!(
            request.tool_input,
            serde_json::json!({ "command": "cargo test" })
        );
    }

    #[test]
    fn unattended_claude_rejects_missing_id_notification_and_elicitation() {
        let adapter = ClaudeAdapter::new();

        let mut missing_id = valid_claude_permission_request();
        missing_id.as_object_mut().unwrap().remove("tool_use_id");
        assert_eq!(
            adapter.validate_permission_request(&missing_id),
            Err(PermissionRequestValidationError::MissingToolUseId)
        );

        for event in ["Notification", "Elicitation"] {
            let mut payload = valid_claude_permission_request();
            payload["hook_event_name"] = serde_json::json!(event);
            assert_eq!(
                adapter.validate_permission_request(&payload),
                Err(PermissionRequestValidationError::UnsupportedEvent)
            );
        }

        let mut missing_name = valid_claude_permission_request();
        missing_name.as_object_mut().unwrap().remove("tool_name");
        assert_eq!(
            adapter.validate_permission_request(&missing_name),
            Err(PermissionRequestValidationError::MissingToolName)
        );

        let mut invalid_input = valid_claude_permission_request();
        invalid_input["tool_input"] = serde_json::Value::Null;
        assert_eq!(
            adapter.validate_permission_request(&invalid_input),
            Err(PermissionRequestValidationError::InvalidToolInput)
        );
    }

    #[test]
    fn unattended_non_claude_adapters_fail_closed() {
        let payload = valid_claude_permission_request();
        let adapters: Vec<Box<dyn CliToolAdapter>> = vec![
            Box::new(CodexAdapter::new()),
            Box::new(GrokAdapter::new()),
            Box::new(OpenCodeAdapter::new()),
        ];

        for adapter in adapters {
            assert_eq!(adapter.permission_request_capability(), None);
            assert_eq!(
                adapter.validate_permission_request(&payload),
                Err(PermissionRequestValidationError::UnsupportedCli)
            );
        }
    }
}
