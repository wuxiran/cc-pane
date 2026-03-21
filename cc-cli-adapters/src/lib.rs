//! CLI Tool Adapter Layer for CC-Panes
//!
//! 提供 Trait + Registry 架构，让新增 CLI 工具只需实现 `CliToolAdapter` trait 并注册即可。
//!
//! ```text
//! 新增一个 CLI 工具 = 新建一个文件实现 trait + 注册一行代码
//! ```

mod claude;
mod codex;

pub use claude::ClaudeAdapter;
pub use codex::CodexAdapter;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

/// 带超时执行子进程，返回 stdout（超时或失败返回 None）
///
/// 使用轮询方案，能正确 kill 超时进程，避免僵尸进程。
/// 同时关闭 stdin（`Stdio::null()`），防止子进程因等待输入而卡住。
pub fn run_with_timeout(
    cmd: &std::path::Path,
    args: &[String],
    timeout: Duration,
) -> Option<String> {
    let mut child = std::process::Command::new(cmd)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null())
        .spawn()
        .ok()?;

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

    /// 环境检测（默认实现: which + --version，带 5s 超时）
    fn detect(&self) -> CliToolInfo {
        let mut info = self.info().clone();
        match which::which(&info.executable) {
            Ok(path) => {
                info.installed = true;
                info.path = Some(path.to_string_lossy().into_owned());
                info.version = run_with_timeout(&path, &info.version_args, Duration::from_secs(5));
            }
            Err(_) => {
                info.installed = false;
            }
        }
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
    /// 兼容的 Provider 类型列表
    #[serde(default)]
    pub compatible_provider_types: Vec<String>,
}

/// 构建命令的上下文（扁平字段，避免依赖主 crate 类型）
pub struct CliAdapterContext {
    pub session_id: String,
    pub project_path: String,
    pub workspace_path: Option<String>,
    pub resume_id: Option<String>,
    pub skip_mcp: bool,
    pub append_system_prompt: Option<String>,
    /// Orchestrator HTTP 端口
    pub orchestrator_port: Option<u16>,
    /// Orchestrator Bearer Token
    pub orchestrator_token: Option<String>,
    /// 数据目录（用于写入 MCP 配置文件等）
    pub data_dir: PathBuf,
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
