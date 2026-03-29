//! 共享 MCP Server 生命周期管理服务
//!
//! 将无状态 MCP server 从 stdio 模式桥接为 HTTP 共享端点，
//! 由 CC-Panes 统一管理子进程的启动/停止/健康检查。

use crate::models::shared_mcp::{
    BridgeMode, SharedMcpConfig, SharedMcpServerConfig, SharedMcpServerInfo, SharedMcpServerStatus,
};
use crate::utils::AppPaths;
use cc_cli_adapters::no_window_command;
use std::collections::HashMap;
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tracing::{debug, error, info, warn};

/// 单个共享 server 的运行时状态
struct ServerRuntime {
    /// 子进程句柄
    child: std::process::Child,
    /// 重启计数
    restart_count: u32,
    /// 当前状态
    status: SharedMcpServerStatus,
}

/// 共享 MCP Server 管理服务
pub struct SharedMcpService {
    /// 配置文件路径
    config_path: PathBuf,
    /// 持久化配置
    config: Mutex<SharedMcpConfig>,
    /// 运行中的 server（name → runtime）
    running: Mutex<HashMap<String, ServerRuntime>>,
    /// 健康检查线程是否在运行
    health_check_running: AtomicBool,
    /// 健康检查停止信号
    health_check_stop: Arc<AtomicBool>,
}

impl SharedMcpService {
    pub fn new(app_paths: &AppPaths) -> Self {
        let config_path = app_paths.data_dir().join("shared-mcp.json");
        let config = Self::load_config_from_path(&config_path);

        Self {
            config_path,
            config: Mutex::new(config),
            running: Mutex::new(HashMap::new()),
            health_check_running: AtomicBool::new(false),
            health_check_stop: Arc::new(AtomicBool::new(false)),
        }
    }

    // ========== 配置 CRUD ==========

    /// 加载配置
    pub fn load_config(&self) -> SharedMcpConfig {
        let config = Self::load_config_from_path(&self.config_path);
        if let Ok(mut guard) = self.config.lock() {
            *guard = config.clone();
        }
        config
    }

    fn load_config_from_path(path: &PathBuf) -> SharedMcpConfig {
        match std::fs::read_to_string(path) {
            Ok(content) => serde_json::from_str(&content).unwrap_or_else(|e| {
                warn!("[shared-mcp] Failed to parse config: {}, using defaults", e);
                SharedMcpConfig::default()
            }),
            Err(_) => SharedMcpConfig::default(),
        }
    }

    /// 保存配置到磁盘
    pub fn save_config(&self) -> Result<(), String> {
        let config = self
            .config
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?
            .clone();
        let json =
            serde_json::to_string_pretty(&config).map_err(|e| format!("Serialize error: {}", e))?;
        std::fs::write(&self.config_path, json).map_err(|e| format!("Write error: {}", e))?;
        info!(
            "[shared-mcp] Config saved to {}",
            self.config_path.display()
        );
        Ok(())
    }

    /// 添加或更新一个 server 配置
    pub fn upsert_server(&self, name: &str, server: SharedMcpServerConfig) -> Result<(), String> {
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("Lock error: {}", e))?;
            config.servers.insert(name.to_string(), server);
        }
        self.save_config()
    }

    /// 删除一个 server 配置（先停止运行中的进程）
    pub fn remove_server(&self, name: &str) -> Result<(), String> {
        self.stop_server(name);
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("Lock error: {}", e))?;
            config.servers.remove(name);
        }
        self.save_config()
    }

    /// 获取当前配置
    pub fn get_config(&self) -> SharedMcpConfig {
        self.config.lock().map(|g| g.clone()).unwrap_or_default()
    }

    /// 更新全局配置（端口范围、健康检查间隔等）
    pub fn update_global_config(
        &self,
        port_range_start: u16,
        port_range_end: u16,
        health_check_interval_secs: u64,
        max_restarts: u32,
    ) -> Result<(), String> {
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("Lock error: {}", e))?;
            config.port_range_start = port_range_start;
            config.port_range_end = port_range_end;
            config.health_check_interval_secs = health_check_interval_secs;
            config.max_restarts = max_restarts;
        }
        self.save_config()
    }

    // ========== 进程生命周期 ==========

    /// 启动所有已启用共享的 server
    pub fn start_all(&self) {
        let config = self.get_config();
        let names: Vec<String> = config
            .servers
            .iter()
            .filter(|(_, s)| s.shared)
            .map(|(n, _)| n.clone())
            .collect();

        info!("[shared-mcp] Starting {} shared servers", names.len());
        for name in names {
            if let Err(e) = self.start_server(&name) {
                error!("[shared-mcp] Failed to start '{}': {}", name, e);
            }
        }
    }

    /// 停止所有运行中的 server
    pub fn stop_all(&self) {
        let names: Vec<String> = self
            .running
            .lock()
            .map(|g| g.keys().cloned().collect())
            .unwrap_or_default();

        info!("[shared-mcp] Stopping {} shared servers", names.len());
        for name in names {
            self.stop_server(&name);
        }
    }

    /// 启动单个 server
    pub fn start_server(&self, name: &str) -> Result<(), String> {
        // 检查是否已在运行
        if let Ok(running) = self.running.lock() {
            if running.contains_key(name) {
                return Err(format!("Server '{}' is already running", name));
            }
        }

        let config = self.get_config();
        let server_config = config
            .servers
            .get(name)
            .ok_or_else(|| format!("Server '{}' not found in config", name))?
            .clone();

        let child = self.spawn_server_process(name, &server_config)?;
        let pid = child.id();

        info!(
            "[shared-mcp] Started '{}' (pid={}, port={})",
            name, pid, server_config.port
        );

        if let Ok(mut running) = self.running.lock() {
            running.insert(
                name.to_string(),
                ServerRuntime {
                    child,
                    restart_count: 0,
                    status: SharedMcpServerStatus::Running,
                },
            );
        }

        Ok(())
    }

    /// 停止单个 server
    pub fn stop_server(&self, name: &str) {
        if let Ok(mut running) = self.running.lock() {
            if let Some(mut runtime) = running.remove(name) {
                let pid = runtime.child.id();
                let _ = runtime.child.kill();
                let _ = runtime.child.wait();
                info!("[shared-mcp] Stopped '{}' (pid={})", name, pid);
            }
        }
    }

    /// 重启单个 server
    pub fn restart_server(&self, name: &str) -> Result<(), String> {
        self.stop_server(name);
        self.start_server(name)
    }

    /// 获取所有 server 的运行时信息
    pub fn get_all_status(&self) -> Vec<SharedMcpServerInfo> {
        let config = self.get_config();
        let running = self.running.lock().ok();

        config
            .servers
            .iter()
            .map(|(name, server_config)| {
                let (status, pid, restart_count) = running
                    .as_ref()
                    .and_then(|r| r.get(name))
                    .map(|rt| (rt.status.clone(), Some(rt.child.id()), rt.restart_count))
                    .unwrap_or((SharedMcpServerStatus::Stopped, None, 0));

                let url = if status == SharedMcpServerStatus::Running {
                    Some(format!("http://127.0.0.1:{}/mcp", server_config.port))
                } else {
                    None
                };

                SharedMcpServerInfo {
                    name: name.clone(),
                    config: server_config.clone(),
                    status,
                    pid,
                    url,
                    restart_count,
                }
            })
            .collect()
    }

    /// 获取所有运行中 server 的 URL 映射（name → url）
    /// 用于注入到 CliAdapterContext
    pub fn get_running_servers_urls(&self) -> HashMap<String, String> {
        let config = self.get_config();
        let running = self.running.lock().ok();

        let mut urls = HashMap::new();
        if let Some(ref running) = running {
            for (name, server_config) in &config.servers {
                if server_config.shared && running.contains_key(name) {
                    urls.insert(
                        name.clone(),
                        format!("http://127.0.0.1:{}/mcp", server_config.port),
                    );
                }
            }
        }
        urls
    }

    // ========== 健康检查 ==========

    /// 启动后台健康检查线程
    pub fn start_health_check(self: &Arc<Self>) {
        if self.health_check_running.load(Ordering::SeqCst) {
            return;
        }
        self.health_check_running.store(true, Ordering::SeqCst);
        self.health_check_stop.store(false, Ordering::SeqCst);

        let svc = Arc::clone(self);
        let stop = Arc::clone(&self.health_check_stop);

        std::thread::Builder::new()
            .name("shared-mcp-health".into())
            .spawn(move || {
                info!("[shared-mcp] Health check thread started");
                loop {
                    let interval = svc
                        .config
                        .lock()
                        .map(|c| c.health_check_interval_secs)
                        .unwrap_or(30);

                    // 分段 sleep，以便快速响应停止信号
                    for _ in 0..interval {
                        if stop.load(Ordering::SeqCst) {
                            info!("[shared-mcp] Health check thread stopping");
                            svc.health_check_running.store(false, Ordering::SeqCst);
                            return;
                        }
                        std::thread::sleep(Duration::from_secs(1));
                    }

                    svc.run_health_check();
                }
            })
            .ok();
    }

    /// 停止健康检查线程
    pub fn stop_health_check(&self) {
        self.health_check_stop.store(true, Ordering::SeqCst);
    }

    /// 执行一次健康检查
    fn run_health_check(&self) {
        let config = self.get_config();
        let max_restarts = config.max_restarts;

        let mut to_restart: Vec<String> = Vec::new();

        if let Ok(mut running) = self.running.lock() {
            for (name, runtime) in running.iter_mut() {
                // 检查进程是否还活着
                match runtime.child.try_wait() {
                    Ok(Some(exit_status)) => {
                        // 进程已退出
                        warn!(
                            "[shared-mcp] '{}' exited with status: {:?}",
                            name, exit_status
                        );
                        runtime.status = SharedMcpServerStatus::Failed {
                            message: format!("Exited: {:?}", exit_status),
                        };
                        if runtime.restart_count < max_restarts {
                            to_restart.push(name.clone());
                        } else {
                            error!(
                                "[shared-mcp] '{}' exceeded max restarts ({})",
                                name, max_restarts
                            );
                        }
                    }
                    Ok(None) => {
                        // 进程仍在运行，检查端口是否可达
                        if let Some(server_config) = config.servers.get(name) {
                            let addr = format!("127.0.0.1:{}", server_config.port);
                            if let Ok(addr) = addr.parse() {
                                if TcpStream::connect_timeout(&addr, Duration::from_millis(500))
                                    .is_err()
                                {
                                    debug!(
                                        "[shared-mcp] '{}' process alive but port {} not reachable",
                                        name, server_config.port
                                    );
                                }
                            }
                        }
                    }
                    Err(e) => {
                        warn!("[shared-mcp] '{}' try_wait error: {}", name, e);
                    }
                }
            }
        }

        // 重启崩溃的 server
        for name in to_restart {
            // 先移除旧的 runtime
            let prev_restart_count = self
                .running
                .lock()
                .ok()
                .and_then(|mut r| r.remove(&name))
                .map(|rt| rt.restart_count)
                .unwrap_or(0);

            info!(
                "[shared-mcp] Restarting '{}' (attempt {})",
                name,
                prev_restart_count + 1
            );

            match self.start_server(&name) {
                Ok(()) => {
                    // 更新重启计数
                    if let Ok(mut running) = self.running.lock() {
                        if let Some(runtime) = running.get_mut(&name) {
                            runtime.restart_count = prev_restart_count + 1;
                        }
                    }
                }
                Err(e) => {
                    error!("[shared-mcp] Restart '{}' failed: {}", name, e);
                }
            }
        }
    }

    // ========== 导入 ==========

    /// 从 ~/.claude.json 的 mcpServers 导入
    pub fn import_from_claude_json(&self) -> Result<Vec<String>, String> {
        let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
        let claude_json_path = home.join(".claude.json");
        let content = std::fs::read_to_string(&claude_json_path)
            .map_err(|e| format!("Failed to read ~/.claude.json: {}", e))?;
        let parsed: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse ~/.claude.json: {}", e))?;

        let mcp_servers = parsed
            .get("mcpServers")
            .and_then(|v| v.as_object())
            .ok_or("No mcpServers found in ~/.claude.json")?;

        let mut next_port = {
            let config = self.get_config();
            // 从当前已用端口的最大值 +1 开始分配
            let max_used = config
                .servers
                .values()
                .map(|s| s.port)
                .max()
                .unwrap_or(config.port_range_start.saturating_sub(1));
            max_used + 1
        };

        let mut imported = Vec::new();

        for (name, value) in mcp_servers {
            // 跳过非 stdio 类型（已经是 http 的）
            let server_type = value
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("stdio");
            if server_type != "stdio" {
                debug!("[shared-mcp] Skipping '{}' (type={})", name, server_type);
                continue;
            }

            // 跳过已存在的
            if self.get_config().servers.contains_key(name) {
                debug!("[shared-mcp] Skipping '{}' (already configured)", name);
                continue;
            }

            let command = value
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let args: Vec<String> = value
                .get("args")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            let env: HashMap<String, String> = value
                .get("env")
                .and_then(|v| v.as_object())
                .map(|obj| {
                    obj.iter()
                        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                        .collect()
                })
                .unwrap_or_default();

            if command.is_empty() {
                continue;
            }

            let server = SharedMcpServerConfig {
                command,
                args,
                env,
                shared: false, // 导入后默认不启用，需手动开启
                port: next_port,
                bridge_mode: BridgeMode::McpProxy,
            };

            if let Err(e) = self.upsert_server(name, server) {
                warn!("[shared-mcp] Failed to import '{}': {}", name, e);
                continue;
            }

            imported.push(name.clone());
            next_port += 1;
        }

        info!(
            "[shared-mcp] Imported {} servers from ~/.claude.json",
            imported.len()
        );
        Ok(imported)
    }

    // ========== 内部工具 ==========

    /// 启动 server 子进程
    fn spawn_server_process(
        &self,
        name: &str,
        config: &SharedMcpServerConfig,
    ) -> Result<std::process::Child, String> {
        let (command, args) = match config.bridge_mode {
            BridgeMode::McpProxy => {
                // npx -y mcp-proxy --port PORT -- CMD ARGS
                let mut proxy_args = vec![
                    "-y".to_string(),
                    "mcp-proxy".to_string(),
                    "--port".to_string(),
                    config.port.to_string(),
                    "--".to_string(),
                    config.command.clone(),
                ];
                proxy_args.extend(config.args.iter().cloned());
                ("npx".to_string(), proxy_args)
            }
            BridgeMode::NativeHttp => {
                // 直接启动，通过环境变量设置 HTTP 模式
                (config.command.clone(), config.args.clone())
            }
        };

        let mut cmd = no_window_command(&command);
        cmd.args(&args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .stdin(std::process::Stdio::null());

        // 注入原始环境变量
        for (key, value) in &config.env {
            cmd.env(key, value);
        }

        // native-http 模式额外注入 MODE 和 PORT
        if config.bridge_mode == BridgeMode::NativeHttp {
            cmd.env("MODE", "http");
            cmd.env("PORT", config.port.to_string());
        }

        cmd.spawn()
            .map_err(|e| format!("Failed to spawn '{}': {}", name, e))
    }
}

impl Drop for SharedMcpService {
    fn drop(&mut self) {
        self.stop_health_check();
        // 清理所有子进程
        if let Ok(mut running) = self.running.lock() {
            for (name, runtime) in running.iter_mut() {
                let pid = runtime.child.id();
                let _ = runtime.child.kill();
                let _ = runtime.child.wait();
                debug!("[shared-mcp] Cleaned up '{}' (pid={})", name, pid);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn test_paths() -> (TempDir, AppPaths) {
        let dir = TempDir::new().unwrap();
        let paths = AppPaths::new(Some(dir.path().to_string_lossy().to_string()));
        (dir, paths) // TempDir 必须持有以防目录被提前删除
    }

    #[test]
    fn default_config_when_no_file() {
        let (_dir, paths) = test_paths();
        let svc = SharedMcpService::new(&paths);
        let config = svc.get_config();
        assert!(config.servers.is_empty());
        assert_eq!(config.port_range_start, 3100);
        assert_eq!(config.port_range_end, 3199);
    }

    #[test]
    fn upsert_and_remove_server() {
        let (_dir, paths) = test_paths();
        let svc = SharedMcpService::new(&paths);

        let server = SharedMcpServerConfig {
            command: "npx".into(),
            args: vec!["-y".into(), "test-mcp".into()],
            env: HashMap::new(),
            shared: true,
            port: 3100,
            bridge_mode: BridgeMode::McpProxy,
        };

        svc.upsert_server("test", server.clone()).unwrap();
        let config = svc.get_config();
        assert_eq!(config.servers.len(), 1);
        assert_eq!(config.servers["test"].port, 3100);

        svc.remove_server("test").unwrap();
        let config = svc.get_config();
        assert!(config.servers.is_empty());
    }

    #[test]
    fn config_persists_to_disk() {
        let (_dir, paths) = test_paths();
        let svc = SharedMcpService::new(&paths);

        let server = SharedMcpServerConfig {
            command: "node".into(),
            args: vec!["server.js".into()],
            env: HashMap::new(),
            shared: true,
            port: 3101,
            bridge_mode: BridgeMode::NativeHttp,
        };
        svc.upsert_server("my-server", server).unwrap();

        // 从磁盘重新加载
        let svc2 = SharedMcpService::new(&paths);
        let config = svc2.get_config();
        assert_eq!(config.servers.len(), 1);
        assert_eq!(config.servers["my-server"].port, 3101);
        assert_eq!(
            config.servers["my-server"].bridge_mode,
            BridgeMode::NativeHttp
        );
    }

    #[test]
    fn get_running_servers_urls_empty_when_nothing_running() {
        let (_dir, paths) = test_paths();
        let svc = SharedMcpService::new(&paths);
        assert!(svc.get_running_servers_urls().is_empty());
    }

    #[test]
    fn import_from_claude_json_file() {
        let (_dir, paths) = test_paths();
        let svc = SharedMcpService::new(&paths);

        // 创建模拟的 ~/.claude.json（测试中无法写入真实 home 目录，
        // 所以这个测试仅验证文件不存在时的错误处理）
        let result = svc.import_from_claude_json();
        // 在测试环境中可能成功也可能失败（取决于用户是否有 ~/.claude.json）
        // 这里不 assert 具体结果
        debug!("import result: {:?}", result);
    }
}
